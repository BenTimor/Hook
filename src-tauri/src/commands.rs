use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

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
    pub agents: Arc<AgentManager>,
    pub preview: Arc<PreviewManager>,
    pub streams: Arc<Mutex<HashMap<String, CancelToken>>>,
    pub turns: TurnState,
    /// The compiled-in harness config (provider, model, auth origin).
    pub cfg: Arc<config::HarnessConfig>,
    /// The signed-in account and its API token.
    pub auth: Arc<AuthStore>,
    /// Background conversation and project sync.
    pub sync: Arc<crate::sync::SyncEngine>,
    /// Whether the model can see images, taken from its `/models` card.
    pub vision: Arc<std::sync::atomic::AtomicBool>,
    /// Set when the endpoint rejects image parts anyway, so later turns stop
    /// trying. A card can promise more than the endpoint delivers.
    pub vision_off: Arc<std::sync::atomic::AtomicBool>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
}

#[tauri::command]
pub fn sync_status(state: State<'_, Arc<AppState>>) -> crate::sync::SyncView {
    state.sync.status()
}

/// Run a sync cycle now instead of waiting for the next tick.
#[tauri::command]
pub fn sync_now(state: State<'_, Arc<AppState>>) {
    state.sync.wake();
}

#[tauri::command]
pub fn app_info() -> Result<AppInfo, String> {
    // Validate the embedded config up front so a broken build fails loudly here
    // instead of on the first message.
    config::get()?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
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
    for token in lock(&state.streams).values() {
        token.cancel();
    }
    lock(&state.streams).clear();
}

/// Ask the model card what it can see. Called at launch, after sign-in and on
/// window reload. A provider without `/models` simply reports nothing.
pub async fn refresh_capabilities(state: &Arc<AppState>) {
    let Some(token) = state.auth.token() else {
        state.vision.store(false, std::sync::atomic::Ordering::Relaxed);
        return;
    };
    let caps = crate::provider::fetch_capabilities(&state.cfg, &token).await;
    if !caps.known {
        eprintln!("hook: no model card at the provider; capabilities unknown");
        return;
    }
    eprintln!(
        "hook: model {} capabilities from /models: vision={}",
        state.cfg.model.name, caps.vision
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
pub fn rename_chat(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    title: String,
) -> Result<ChatMeta, String> {
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
pub fn send_message(
    state: State<'_, Arc<AppState>>,
    chat_id: Option<String>,
    text: String,
    images: Option<Vec<IncomingImage>>,
) -> Result<String, String> {
    let text = text.trim().to_string();
    let images = images.unwrap_or_default();
    if text.is_empty() && images.is_empty() {
        return Err("Message is empty".into());
    }

    let mut chat = match chat_id {
        Some(id) => state.store.load(&id)?,
        None => Chat::new(),
    };
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
    state.sync.wake();

    turn::kick(state.inner().clone(), chat.meta.id.clone());
    Ok(chat.meta.id)
}

#[tauri::command]
pub fn regenerate(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    let mut chat = state.store.load(&chat_id)?;
    if state.turns.is_busy(&chat_id) {
        return Err("A reply is already streaming in this chat.".into());
    }

    let Some(last) = chat.messages.iter().rposition(|m| m.role == "assistant") else {
        return Err("Nothing to regenerate yet.".into());
    };
    chat.messages.truncate(last);
    // Drop any tool traffic that belonged to the removed reply.
    while chat
        .messages
        .last()
        .map(|m| m.role == "tool" || (m.hidden && m.role == "assistant"))
        .unwrap_or(false)
    {
        chat.messages.pop();
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
    if state.turns.is_busy(&chat_id) {
        return Err("A reply is already streaming in this chat.".into());
    }

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
pub fn stop_stream(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    let token = lock(&state.streams).get(&chat_id).cloned();
    if let Some(token) = token {
        token.cancel();
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub projects_dir: String,
    pub projects: Vec<Project>,
}

fn settings_view(state: &AppState) -> SettingsView {
    let projects_dir = state.settings.projects_dir();
    let projects = state.projects.list(&projects_dir).unwrap_or_default();
    SettingsView {
        projects_dir: projects_dir.to_string_lossy().to_string(),
        projects,
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
    use super::copy_image;

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
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn agents_overview(state: State<'_, Arc<AppState>>) -> crate::agent::Overview {
    state.agents.overview()
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
    crate::update::check(&state.cfg).await
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

/// Open the Microsoft Store's update surface for a packaged (MSIX) build.
#[tauri::command]
pub fn open_store_update(state: State<'_, Arc<AppState>>) -> Result<(), String> {
    crate::update::open_store(&state.cfg)
}

/// Download the newest installer, verify it, launch it and exit Hook. The
/// installer replaces this build and starts it again.
#[tauri::command]
pub async fn install_update(
    app: AppHandle,
    state: State<'_, Arc<AppState>>,
) -> Result<(), String> {
    crate::update::install(&app, &state.cfg, state.auth.token()).await
}

fn derive_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text);
    let cleaned = first_line
        .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace())
        .trim();
    let candidate = if cleaned.is_empty() { text } else { cleaned };
    crate::store::truncate(candidate, 72)
}
