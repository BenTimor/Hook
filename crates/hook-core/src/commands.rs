use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::auth::{AuthView, LoginOutcome, RefreshOutcome};
use crate::config;
use crate::events::EmitExt;
use crate::preview::PreviewView;
use crate::projects::Project;
use crate::state::{lock, AppState};
use crate::store::{now_ms, Chat, ChatMeta, IncomingImage, Message, SearchHit};
use crate::turn;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    /// "chat", "workspace" or "mobile" — which product this backend is serving.
    pub product: &'static str,
}

/// A pass-through to the workspace API for the Workspace window.
///
/// The renderer never holds a token, so every workspace call from the app is
/// this one command. It can only reach `/api/ws`, and the server still decides
/// what the signed-in account may do; the path check here is about keeping the
/// IPC surface small, not about authorization.
#[tauri::command]
pub async fn ws_request(
    state: State<'_, Arc<AppState>>,
    method: String,
    path: String,
    body: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let allowed = path.starts_with('/')
        && !path.contains("..")
        && path.len() <= 512
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/_-:?=&.%".contains(c));
    if !allowed {
        return Err("Invalid workspace path.".into());
    }
    let method = match method.to_ascii_uppercase().as_str() {
        "GET" => reqwest::Method::GET,
        "POST" => reqwest::Method::POST,
        "PATCH" => reqwest::Method::PATCH,
        "DELETE" => reqwest::Method::DELETE,
        other => return Err(format!("Unsupported method: {other}")),
    };
    let (status, body) = state.workspace.raw(method, &path, body).await?;
    Ok(serde_json::json!({ "status": status, "body": body }))
}

/// The product's window says what the user is looking at (project, board,
/// open document, selected text). The next chat request carries it as context.
#[tauri::command]
pub fn set_chat_context(state: State<'_, Arc<AppState>>, context: String) {
    state.set_chat_context(&context);
}

#[tauri::command]
pub fn sync_status(state: State<'_, Arc<AppState>>) -> crate::sync::SyncView {
    state.sync.status()
}

/// The account's machines, as last reported by the relay. The list is empty
/// until the first connection; `state` says whether that connection is
/// connecting, online, refused (free plan or sync off) or offline.
#[tauri::command]
pub fn devices_list(state: State<'_, Arc<AppState>>) -> crate::relay::RelayView {
    state.relay.view()
}

/// Watch the live stream of one conversation. The relay remembers the
/// subscription across a reconnect; a chat that is not open on this device is
/// not subscribed, so its frames are simply not sent here.
#[tauri::command]
pub fn subscribe_chat(state: State<'_, Arc<AppState>>, chat_id: String) {
    state.relay.subscribe(&chat_id);
}

#[tauri::command]
pub fn unsubscribe_chat(state: State<'_, Arc<AppState>>, chat_id: String) {
    state.relay.unsubscribe(&chat_id);
}

#[tauri::command]
pub async fn device_rename(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    name: String,
) -> Result<crate::devices::DeviceView, String> {
    let auth = state.auth.clone();
    crate::devices::rename(&auth, &device_id, &name).await
}

#[tauri::command]
pub async fn device_set_remote(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    allowed: bool,
) -> Result<crate::devices::DeviceView, String> {
    let auth = state.auth.clone();
    crate::devices::set_remote(&auth, &device_id, allowed).await
}

#[tauri::command]
pub async fn device_remove(
    state: State<'_, Arc<AppState>>,
    device_id: String,
) -> Result<(), String> {
    let auth = state.auth.clone();
    crate::devices::remove(&auth, &device_id).await
}

/// Stop one run on another machine. The chat itself may have agents on several
/// computers; the Stop button asks each of them, because no single process owns
/// them all.
#[tauri::command]
pub async fn stop_remote_agent(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    agent_id: String,
) -> Result<(), String> {
    state
        .relay
        .rpc(
            &device_id,
            "agent.stop",
            serde_json::json!({ "agentId": agent_id }),
            std::time::Duration::from_secs(20),
        )
        .await
        .map(|_| ())
        .map_err(|error| error.message)
}

// ── memory ──────────────────────────────────────────────────────────

/// Everything the Settings window shows, plus the live switches. `enabled` is
/// the build flag and the user's own toggle together, because the UI only cares
/// whether memory is working.
fn memory_view(state: &AppState) -> serde_json::Value {
    let mut view = state.memory.view();
    view["enabled"] = serde_json::json!(state.cfg.memory.enabled && state.settings.memory_enabled());
    view["available"] = serde_json::json!(state.cfg.memory.enabled);
    view
}

#[tauri::command]
pub fn memory_list(state: State<'_, Arc<AppState>>) -> serde_json::Value {
    memory_view(&state)
}

/// A memory the user typed themselves. The agent's own writes go through the
/// turn's `remember` tool; this is the Settings window doing the same thing.
#[tauri::command]
pub fn memory_save(
    state: State<'_, Arc<AppState>>,
    text: String,
    kind: Option<String>,
    pinned: Option<bool>,
) -> Result<serde_json::Value, String> {
    state
        .memory
        .add(&text, kind.as_deref(), pinned, None)?;
    state.sync.wake();
    Ok(memory_view(&state))
}

#[tauri::command]
pub fn memory_update(
    state: State<'_, Arc<AppState>>,
    id: String,
    text: Option<String>,
    pinned: Option<bool>,
) -> Result<serde_json::Value, String> {
    state.memory.update(&id, text.as_deref(), pinned)?;
    state.sync.wake();
    Ok(memory_view(&state))
}

#[tauri::command]
pub fn memory_delete(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<serde_json::Value, String> {
    state.memory.delete(&id)?;
    state.sync.wake();
    Ok(memory_view(&state))
}

#[tauri::command]
pub fn memory_clear(state: State<'_, Arc<AppState>>) -> Result<serde_json::Value, String> {
    state.memory.clear()?;
    state.sync.wake();
    Ok(memory_view(&state))
}

/// The user's switch. It is stored here, not in the compiled-in config: turning
/// memory off must not need a rebuild.
#[tauri::command]
pub fn memory_set_enabled(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<serde_json::Value, String> {
    state.settings.set_memory_enabled(enabled)?;
    Ok(memory_view(&state))
}

/// Run a sync cycle now instead of waiting for the next tick.
#[tauri::command]
pub fn sync_now(state: State<'_, Arc<AppState>>) {
    state.sync.wake();
}

/// Read a ChatGPT or Claude export and report what importing it would do.
/// Nothing is written: the UI shows the counts and asks first.
#[tauri::command]
pub async fn import_scan(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<crate::import::ImportPreview, String> {
    let store = state.store.clone();
    let imports = state.imports.clone();
    // Parsing a few hundred megabytes of JSON must not block the window.
    crate::rt::spawn_blocking(move || {
        imports.scan(&store, std::path::Path::new(&path))
    })
    .await
    .map_err(|e| format!("The export could not be read: {e}"))?
}

/// Write the conversations a scan counted. Progress arrives on `hook://import`.
#[tauri::command]
pub async fn import_apply(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<crate::import::ImportSummary, String> {
    let store = state.store.clone();
    let imports = state.imports.clone();
    let events = state.events.clone();
    let outcome = crate::rt::spawn_blocking(move || {
        let emit = |progress: crate::import::ImportProgress| {
            events.emit("hook://import", progress);
        };
        imports.apply(&store, std::path::Path::new(&path), &emit)
    })
    .await
    .map_err(|e| format!("The import did not finish: {e}"))?;

    // Imported chats are marked for upload by the store; this saves them the
    // wait for the next cycle.
    state.sync.wake();
    outcome
}

#[tauri::command]
pub fn app_info(state: State<'_, Arc<AppState>>) -> Result<AppInfo, String> {
    // Validate the embedded config up front so a broken build fails loudly here
    // instead of on the first message.
    config::get()?;
    Ok(AppInfo {
        version: crate::version::current(),
        product: state.product.slug(),
    })
}

/// Pick the native status bar's appearance for the screen that is showing.
///
/// The phone's sign-in hero is forest-green to the top edge, so its status bar
/// needs light content; every screen after sign-in is warm beige and keeps the
/// system's dark content. The UI is a webview and iOS has no web API for this,
/// so the call has to reach the window's root view controller. A no-op on every
/// other product: only the phone has a status bar to change.
#[allow(deprecated)]
#[tauri::command]
pub fn set_status_bar_style(app: AppHandle, style: String) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        let light = style == "light";
        app.run_on_main_thread(move || {
            use objc2::MainThreadMarker;
            use objc2_ui_kit::{UIApplication, UIUserInterfaceStyle};

            let Some(marker) = MainThreadMarker::new() else {
                return;
            };
            let Some(window) = UIApplication::sharedApplication(marker).keyWindow() else {
                return;
            };
            let style = if light {
                UIUserInterfaceStyle::Dark
            } else {
                UIUserInterfaceStyle::Light
            };
            // `default` follows the trait collection: a dark window asks for
            // light status-bar content without repainting the web page itself.
            // The window's trait, not only the controller's, is what the status
            // bar reads here.
            window.setOverrideUserInterfaceStyle(style);
            if let Some(root) = window.rootViewController() {
                root.setOverrideUserInterfaceStyle(style);
                root.setNeedsStatusBarAppearanceUpdate();
            }
        })
        .map_err(|error| format!("Could not update the status bar: {error}"))?;
        set_webview_scroll_edge(&app, light);
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = (app, style);
    }
    Ok(())
}

/// A tap from the Taptic Engine, for a long press with no menu yet.
///
/// iOS has no web haptics API, so the phone's drawer asks the window instead.
/// A no-op on every product that has no such engine; the phone is the only one
/// that calls it.
#[tauri::command]
pub fn haptic_feedback(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "ios")]
    {
        app.run_on_main_thread(|| {
            use objc2::MainThreadMarker;
            use objc2_ui_kit::UIImpactFeedbackGenerator;

            let Some(marker) = MainThreadMarker::new() else {
                return;
            };
            // `new` is the medium impact, which is what a context menu uses.
            UIImpactFeedbackGenerator::new(marker).impactOccurred();
        })
        .map_err(|error| format!("Could not play haptic feedback: {error}"))?;
    }
    #[cfg(not(target_os = "ios"))]
    {
        let _ = app;
    }
    Ok(())
}

/// Switch the WKWebView's own top edge effect. The status bar's trait alone
/// does not cover it; the webview has to be addressed directly.
#[cfg(target_os = "ios")]
fn set_webview_scroll_edge(app: &AppHandle, hidden: bool) {
    use objc2::runtime::{AnyObject, NSObjectProtocol};
    use objc2_ui_kit::UIScrollView;
    use tauri::Manager;

    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.with_webview(move |webview| {
        let webview = webview.inner() as *mut AnyObject;
        if webview.is_null() {
            return;
        }
        let webview = unsafe { &*webview };
        let scroll: *mut AnyObject = unsafe { objc2::msg_send![webview, scrollView] };
        if scroll.is_null() {
            return;
        }
        let scroll = unsafe { &*scroll };
        if let Some(scroll) = scroll.downcast_ref::<UIScrollView>() {
            if scroll.respondsToSelector(objc2::sel!(topEdgeEffect)) {
                scroll.topEdgeEffect().setHidden(hidden);
            }
        }
    });
}



/// Drop everything that belonged to the signed-in account: live coding
/// agents, in-flight chat streams and the preview server. Used when the token
/// is revoked server-side or the user signs out.

/// Ask the model card what it can see. Called at launch, after sign-in and on
/// window reload. A provider without `/models` simply reports nothing.

#[tauri::command]
pub fn auth_status(state: State<'_, Arc<AppState>>) -> AuthView {
    state.auth.view()
}

/// Start the browser half of device sign-in. Returns the pending view (with the
/// short code and URL) immediately; the poll loop reports the result over
/// `hook://auth`.
#[tauri::command]
pub async fn auth_login(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    let (generation, _device_code, _interval) = state.auth.begin().await?;
    let mut view = state.auth.view();
    if let Some(url) = view.verification_url.clone() {
        if let Err(error) = open_url_inner(&app, &url) {
            // Keep the code pending: the window shows it and offers the link
            // again, so a browser that refused to open is not a dead end.
            eprintln!("hook: could not open the sign-in page: {error}");
            view.message = Some(
                "Could not open your browser. Use the link shown here to continue.".into(),
            );
        }
    }
    crate::auth::emit(&state.events, &view);

    let poll_state = state.clone();
    crate::rt::spawn(async move {
        match poll_state.auth.wait_for_approval(generation).await {
            LoginOutcome::Approved => {
                // Show the app as soon as the token is stored; the model-card
                // probe can finish in the background.
                crate::auth::emit(&poll_state.events, &poll_state.auth.view());
                poll_state.sync.wake();
                poll_state.relay.wake();
                crate::provider::refresh_capabilities(&poll_state).await;
            }
            LoginOutcome::Cancelled => {
                crate::auth::emit(&poll_state.events, &poll_state.auth.view());
            }
            LoginOutcome::Failed(message) => {
                poll_state.auth.cancel();
                let mut view = poll_state.auth.view();
                view.message = Some(message);
                crate::auth::emit(&poll_state.events, &view);
            }
        }
    });

    Ok(view)
}

/// Starts the device flow for the browser's sign-in card.
///
/// The same flow as `auth_login`, with one difference: the browser is the thing
/// on screen, so nothing is opened here. The page shows the code and the caller
/// polls `auth/status`; the poll still runs in this process, because `auth.rs` is
/// what writes the shared account file, and the browser only reads it.

#[tauri::command]
pub fn auth_cancel_login(state: State<'_, Arc<AppState>>) -> AuthView {
    state.auth.cancel();
    let view = state.auth.view();
    crate::auth::emit(&state.events, &view);
    view
}

/// The Google client id a native sign-in must name, when this build has an
/// account service and that service has Google credentials.
#[tauri::command]
pub async fn auth_google_config(
    state: State<'_, Arc<AppState>>,
) -> Result<Option<String>, String> {
    state.auth.google_client_id().await
}

/// Sign in with the ID token the phone's own account sheet returned.
///
/// The desktop never calls this: it has no account picker, and its device flow
/// is the path a browser-only machine needs. A phone does, and the server checks
/// the token the same way it checks the browser's.
#[tauri::command]
pub async fn auth_google(
    state: State<'_, Arc<AppState>>,
    id_token: String,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    let view = state.auth.login_with_google(&id_token).await?;
    crate::auth::emit(&state.events, &view);
    // A finished sign-in is when the account's conversations start arriving.
    state.sync.wake();
    state.relay.wake();
    let ready = state.clone();
    crate::rt::spawn(async move {
        crate::provider::refresh_capabilities(&ready).await;
    });
    Ok(view)
}

/// Check the cached token against hookcode.io. A revoked or unapproved account
/// is signed out here, before its next message fails.
#[tauri::command]
pub async fn auth_refresh(
    state: State<'_, Arc<AppState>>,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    match state.auth.refresh().await {
        RefreshOutcome::Valid => {
            crate::provider::refresh_capabilities(&state).await;
            state.sync.wake();
            state.relay.wake();
            Ok(state.auth.view())
        }
        RefreshOutcome::Revoked(message) => {
            crate::state::revoke_local(&state);
            let mut view = state.auth.view();
            view.message = Some(message);
            crate::auth::emit(&state.events, &view);
            Ok(view)
        }
        RefreshOutcome::Unreachable(message) => {
            // A network blip must not log the user out; the cached session still
            // works when the service is reachable again.
            eprintln!("hook: could not verify the account: {message}");
            Ok(state.auth.view())
        }
    }
}

#[tauri::command]
pub async fn auth_logout(
    state: State<'_, Arc<AppState>>,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    state.auth.logout().await;
    crate::state::revoke_local(&state);
    let view = state.auth.view();
    crate::auth::emit(&state.events, &view);
    Ok(view)
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    open_url_inner(&app, &url)
}

fn open_url_inner(app: &AppHandle, url: &str) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let parsed = reqwest::Url::parse(url).map_err(|_| "That link is not valid.".to_string())?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return Err("Only web links can be opened.".into());
    }
    app.opener()
        .open_url(url.to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_chats(state: State<'_, Arc<AppState>>) -> Result<Vec<ChatMeta>, String> {
    state.store.list()
}

#[tauri::command]
pub fn get_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<Chat, String> {
    state.store.load(&chat_id)
}

#[tauri::command]
pub async fn rename_chat(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    title: String,
) -> Result<ChatMeta, String> {
    let chat = state.store.load(&chat_id)?;
    if chat.meta.remote {
        let device = chat
            .meta
            .device_id
            .clone()
            .ok_or("This conversation does not know which machine owns it.")?;
        let result = crate::session::remote_rpc(
            state.inner(),
            &device,
            "coding.rename",
            serde_json::json!({ "chatId": chat_id, "title": title }),
            Duration::from_secs(20),
        )
        .await?;
        let remote: ChatMeta = serde_json::from_value(result)
            .map_err(|error| format!("The machine sent an unreadable title: {error}"))?;
        let mut local = state.store.load(&chat_id)?;
        local.meta.title = remote.title;
        local.meta.updated_at = remote.updated_at;
        state.store.save_remote(&mut local)?;
        return Ok(local.meta);
    }
    let meta = state.store.rename(&chat_id, &title)?;
    state.sync.wake();
    Ok(meta)
}

#[tauri::command]
pub fn set_pinned(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    pinned: bool,
) -> Result<ChatMeta, String> {
    let meta = state.store.set_pinned(&chat_id, pinned)?;
    state.sync.wake();
    Ok(meta)
}

#[tauri::command]
pub async fn delete_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    if let Ok(chat) = state.store.load(&chat_id) {
        if chat.meta.remote {
            return delete_remote_chat(state.inner(), &chat.meta).await;
        }
    }
    crate::session::delete_local_chat(state.inner(), &chat_id)
}

/// Remove a conversation this machine owns. Both the local command and the
/// relay's `coding.delete` end here: a host deletes the same way whichever
/// device asked.

/// Delete a cached conversation on the machine that owns it.
///
/// Its folder, engine and session only exist there, so the original is removed
/// by its host; deleting this copy alone would be undone by the next stub sync.
/// The relay only reaches a machine that is running, which is why this works
/// while the host is online and says so, by name, when it is not.
async fn delete_remote_chat(state: &Arc<AppState>, meta: &ChatMeta) -> Result<(), String> {
    let device = meta
        .device_id
        .clone()
        .ok_or("This conversation does not know which machine owns it.")?;
    remote_ready(state)?;
    require_host(state, &device)?;
    match state
        .relay
        .rpc(
            &device,
            "coding.delete",
            serde_json::json!({ "chatId": meta.id }),
            Duration::from_secs(20),
        )
        .await
    {
        Ok(_) => {}
        // The host says it has no such conversation: it is already gone there,
        // so the copy here is the only thing left to remove.
        Err(failure) if failure.code == "unknown_chat" => {}
        Err(failure) => return Err(failure.message),
    }
    state.preview.stop_chat(&meta.id);
    // Nothing to keep in the trash: the owner's transcript is gone, so a
    // restored copy would be a cache of a conversation that no longer exists.
    state.store.remove_synced(&meta.id);
    state.sync.wake();
    Ok(())
}

#[tauri::command]
pub fn restore_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<ChatMeta, String> {
    let meta = state.store.restore(&chat_id)?;
    if meta.is_owned_coding(&state.agents.device_id()) {
        state.sync.revive_stub(&chat_id);
    }
    state.sync.wake();
    Ok(meta)
}

#[tauri::command]
pub fn search_chats(state: State<'_, Arc<AppState>>, query: String) -> Result<Vec<SearchHit>, String> {
    state.store.search(&query)
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, Arc<AppState>>,
    chat_id: Option<String>,
    text: String,
    images: Option<Vec<IncomingImage>>,
) -> Result<String, String> {
    let app_state = state.inner().clone();
    let text = text.trim().to_string();
    let images = images.unwrap_or_default();
    if text.is_empty() && images.is_empty() {
        return Err("Message is empty".into());
    }

    let mut chat = match chat_id {
        Some(id) => state.store.load(&id)?,
        None => Chat::new(),
    };

    // A command is not a message: the backend runs it and the window sees the
    // same events a turn would produce. `/unknown` is still plain text, so a
    // user who starts a sentence with a slash reaches the model as before.
    if let Some(call) = crate::slash::parse(&text) {
        if !images.is_empty() {
            return Err("A command cannot carry a picture. Send the picture with a message.".into());
        }
        crate::slash::run(&app_state, &chat, call).await?;
        return Ok(chat.meta.id);
    }

    // A coding-agent chat is a conversation with `pi`, not a model turn. The
    // same composer and the same command drive both, so the window never has
    // to know which kind of conversation it is looking at.
    if crate::coding::is_coding(&chat) {
        if text.is_empty() && images.is_empty() {
            return Err("The coding agent needs a message.".into());
        }
        // A free account has no coding agents unless it brought its own model
        // endpoint. The engine refuses too; this is the sentence the user reads.
        if state.auth.is_free() && state.settings.custom_provider().is_none() {
            crate::analytics::track(state.inner(), "coding_blocked_free");
            return Err(coding_needs_plan().into());
        }
        // A cached copy's owner is the one that owns the engine: ask it to
        // append the message and let its records come back over the relay. A
        // picture cannot take that trip - the relay carries the message, not
        // megabytes of image - so this side says no rather than losing it.
        if chat.meta.remote {
            if !images.is_empty() {
                return Err(
                    "Pictures stay on the computer that runs this agent. Send them from there."
                        .into(),
                );
            }
            let device = chat
                .meta
                .device_id
                .clone()
                .ok_or("This conversation does not know which machine owns it.")?;
            let message_id = uuid::Uuid::new_v4().to_string();
            crate::session::remote_rpc(
                &app_state,
                &device,
                "coding.send",
                serde_json::json!({
                    "chatId": chat.meta.id,
                    "text": text,
                    "messageId": message_id,
                }),
                Duration::from_secs(30),
            )
            .await?;
            return Ok(chat.meta.id);
        }
        crate::coding::send(&app_state, &mut chat, &text, &images)?;
        app_state.sync.wake();
        return Ok(chat.meta.id);
    }

    free_chat_allowed(state.inner())?;

    if state.turns.is_busy(&chat.meta.id) {
        return Err("A reply is already streaming in this chat.".into());
    }

    chat.meta.updated_at = now_ms();
    let mut message = Message::new("user", &text, "complete");
    message.attachments = state
        .store
        .save_incoming(&chat.meta.id, &images)?
        .into_iter()
        .map(|(attachment, _)| attachment)
        .collect();
    crate::session::commit_and_start(state.inner(), &mut chat, message)
}

/// Append `message` to `chat`, save it, and start the turn. The window and the
/// browser channel both end here, so a message from either looks the same in the
/// store and in the sync queue.

/// A message typed in Hook Browser's dock: text only, an ordinary chat, and the
/// same code path the window uses.

/// Cancel a chat's stream, without the coding/remote branches `stop_stream`
/// needs: the channel only serves ordinary chats.

fn coding_needs_plan() -> &'static str {
    "Coding agents are part of a paid plan. Add your own model provider in Settings to use one."
}

/// Remove the last reply from a chat, together with the tool traffic that
/// belonged to it. Returns false when there is nothing to remove.
///
/// The test for tool traffic is `tool_calls`, not `hidden`: a model can put
/// text in front of its calls ("Let me check that."), and such a message would
/// otherwise stay behind without the results it asked for — a history the
/// endpoint rejects on the next turn.
fn drop_last_reply(chat: &mut crate::store::Chat) -> bool {
    let Some(last) = chat.messages.iter().rposition(|m| m.role == "assistant") else {
        return false;
    };
    chat.messages.truncate(last);
    while chat
        .messages
        .last()
        .map(|m| m.role == "tool" || m.tool_calls.is_some())
        .unwrap_or(false)
    {
        chat.messages.pop();
    }
    true
}

/// The free plan's 24-hour message limit, checked before the turn starts so the
/// user reads a sentence instead of a 429. The server enforces the same rule
/// from its own usage log; this never widens it.
fn free_chat_allowed(state: &AppState) -> Result<(), String> {
    if !state.auth.is_free() || state.settings.custom_provider().is_some() {
        return Ok(());
    }
    if let Some(quota) = state.auth.quota() {
        if quota.exhausted() {
            crate::analytics::track(state, "quota_blocked");
            return Err(format!(
                "You have used all {} free messages in the last 24 hours. Add your own model provider in Settings, or upgrade to keep going.",
                quota.limit
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn regenerate(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    let mut chat = state.store.load(&chat_id)?;
    if crate::coding::is_coding(&chat) {
        return Err("A coding agent's replies come from the folder, not from Hook. Ask it again instead.".into());
    }
    if state.turns.is_busy(&chat_id) {
        return Err("A reply is already streaming in this chat.".into());
    }
    free_chat_allowed(state.inner())?;

    if !drop_last_reply(&mut chat) {
        return Err("Nothing to regenerate yet.".into());
    }
    if !chat.messages.iter().any(|m| m.role == "user") {
        return Err("Nothing to regenerate yet.".into());
    }
    chat.meta.updated_at = now_ms();
    state.store.save(&mut chat)?;
    state.sync.wake();

    turn::kick(state.inner().clone(), chat_id);
    Ok(())
}

#[tauri::command]
pub fn edit_message(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    message_id: String,
    text: String,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let mut chat = state.store.load(&chat_id)?;
    if crate::coding::is_coding(&chat) {
        return Err("A coding agent's messages cannot be edited; send a new one instead.".into());
    }
    if state.turns.is_busy(&chat_id) {
        return Err("A reply is already streaming in this chat.".into());
    }
    free_chat_allowed(state.inner())?;

    let Some(index) = chat.messages.iter().position(|m| m.id == message_id) else {
        return Err("Message not found".into());
    };
    if chat.messages[index].role != "user" {
        return Err("Only user messages can be edited".into());
    }

    chat.messages.truncate(index);
    let mut user = Message::new("user", &text, "complete");
    user.id = message_id;
    chat.messages.push(user);
    chat.meta.updated_at = now_ms();
    state.store.save(&mut chat)?;
    state.sync.wake();

    turn::kick(state.inner().clone(), chat_id);
    Ok(())
}

#[tauri::command]
pub async fn stop_stream(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    let Ok(chat) = state.store.load(&chat_id) else {
        return Ok(());
    };
    if crate::coding::is_coding(&chat) {
        if chat.meta.remote {
            // Close this window's copy first: the spinner must stop even when
            // the machine that owns the engine is unreachable. The host gets
            // the stop over the relay.
            crate::coding::close(state.inner(), &chat_id, "aborted");
            if let Some(device) = chat.meta.device_id.clone() {
                let _ = crate::session::remote_rpc(
                    state.inner(),
                    &device,
                    "coding.stop",
                    serde_json::json!({ "chatId": chat_id }),
                    Duration::from_secs(15),
                )
                .await;
            }
        } else {
            crate::coding::stop(state.inner(), &chat_id);
        }
        return Ok(());
    }
    let token = lock(&state.streams).get(&chat_id).cloned();
    if let Some(token) = token {
        token.cancel();
    }
    Ok(())
}

/// Start a conversation with a coding agent in a folder the user picked.
/// Advanced mode is the door: the window offers it, the backend enforces it.
#[tauri::command]
pub fn create_coding_chat(
    state: State<'_, Arc<AppState>>,
    folder: String,
) -> Result<ChatMeta, String> {
    let meta = crate::coding::create(state.inner(), &folder)?;
    Ok(meta)
}

/// Point an existing coding chat at a different folder (a moved project, or a
/// conversation that arrived with a path this computer does not have).
#[tauri::command]
pub fn set_coding_chat_folder(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    folder: String,
) -> Result<ChatMeta, String> {
    let chat = state.store.load(&chat_id)?;
    if chat.meta.remote {
        let machine = chat
            .meta
            .device_name
            .clone()
            .or(chat.meta.device_id.clone())
            .unwrap_or_else(|| "the machine that owns it".into());
        return Err(format!(
            "The folder belongs to {machine}. Start a different chat there instead."
        ));
    }
    let meta = crate::coding::set_folder(state.inner(), &chat_id, &folder)?;
    Ok(meta)
}

/// Walk a host's folders so a controller can start a direct chat outside the
/// projects list. One level per call; the answer is names and paths, never a
/// file's contents. `path: None` lists the places to start from.
#[tauri::command]
pub async fn remote_folders(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    path: Option<String>,
) -> Result<serde_json::Value, String> {
    remote_ready(state.inner())?;
    require_host(state.inner(), &device_id)?;
    crate::session::remote_rpc(
        state.inner(),
        &device_id,
        "folders.browse",
        serde_json::json!({ "path": path }),
        Duration::from_secs(20),
    )
    .await
}

/// Star or unstar a folder on another machine. The star is stored on that
/// machine, so the shortcut is there for every device that browses it — the
/// same list the phone and Workspace see. The answer is the whole pinned list.
#[tauri::command]
pub async fn remote_pin_folder(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    path: String,
    pinned: bool,
) -> Result<Vec<String>, String> {
    remote_ready(state.inner())?;
    require_host(state.inner(), &device_id)?;
    let result = crate::session::remote_rpc(
        state.inner(),
        &device_id,
        "folders.pin",
        serde_json::json!({ "path": path, "pinned": pinned }),
        Duration::from_secs(20),
    )
    .await?;
    Ok(result["pinned"]
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|entry| entry.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default())
}

/// Answer a question a directly-driven coding agent is blocked on.
#[tauri::command]
pub async fn answer_coding_agent(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    answer: String,
) -> Result<(), String> {
    let chat = state.store.load(&chat_id)?;
    if chat.meta.remote {
        let device = chat
            .meta
            .device_id
            .clone()
            .ok_or("This conversation does not know which machine owns it.")?;
        crate::session::remote_rpc(
            state.inner(),
            &device,
            "coding.answer",
            serde_json::json!({ "chatId": chat_id, "answer": answer }),
            Duration::from_secs(20),
        )
        .await?;
        return Ok(());
    }
    crate::coding::answer(state.inner(), &chat_id, &answer)
}

/// Remote control is a paid feature and needs the account-wide sync switch.
/// The server enforces the same rule on the relay and the preview routes; this
/// is the sentence a window can show without a round trip.
fn remote_ready(state: &AppState) -> Result<(), String> {
    if !state.auth.required() || state.auth.token().is_none() {
        return Err("Sign in to use another machine.".into());
    }
    if state.auth.is_free() {
        return Err("Remote machines are part of a paid plan.".into());
    }
    if state.auth.cloud_sync() == Some(false) {
        return Err("Turn on cloud sync to use another machine.".into());
    }
    Ok(())
}

/// Check that a device is a host that is accepting work right now. The relay
/// checks again on the server; this only saves a round trip and gives a clearer
/// sentence.
fn require_host(state: &AppState, device_id: &str) -> Result<String, String> {
    if device_id.trim().is_empty() {
        return Err("Choose a machine.".into());
    }
    let view = state.relay.view();
    let device = view
        .devices
        .iter()
        .find(|device| device.id == device_id)
        .ok_or("That machine is not in this account.")?;
    if !device.can_host {
        return Err(format!("{} cannot run coding agents.", device.name));
    }
    if !device.remote_allowed {
        return Err(format!(
            "{} is not accepting remote work. Turn it on in Settings on that machine.",
            device.name
        ));
    }
    if !device.host_online {
        return Err(format!("{} is not online.", device.name));
    }
    Ok(device.name.clone())
}


/// The projects a host can open a coding chat in. Only account projects: a
/// controller never supplies an arbitrary path on another machine.
#[tauri::command]
pub async fn remote_projects(
    state: State<'_, Arc<AppState>>,
    device_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    remote_ready(state.inner())?;
    require_host(state.inner(), &device_id)?;
    let result = crate::session::remote_rpc(
        state.inner(),
        &device_id,
        "projects.list",
        serde_json::json!({}),
        Duration::from_secs(20),
    )
    .await?;
    Ok(result["projects"].as_array().cloned().unwrap_or_default())
}

/// Create a project folder on a host. The controller only supplies a name and
/// a description; the host resolves its own projects folder.
#[tauri::command]
pub async fn remote_create_project(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    name: String,
    description: Option<String>,
) -> Result<serde_json::Value, String> {
    remote_ready(state.inner())?;
    require_host(state.inner(), &device_id)?;
    crate::session::remote_rpc(
        state.inner(),
        &device_id,
        "projects.create",
        serde_json::json!({
            "name": name,
            "description": description.unwrap_or_default(),
        }),
        Duration::from_secs(30),
    )
    .await
}

/// Create a direct coding chat on another machine. The host keeps the folder,
/// the engine and the session; this device only stores a cache that is flagged
/// as remote, so sync can never upload its messages. The target is one of the
/// host's projects, or a folder it walked to with `remote_folders`.
#[tauri::command]
pub async fn create_remote_coding_chat(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    project: Option<String>,
    folder: Option<String>,
) -> Result<ChatMeta, String> {
    remote_ready(state.inner())?;
    if device_id == state.relay.device_id() {
        return Err("Use Coding agent… to start a chat on this computer.".into());
    }
    let name = require_host(state.inner(), &device_id)?;
    let folder = folder
        .map(|folder| folder.trim().to_string())
        .filter(|folder| !folder.is_empty());
    let project = project.unwrap_or_default().trim().to_string();
    let target = match folder {
        Some(folder) => serde_json::json!({ "folder": folder }),
        None if !project.is_empty() => serde_json::json!({ "project": project }),
        None => return Err("Name a project or choose a folder on that machine.".into()),
    };
    let result = crate::session::remote_rpc(
        state.inner(),
        &device_id,
        "coding.create",
        target,
        Duration::from_secs(30),
    )
    .await?;
    let mut meta: ChatMeta = serde_json::from_value(result)
        .map_err(|error| format!("The machine sent an unreadable chat: {error}"))?;
    meta.remote = true;
    meta.device_id = Some(device_id);
    meta.device_name = Some(meta.device_name.clone().unwrap_or(name));
    // The host's folder and session are its own; a cache shows neither.
    meta.project_path = None;
    meta.session_id = None;
    meta.stub_state = Some("idle".into());
    let mut chat = Chat {
        meta: meta.clone(),
        messages: Vec::new(),
    };
    state.store.save_remote(&mut chat)?;
    state.relay.subscribe(&meta.id);
    Ok(meta)
}

/// Fetch the transcript of a remote chat from its owner. The cache on disk is
/// the fallback when the machine is offline; a returned chat replaces it.
#[tauri::command]
pub async fn fetch_remote_chat(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
) -> Result<Chat, String> {
    let local = state.store.load(&chat_id)?;
    if !local.meta.remote {
        return Ok(local);
    }
    let device = local
        .meta
        .device_id
        .clone()
        .ok_or("This conversation does not know which machine owns it.")?;
    let result = crate::session::remote_rpc(
        state.inner(),
        &device,
        "coding.fetch",
        serde_json::json!({ "chatId": chat_id }),
        Duration::from_secs(30),
    )
    .await?;
    let mut remote: Chat = serde_json::from_value(
        result
            .get("chat")
            .cloned()
            .ok_or("The machine did not send the conversation.")?,
    )
    .map_err(|error| format!("The machine sent an unreadable conversation: {error}"))?;
    if remote.meta.id != chat_id {
        return Err("The machine sent a different conversation.".into());
    }
    remote.meta.remote = true;
    remote.meta.device_id = Some(device);
    remote.meta.device_name = Some(
        local
            .meta
            .device_name
            .clone()
            .or(remote.meta.device_name.clone())
            .unwrap_or_else(|| "another machine".into()),
    );
    remote.meta.project_path = None;
    remote.meta.session_id = None;
    remote.meta.pinned = local.meta.pinned;
    remote.meta.pinned_at = local.meta.pinned_at;
    remote.meta.stub_state = Some(
        if remote
            .messages
            .iter()
            .any(|message| message.status == "streaming")
        {
            "running"
        } else {
            "idle"
        }
        .to_string(),
    );
    state.store.save_remote(&mut remote)?;
    state.relay.subscribe(&chat_id);
    Ok(remote)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderView {
    /// Base URL or full endpoint, as the user typed it.
    pub base_url: String,
    pub model: String,
    /// A key is stored for this product. The key itself never crosses the IPC
    /// boundary, so a window cannot leak it into a log or a screenshot.
    pub has_key: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub projects_dir: String,
    pub projects: Vec<Project>,
    /// Projects removed in the last seven days, with the day each copy goes for
    /// good. The Settings sheet lists them under the projects with a Restore.
    pub trashed: Vec<crate::projects::TrashedProject>,
    /// The conversation shows thinking and tool calls, and the sidebar shows
    /// every coding-agent transcript. See `SettingsStore::advanced_mode`.
    pub advanced_mode: bool,
    /// `free`, `plus` or `pro`; `None` on a local preview build.
    pub plan: Option<String>,
    /// The account-level cloud-sync switch. Free accounts never sync whatever
    /// this says, and the server refuses the call for them.
    pub cloud_sync: bool,
    /// The model endpoint this product uses instead of Hook's own, if any.
    pub custom_provider: Option<CustomProviderView>,
}

fn settings_view(state: &AppState) -> SettingsView {
    let projects_dir = state.settings.projects_dir();
    let projects = state.projects.list(&projects_dir).unwrap_or_default();
    SettingsView {
        projects_dir: projects_dir.to_string_lossy().to_string(),
        projects,
        trashed: state.projects.trashed(),
        advanced_mode: state
            .auth
            .advanced_mode()
            .unwrap_or_else(|| state.settings.advanced_mode()),
        plan: state.auth.plan(),
        cloud_sync: state.auth.cloud_sync().unwrap_or(true),
        custom_provider: state.settings.custom_provider().map(|provider| CustomProviderView {
            base_url: provider.base_url,
            model: provider.model,
            has_key: !provider.api_key.is_empty(),
        }),
    }
}

#[tauri::command]
pub fn get_settings(state: State<'_, Arc<AppState>>) -> Result<SettingsView, String> {
    Ok(settings_view(&state))
}

/// The commands the composer may offer. Empty unless advanced mode is on, so a
/// simple-mode window never shows a menu it cannot use; `send_message` refuses
/// them independently.
#[tauri::command]
pub fn slash_commands(state: State<'_, Arc<AppState>>) -> Vec<crate::slash::CommandView> {
    crate::slash::list(state.settings.advanced_mode())
}

#[tauri::command]
pub async fn set_projects_dir(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<SettingsView, String> {
    state.settings.set_projects_dir(&path)?;
    Ok(settings_view(&state))
}

/// Remove a project from this computer and from the account.
///
/// The folder moves into this product's trash, where it stays for seven days
/// ([`crate::projects::TRASH_DAYS`]) — nothing of the user's is destroyed on the
/// spot, and `restore_project` puts it back. The account's row is removed through
/// the tombstone the sync engine sends, so the next pull cannot put it back; a
/// restore re-sends the project, and the row and its repository come back with
/// the same id.
#[tauri::command]
pub fn delete_project(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<SettingsView, String> {
    let project = state.projects.delete(&id)?;
    state.sync.project_deleted(&project.id);
    state.sync.wake();
    state.events.emit(
        "hook://sync",
        serde_json::json!({
            "chats": false,
            "projects": true,
            "memory": false,
            "at": now_ms(),
        }),
    );
    Ok(settings_view(&state))
}

/// Bring a project back out of the trash, with the files it had.
///
/// The sync engine cancels the tombstone if it has not gone out and re-sends the
/// project otherwise, so the account's row returns with the same id. When the
/// copy is already gone the folder comes back empty and the repository's commits
/// are pulled into it on the next cycle.
#[tauri::command]
pub fn restore_project(
    state: State<'_, Arc<AppState>>,
    id: String,
) -> Result<SettingsView, String> {
    let restored = state.projects.restore(&state.settings.projects_dir(), &id)?;
    state.sync.project_restored(&restored.project.id);
    state.sync.wake();
    state.events.emit(
        "hook://sync",
        serde_json::json!({
            "chats": false,
            "projects": true,
            "memory": false,
            "at": now_ms(),
        }),
    );
    Ok(settings_view(&state))
}

/// Turn the debugging view on or off.
///
/// It is account state, not product state: the setting lives on the account so
/// the phone and Hook Workspace show the same view as this computer. The local
/// `settings.json` is kept in step as the fallback for a signed-out window. The
/// UI re-renders from the returned settings, so the switch and the conversation
/// can never disagree.
#[tauri::command]
pub async fn set_advanced_mode(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    if state.auth.required() && state.auth.token().is_some() {
        state.auth.set_advanced_mode(enabled).await?;
        // Only a cache: a disk that refuses the write must not fail a switch the
        // account already accepted.
        if let Err(error) = state.settings.set_advanced_mode(enabled) {
            eprintln!("hook: could not cache advanced mode: {error}");
        }
    } else {
        state.settings.set_advanced_mode(enabled)?;
    }
    Ok(settings_view(&state))
}

/// Save the user's own model endpoint for this product.
///
/// The key is stored in this product's `settings.json` and sent only to the
/// endpoint it names. A paid account with cloud sync on also gets one encrypted
/// copy on the account, so the phone and Workspace can use it without the key
/// being typed again; with sync off it never leaves this computer. A free
/// account that sets one may use coding agents and is not metered by Hook.
#[tauri::command]
pub fn set_custom_provider(
    state: State<'_, Arc<AppState>>,
    base_url: String,
    api_key: Option<String>,
    model: String,
) -> Result<SettingsView, String> {
    let account = state.auth.subject();
    state.settings.set_custom_provider(
        &base_url,
        api_key.as_deref().unwrap_or(""),
        &model,
        account.as_deref(),
    )?;
    // Share it now rather than on the next cycle: the user just pressed Save.
    state.sync.wake();
    let shared = state.inner().clone();
    crate::rt::spawn(async move {
        crate::provider::refresh_capabilities(&shared).await;
    });
    crate::analytics::track(state.inner(), "byok_saved");
    Ok(settings_view(&state))
}

#[tauri::command]
pub fn clear_custom_provider(state: State<'_, Arc<AppState>>) -> Result<SettingsView, String> {
    let account = state.auth.subject();
    state.settings.clear_custom_provider(account.as_deref())?;
    // The clear has to reach the other devices too.
    state.sync.wake();
    let shared = state.inner().clone();
    crate::rt::spawn(async move {
        crate::provider::refresh_capabilities(&shared).await;
    });
    crate::analytics::track(state.inner(), "byok_removed");
    Ok(settings_view(&state))
}

/// Ask a personal endpoint which models it offers. Errors are shown beside the
/// field; the window always accepts a typed model name as well.
#[tauri::command]
pub async fn custom_models(
    state: State<'_, Arc<AppState>>,
    base_url: Option<String>,
    api_key: Option<String>,
) -> Result<Vec<String>, String> {
    let saved = state.settings.custom_provider();
    let endpoint = match base_url
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => crate::settings::validate_base_url(value)?,
        None => saved
            .as_ref()
            .map(|provider| provider.base_url.clone())
            .ok_or("Enter the endpoint first.")?,
    };
    let key = api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| saved.map(|provider| provider.api_key))
        .ok_or("Enter the API key first.")?;
    let models = crate::provider::fetch_models(&endpoint, &key).await?;
    crate::analytics::track(state.inner(), "byok_models_loaded");
    Ok(models)
}

/// Turn this account's cloud sync on or off, for every Hook product.
///
/// The switch lives on the account, not in this product's settings, so turning
/// it off here also stops Workspace and the phone. A free account is refused by
/// the server; the window does not offer the switch to one.
#[tauri::command]
pub async fn set_cloud_sync(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    let view = state.auth.set_cloud_sync(enabled).await?;
    crate::auth::emit(&state.events, &view);
    state.sync.wake();
    if enabled {
        state.relay.wake();
    } else {
        state.relay.disconnect();
    }
    crate::analytics::track(
        &state,
        if enabled { "sync_enabled" } else { "sync_disabled" },
    );
    Ok(settings_view(&state))
}

#[tauri::command]
pub fn read_image(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    attachment_id: String,
) -> Result<String, String> {
    state.store.read_image(&chat_id, &attachment_id)
}

/// Hand a stored picture to whatever the OS opens images with. The copy in
/// `%TEMP%` keeps the viewer working even if the chat is deleted afterwards, and
/// gives it a sensible file name.
#[tauri::command]
pub async fn open_image(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    attachment_id: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let source = state.store.image_file(&chat_id, &attachment_id)?;
    let dir = std::env::temp_dir().join("hook-images");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = source
        .file_name()
        .map(|n| n.to_owned())
        .ok_or_else(|| "Image not found".to_string())?;
    let target = dir.join(&name);
    std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// "Save as…": native save dialog, defaulting to the picture's own name and
/// format. Returns false when the dialog was dismissed.
#[tauri::command]
pub async fn save_image_as(
    app: tauri::AppHandle,
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    attachment_id: String,
    suggested_name: String,
) -> Result<bool, String> {
    use tauri_plugin_dialog::DialogExt;

    let source = state.store.image_file(&chat_id, &attachment_id)?;
    let extension = source
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".into());

    let fallback = format!("hook-image.{extension}");
    let name = {
        let trimmed = suggested_name.trim();
        if trimmed.is_empty() {
            fallback
        } else {
            let stem = trimmed.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "-");
            if stem.to_lowercase().ends_with(&format!(".{extension}")) {
                stem
            } else {
                format!("{stem}.{extension}")
            }
        }
    };

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&name)
        .add_filter(extension.to_uppercase(), &[extension.as_str()])
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });

    let Some(chosen) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(false);
    };
    let target = chosen.into_path().map_err(|e| e.to_string())?;
    copy_image(&source, &target)?;
    Ok(true)
}

fn copy_image(source: &std::path::Path, target: &std::path::Path) -> Result<(), String> {
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|e| format!("Couldn't save the picture: {e}"))
}

/// "Save": a copy in `Pictures/Hook`, with no dialog.
///
/// A picture attached to a chat already lives on this computer, in a folder the
/// user never browses; this puts a copy where they will find it. It never
/// overwrites: a second save of the same picture becomes `-2`. Returns the path,
/// so the window can tell the reader where it went.
#[tauri::command]
pub fn save_image(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    attachment_id: String,
) -> Result<String, String> {
    let source = state.store.image_file(&chat_id, &attachment_id)?;
    let bytes = std::fs::read(&source)
        .map_err(|e| format!("{0}: {e}", source.display()))?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_else(|| "png".to_string());
    let name = source
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("hook-image")
        .to_string();
    let image = crate::imagegen::Generated {
        bytes,
        mime: format!("image/{}", if extension == "jpg" { "jpeg" } else { &extension }),
        width: 0,
        height: 0,
    };
    let folder = crate::imagegen::default_folder();
    let path =
        crate::imagegen::save_copy(&folder.join(format!("{name}.{extension}")), &image, &name, 0)?;
    Ok(path.display().to_string())
}

/// "Export as PDF": a native save dialog, then the window draws the page it is
/// showing into that file (`pdf.rs`).
///
/// `page_height` is the window's measurement of the printed copy in inches,
/// margins included: the writer draws one page that tall. `None` leaves the
/// writer's own sheets, which is what a caller with nothing to measure sends.
///
/// `direct` is the platform's answer, not the person's: when it is false there
/// is no silent writer here, and the window prints through the system dialog
/// instead of asking for a path nothing could fill.
#[tauri::command]
pub async fn export_pdf(
    app: AppHandle,
    webview: tauri::Webview,
    suggested_name: String,
    page_height: Option<f64>,
) -> Result<crate::pdf::PdfExport, String> {
    use tauri_plugin_dialog::DialogExt;

    let dismissed = crate::pdf::PdfExport {
        path: None,
        direct: crate::pdf::DIRECT,
    };
    if !crate::pdf::DIRECT {
        return Ok(dismissed);
    }

    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&crate::pdf::file_name(&suggested_name))
        .add_filter("PDF", &["pdf"])
        .save_file(move |chosen| {
            let _ = tx.send(chosen);
        });

    let Some(chosen) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(dismissed);
    };
    let target = chosen.into_path().map_err(|e| e.to_string())?;
    crate::pdf::write(webview, target.clone(), page_height).await?;
    Ok(crate::pdf::PdfExport {
        path: Some(target.to_string_lossy().to_string()),
        direct: true,
    })
}

#[cfg(test)]
mod tests {
    use super::{copy_image, drop_last_reply};
    use crate::store::{Chat, Message, ToolCallRecord};

    #[test]
    fn saving_copies_the_picture_byte_for_byte() {
        let dir = std::env::temp_dir().join(format!("hook-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let source = dir.join("source.png");
        std::fs::write(&source, b"not really a png").unwrap();
        let target = dir.join("chosen by the user.png");

        copy_image(&source, &target).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), b"not really a png");
        assert!(copy_image(&dir.join("missing.png"), &target).is_err());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn regenerating_removes_a_tool_turn_even_when_it_spoke_first() {
        let mut assistant = Message::new("assistant", "Let me check.", "complete");
        assistant.tool_calls = Some(vec![ToolCallRecord {
            id: "call_1".into(),
            name: "workspace_tasks".into(),
            arguments: "{}".into(),
        }]);
        let mut tool = Message::new("tool", "{\"tasks\":[]}", "complete");
        tool.tool_call_id = Some("call_1".into());

        let mut chat = Chat::new();
        chat.messages = vec![
            Message::new("user", "what tasks do i have?", "complete"),
            assistant,
            tool,
            Message::new("assistant", "Five, all to do.", "complete"),
        ];

        assert!(drop_last_reply(&mut chat));
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].role, "user");
    }

    #[test]
    fn regenerating_stops_at_the_user_message() {
        let mut chat = Chat::new();
        assert!(!drop_last_reply(&mut chat));
        chat.messages = vec![
            Message::new("user", "hi", "complete"),
            Message::new("assistant", "hello", "complete"),
        ];
        assert!(drop_last_reply(&mut chat));
        assert_eq!(chat.messages.len(), 1);
        assert_eq!(chat.messages[0].role, "user");
    }
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_overview(state: State<'_, Arc<AppState>>) -> crate::agent::Overview {
    state.agents.overview()
}

/// One coding agent's thinking, narration and tool calls, for the advanced
/// inspector. Read-only: steering still goes through the chat agent.
#[tauri::command]
pub fn agent_transcript(
    state: State<'_, Arc<AppState>>,
    agent_id: String,
) -> Result<crate::agent::AgentTranscript, String> {
    state.agents.transcript(&agent_id)
}

/// The Stop button in the task board: stop every live coding agent in this
/// chat, kill their process trees, and hand back the fresh overview so the UI
/// does not have to wait for the next event.
#[tauri::command]
pub fn stop_chat_agents(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
) -> Result<crate::agent::Overview, String> {
    state.agents.stop_chat(&chat_id);
    // A coding-agent chat draws that run as its conversation, so it has to
    // learn that the process is gone; the abort handshake may never answer.
    if state
        .store
        .load(&chat_id)
        .map(|chat| crate::coding::is_coding(&chat))
        .unwrap_or(false)
    {
        crate::coding::close(state.inner(), &chat_id, "aborted");
    }
    Ok(state.agents.overview())
}

/// The preview the panel should show when the webview boots (or reloads).
#[tauri::command]
pub fn preview_state(state: State<'_, Arc<AppState>>) -> Option<PreviewView> {
    state.preview.snapshot()
}

/// Compare this build with the published release index. Public endpoint: a
/// signed-out window still learns that it is too old to sign in.
#[tauri::command]
pub async fn check_update(state: State<'_, Arc<AppState>>) -> Result<crate::update::UpdateInfo, String> {
    crate::update::check(&state.cfg, state.product).await
}

/// Send an in-app report of inappropriate AI output (Store policy 11.16).
#[tauri::command]
pub async fn report_message(
    state: State<'_, Arc<AppState>>,
    mut payload: crate::reports::ReportRequest,
) -> Result<(), String> {
    let token = state
        .auth
        .token()
        .ok_or("Sign in to report a message.")?;
    payload.app_version = crate::update::current_version();
    crate::reports::submit(&state.cfg, &token, &payload).await
}

/// Report something a person wrote, seen in a preview.
///
/// A task's comments and a document are user-generated content, so both stores
/// ask for a flag that does not depend on a model having said anything. It goes
/// to the same review queue as an AI report, with the target instead of a
/// message id.
#[tauri::command]
pub async fn report_content(
    state: State<'_, Arc<AppState>>,
    mut payload: crate::reports::ContentReportRequest,
) -> Result<(), String> {
    let token = state
        .auth
        .token()
        .ok_or("Sign in to report this content.")?;
    payload.app_version = crate::update::current_version();
    crate::reports::submit(&state.cfg, &token, &payload).await
}

/// Open the Microsoft Store's update surface for a packaged (MSIX) build and
/// quit: the Store cannot replace a package that is still running.
#[tauri::command]
pub fn open_store_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::update::open_store_for_update(&app, &state.cfg)
}

/// Download the newest installer, verify it, launch it and exit Hook. The
/// installer replaces this build and starts it again.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::update::install(&app, &state.cfg, state.product, state.auth.token()).await
}

