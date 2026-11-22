use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};

use crate::agent::AgentManager;
use crate::auth::{AuthStore, AuthView, LoginOutcome, RefreshOutcome};
use crate::config;
use crate::preview::{PreviewManager, PreviewView};
use crate::projects::{Project, ProjectsStore};
use crate::provider::CancelToken;
use crate::settings::SettingsStore;
use crate::store::{now_ms, Chat, ChatMeta, Message, SearchHit, Store, DEFAULT_TITLE};
use crate::turn::{self, TurnState};

pub struct AppState {
    pub app: AppHandle,
    pub store: Arc<Store>,
    pub settings: Arc<SettingsStore>,
    pub projects: Arc<ProjectsStore>,
    /// What the chat agent remembers between conversations. Shared by both
    /// products: it lives beside the account file, not beside the chats.
    pub memory: Arc<crate::memory::MemoryStore>,
    pub agents: Arc<AgentManager>,
    pub preview: Arc<PreviewManager>,
    pub streams: Arc<Mutex<HashMap<String, CancelToken>>>,
    pub turns: TurnState,
    /// The assistant message a directly-driven coding agent is still writing.
    /// Only this process can finish it; see `coding.rs`.
    pub coding: crate::coding::CodingState,
    /// The compiled-in harness config (provider, model, auth origin).
    pub cfg: Arc<config::HarnessConfig>,
    /// The signed-in account and its API token.
    pub auth: Arc<AuthStore>,
    /// Background conversation and project sync.
    pub sync: Arc<crate::sync::SyncEngine>,
    /// The live account connection: presence, remote commands and chat fan-out.
    pub relay: Arc<crate::relay::RelayClient>,
    /// Chats a controller is driving on this machine. Their live turn and agent
    /// events are mirrored to the relay; a chat used only here never leaves the
    /// process.
    pub remote_chats: Arc<Mutex<HashSet<String>>>,
    /// Whether the model can see images, taken from its `/models` card.
    pub vision: Arc<std::sync::atomic::AtomicBool>,
    /// Set when the endpoint rejects image parts anyway, so later turns stop
    /// trying. A card can promise more than the endpoint delivers.
    pub vision_off: Arc<std::sync::atomic::AtomicBool>,
    /// Set when the endpoint refused a context frame sent as a trailing
    /// `system` message, so later turns send it as `user` instead. A card can
    /// promise more than the endpoint delivers; so can a config.
    pub context_role_off: Arc<std::sync::atomic::AtomicBool>,
    /// Scanned ChatGPT / Claude exports, kept between the preview and the
    /// confirmation so a large archive is parsed once.
    pub imports: Arc<crate::import::Importer>,
    /// Hook Workspace's data, reached over the account API. Shared with the
    /// chat agent's tools, which work without Workspace installed.
    pub workspace: Arc<crate::workspace::WorkspaceClient>,
    /// What the user is looking at, written by the product's window. Ephemeral:
    /// it rides on the next request only, and is never stored in a chat.
    pub context: Arc<Mutex<Option<String>>>,
    /// Which desktop product this backend is serving.
    pub product: crate::Product,
    /// What this product's chat agent may do (see `Capabilities`).
    pub capabilities: crate::Capabilities,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

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
    let trimmed = context.trim();
    let value = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.chars().take(4000).collect::<String>())
    };
    *lock(&state.context) = value;
}

impl AppState {
    /// The live context block, if the product set one.
    pub fn chat_context(&self) -> Option<String> {
        lock(&self.context).clone()
    }
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
    tauri::async_runtime::spawn_blocking(move || {
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
    let app = state.app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let emit = |progress: crate::import::ImportProgress| {
            let _ = app.emit("hook://import", progress);
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
        product: match state.product {
            crate::Product::Chat => "chat",
            crate::Product::Workspace => "workspace",
            crate::Product::Mobile => "mobile",
        },
    })
}

fn emit_auth(app: &AppHandle, view: &AuthView) {
    let _ = app.emit("hook://auth", view);
}

/// Drop everything that belonged to the signed-in account: live coding
/// agents, in-flight chat streams and the preview server. Used when the token
/// is revoked server-side or the user signs out.
pub(crate) fn revoke_local(state: &AppState) {
    state.agents.kill_all_sync();
    state.preview.stop();
    state.relay.disconnect();
    for token in lock(&state.streams).values() {
        token.cancel();
    }
    lock(&state.streams).clear();
}

/// Ask the model card what it can see. Called at launch, after sign-in and on
/// window reload. A provider without `/models` simply reports nothing.
pub async fn refresh_capabilities(state: &Arc<AppState>) {
    // The card belongs to whichever endpoint this product talks to: Hook's own
    // model, or the one the user entered. A provider without `/models` simply
    // reports nothing.
    let Ok(target) = crate::provider::ProviderTarget::resolve(
        &state.cfg,
        state.settings.custom_provider().as_ref(),
        state.auth.token(),
    ) else {
        state.vision.store(false, std::sync::atomic::Ordering::Relaxed);
        return;
    };
    let caps = crate::provider::fetch_capabilities(&target.cfg, &target.token, target.byok).await;
    if !caps.known {
        eprintln!("hook: no model card at the provider; capabilities unknown");
        return;
    }
    eprintln!(
        "hook: model {} capabilities from /models: vision={}",
        target.cfg.model.name, caps.vision
    );
    state
        .vision
        .store(caps.vision, std::sync::atomic::Ordering::Relaxed);
    if caps.vision {
        state
            .vision_off
            .store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

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
    emit_auth(&app, &view);

    let poll_state = state.clone();
    let poll_app = app.clone();
    tauri::async_runtime::spawn(async move {
        match poll_state.auth.wait_for_approval(generation).await {
            LoginOutcome::Approved => {
                // Show the app as soon as the token is stored; the model-card
                // probe can finish in the background.
                emit_auth(&poll_app, &poll_state.auth.view());
                poll_state.sync.wake();
                poll_state.relay.wake();
                refresh_capabilities(&poll_state).await;
            }
            LoginOutcome::Cancelled => {
                emit_auth(&poll_app, &poll_state.auth.view());
            }
            LoginOutcome::Failed(message) => {
                poll_state.auth.cancel();
                let mut view = poll_state.auth.view();
                view.message = Some(message);
                emit_auth(&poll_app, &view);
            }
        }
    });

    Ok(view)
}

#[tauri::command]
pub fn auth_cancel_login(app: AppHandle, state: State<'_, Arc<AppState>>) -> AuthView {
    state.auth.cancel();
    let view = state.auth.view();
    emit_auth(&app, &view);
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
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    id_token: String,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    let view = state.auth.login_with_google(&id_token).await?;
    emit_auth(&app, &view);
    // A finished sign-in is when the account's conversations start arriving.
    state.sync.wake();
    state.relay.wake();
    let ready = state.clone();
    tauri::async_runtime::spawn(async move {
        refresh_capabilities(&ready).await;
    });
    Ok(view)
}

/// Check the cached token against hookcode.io. A revoked or unapproved account
/// is signed out here, before its next message fails.
#[tauri::command]
pub async fn auth_refresh(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    match state.auth.refresh().await {
        RefreshOutcome::Valid => {
            refresh_capabilities(&state).await;
            state.sync.wake();
            state.relay.wake();
            Ok(state.auth.view())
        }
        RefreshOutcome::Revoked(message) => {
            revoke_local(&state);
            let mut view = state.auth.view();
            view.message = Some(message);
            emit_auth(&app, &view);
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
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<AuthView, String> {
    let state = state.inner().clone();
    state.auth.logout().await;
    revoke_local(&state);
    let view = state.auth.view();
    emit_auth(&app, &view);
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
        let result = remote_rpc(
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
pub fn delete_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    let meta = state.store.load(&chat_id).ok().map(|chat| chat.meta);
    if let Some(meta) = &meta {
        if meta.remote {
            let machine = meta
                .device_name
                .clone()
                .or_else(|| meta.device_id.clone())
                .unwrap_or_else(|| "another machine".into());
            return Err(format!(
                "This conversation lives on {machine}. Delete it there."
            ));
        }
        if meta.is_owned_coding(&state.agents.device_id()) {
            state.sync.forget_stub(&chat_id);
        }
    }
    for agent in state.agents.list() {
        if agent.chat_id == chat_id && agent.is_live() {
            let _ = state.agents.stop(&agent.id);
        }
    }
    state.preview.stop_chat(&chat_id);
    state.store.delete(&chat_id)?;
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

/// One picture pasted, dropped or picked in the composer.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingImage {
    /// `data:image/png;base64,...`
    pub data_url: String,
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
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

    // A coding-agent chat is a conversation with `pi`, not a model turn. The
    // same composer and the same command drive both, so the window never has
    // to know which kind of conversation it is looking at.
    if crate::coding::is_coding(&chat) {
        if text.is_empty() {
            return Err("The coding agent needs a message.".into());
        }
        // A free account has no coding agents unless it brought its own model
        // endpoint. The engine refuses too; this is the sentence the user reads.
        if state.auth.is_free() && state.settings.custom_provider().is_none() {
            crate::analytics::track(state.inner(), "coding_blocked_free");
            return Err(coding_needs_plan().into());
        }
        // Pictures are a chat-model feature; the coding agent talks in text.
        // A cached copy's owner is the one that owns the engine: ask it to
        // append the message and let its records come back over the relay.
        if chat.meta.remote {
            let device = chat
                .meta
                .device_id
                .clone()
                .ok_or("This conversation does not know which machine owns it.")?;
            let message_id = uuid::Uuid::new_v4().to_string();
            remote_rpc(
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
        crate::coding::send(&app_state, &mut chat, &text)?;
        app_state.sync.wake();
        return Ok(chat.meta.id);
    }

    free_chat_allowed(state.inner())?;

    if state.turns.is_busy(&chat.meta.id) {
        return Err("A reply is already streaming in this chat.".into());
    }

    if chat.messages.is_empty() && chat.meta.title == DEFAULT_TITLE && !text.is_empty() {
        chat.meta.title = derive_title(&text);
    }
    chat.meta.updated_at = now_ms();
    let mut message = Message::new("user", &text, "complete");
    for image in images {
        let mime = image
            .data_url
            .split_once(':')
            .and_then(|(_, rest)| rest.split_once(';'))
            .map(|(mime, _)| mime.to_string())
            .unwrap_or_else(|| "image/png".to_string());
        let bytes = crate::store::base64_decode(&image.data_url)?;
        let attachment = state
            .store
            .save_image(&chat.meta.id, &mime, &bytes, image.width, image.height, Some("user"))?;
        message.attachments.push(attachment);
    }
    chat.messages.push(message);
    state.store.save(&mut chat)?;
    crate::turn::trace("send_message saved");
    state.sync.wake();
    crate::turn::trace("sync woken");

    turn::kick(state.inner().clone(), chat.meta.id.clone());
    // Analytics only: the request has already left, and a personal endpoint is
    // the one thing Hook's own metering never sees.
    if state.settings.custom_provider().is_some() && state.auth.required() {
        crate::analytics::track(state.inner(), "byok_turn");
    }
    crate::turn::trace("turn kicked");
    Ok(chat.meta.id)
}

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
                let _ = remote_rpc(
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
        remote_rpc(
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

async fn remote_rpc(
    state: &AppState,
    device_id: &str,
    method: &str,
    params: serde_json::Value,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    state
        .relay
        .rpc(device_id, method, params, timeout)
        .await
        .map_err(|failure| failure.message)
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
    let result = remote_rpc(
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
    remote_rpc(
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
/// as remote, so sync can never upload its messages.
#[tauri::command]
pub async fn create_remote_coding_chat(
    state: State<'_, Arc<AppState>>,
    device_id: String,
    project: String,
) -> Result<ChatMeta, String> {
    remote_ready(state.inner())?;
    if device_id == state.relay.device_id() {
        return Err("Use Coding agent… to start a chat on this computer.".into());
    }
    let name = require_host(state.inner(), &device_id)?;
    let result = remote_rpc(
        state.inner(),
        &device_id,
        "coding.create",
        serde_json::json!({ "project": project }),
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
    let result = remote_rpc(
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
        advanced_mode: state.settings.advanced_mode(),
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

#[tauri::command]
pub async fn set_projects_dir(
    state: State<'_, Arc<AppState>>,
    path: String,
) -> Result<SettingsView, String> {
    state.settings.set_projects_dir(&path)?;
    Ok(settings_view(&state))
}

/// Turn the debugging view on or off. The UI re-renders from the returned
/// settings, so the switch and the conversation can never disagree.
#[tauri::command]
pub fn set_advanced_mode(
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    state.settings.set_advanced_mode(enabled)?;
    Ok(settings_view(&state))
}

/// Save the user's own model endpoint for this product.
///
/// The key stays on this computer and is never uploaded: it belongs to this
/// product's `settings.json`, not the shared account file. A free account that
/// sets one may use coding agents and is not metered by Hook.
#[tauri::command]
pub fn set_custom_provider(
    state: State<'_, Arc<AppState>>,
    base_url: String,
    api_key: Option<String>,
    model: String,
) -> Result<SettingsView, String> {
    state
        .settings
        .set_custom_provider(&base_url, api_key.as_deref().unwrap_or(""), &model)?;
    let shared = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        refresh_capabilities(&shared).await;
    });
    crate::analytics::track(state.inner(), "byok_saved");
    Ok(settings_view(&state))
}

#[tauri::command]
pub fn clear_custom_provider(state: State<'_, Arc<AppState>>) -> Result<SettingsView, String> {
    state.settings.clear_custom_provider()?;
    let shared = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        refresh_capabilities(&shared).await;
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
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
    enabled: bool,
) -> Result<SettingsView, String> {
    let view = state.auth.set_cloud_sync(enabled).await?;
    emit_auth(&app, &view);
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

fn derive_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text);
    let cleaned = first_line
        .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace())
        .trim();
    let candidate = if cleaned.is_empty() { text } else { cleaned };
    crate::store::truncate(candidate, 72)
}
