use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::agent::AgentManager;
use crate::config;
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
    pub streams: Arc<Mutex<HashMap<String, CancelToken>>>,
    pub turns: TurnState,
    /// Set when the endpoint rejects image parts, so later turns stop trying.
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
pub fn app_info() -> Result<AppInfo, String> {
    // Validate the embedded config up front so a broken build fails loudly here
    // instead of on the first message.
    config::get()?;
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
    })
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
    state.store.rename(&chat_id, &title)
}

#[tauri::command]
pub fn set_pinned(
    state: State<'_, Arc<AppState>>,
    chat_id: String,
    pinned: bool,
) -> Result<ChatMeta, String> {
    state.store.set_pinned(&chat_id, pinned)
}

#[tauri::command]
pub fn delete_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<(), String> {
    for agent in state.agents.list() {
        if agent.chat_id == chat_id && agent.is_live() {
            let _ = state.agents.stop(&agent.id);
        }
    }
    state.store.delete(&chat_id)
}

#[tauri::command]
pub fn restore_chat(state: State<'_, Arc<AppState>>, chat_id: String) -> Result<ChatMeta, String> {
    state.store.restore(&chat_id)
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

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    tauri_plugin_opener::reveal_item_in_dir(&path).map_err(|e| e.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentsOverview {
    pub working: usize,
    pub live: usize,
}

#[tauri::command]
pub fn agents_overview(state: State<'_, Arc<AppState>>) -> AgentsOverview {
    AgentsOverview {
        working: state.agents.working_count(),
        live: state.agents.live_count(),
    }
}

fn derive_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text);
    let cleaned = first_line
        .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace())
        .trim();
    let candidate = if cleaned.is_empty() { text } else { cleaned };
    crate::store::truncate(candidate, 72)
}
