use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::config;
use crate::provider::{self, CancelToken, Chunk, Outcome};
use crate::store::{now_ms, Chat, ChatMeta, Message, SearchHit, Store, DEFAULT_TITLE};

pub struct AppState {
    pub store: Arc<Store>,
    pub streams: Arc<Mutex<HashMap<String, CancelToken>>>,
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

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum StreamEvent {
    Started {
        messages: Vec<Message>,
        meta: ChatMeta,
    },
    Delta {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Done {
        messages: Vec<Message>,
        meta: ChatMeta,
    },
    Error {
        message: String,
        messages: Vec<Message>,
        meta: ChatMeta,
    },
}

#[tauri::command]
pub fn list_chats(state: State<'_, AppState>) -> Result<Vec<ChatMeta>, String> {
    state.store.list()
}

#[tauri::command]
pub fn get_chat(state: State<'_, AppState>, chat_id: String) -> Result<Chat, String> {
    state.store.load(&chat_id)
}

#[tauri::command]
pub fn rename_chat(
    state: State<'_, AppState>,
    chat_id: String,
    title: String,
) -> Result<ChatMeta, String> {
    state.store.rename(&chat_id, &title)
}

#[tauri::command]
pub fn set_pinned(
    state: State<'_, AppState>,
    chat_id: String,
    pinned: bool,
) -> Result<ChatMeta, String> {
    state.store.set_pinned(&chat_id, pinned)
}

#[tauri::command]
pub fn delete_chat(state: State<'_, AppState>, chat_id: String) -> Result<(), String> {
    state.store.delete(&chat_id)
}

#[tauri::command]
pub fn restore_chat(state: State<'_, AppState>, chat_id: String) -> Result<ChatMeta, String> {
    state.store.restore(&chat_id)
}

#[tauri::command]
pub fn search_chats(state: State<'_, AppState>, query: String) -> Result<Vec<SearchHit>, String> {
    state.store.search(&query)
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    chat_id: Option<String>,
    text: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let cfg = config::get()?.clone();

    let mut chat = match chat_id {
        Some(id) => state.store.load(&id)?,
        None => Chat::new(),
    };
    if chat.messages.iter().any(|m| m.status == "streaming") {
        return Err("A reply is already streaming in this chat.".into());
    }

    if chat.messages.is_empty() && chat.meta.title == DEFAULT_TITLE {
        chat.meta.title = derive_title(&text);
    }
    chat.meta.updated_at = now_ms();

    let user = Message::new("user", &text, "complete");
    let assistant = Message::new("assistant", "", "streaming");
    let assistant_id = assistant.id.clone();
    chat.messages.push(user);
    chat.messages.push(assistant);

    state.store.save(&mut chat)?;
    let history = build_history(&chat, &assistant_id);

    let _ = channel.send(StreamEvent::Started {
        messages: chat.messages.clone(),
        meta: chat.meta.clone(),
    });

    spawn_stream(
        &state,
        cfg,
        channel,
        chat.meta.id.clone(),
        assistant_id,
        history,
    );
    Ok(())
}

#[tauri::command]
pub async fn regenerate(
    state: State<'_, AppState>,
    chat_id: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let cfg = config::get()?.clone();
    let mut chat = state.store.load(&chat_id)?;

    if let Some(last) = chat.messages.iter().rposition(|m| m.role == "assistant") {
        chat.messages.truncate(last);
    } else {
        return Err("Nothing to regenerate yet.".into());
    }
    if !chat.messages.iter().any(|m| m.role == "user") {
        return Err("Nothing to regenerate yet.".into());
    }

    let assistant = Message::new("assistant", "", "streaming");
    let assistant_id = assistant.id.clone();
    chat.messages.push(assistant);
    chat.meta.updated_at = now_ms();

    state.store.save(&mut chat)?;
    let history = build_history(&chat, &assistant_id);

    let _ = channel.send(StreamEvent::Started {
        messages: chat.messages.clone(),
        meta: chat.meta.clone(),
    });

    spawn_stream(&state, cfg, channel, chat_id, assistant_id, history);
    Ok(())
}

#[tauri::command]
pub async fn edit_message(
    state: State<'_, AppState>,
    chat_id: String,
    message_id: String,
    text: String,
    channel: Channel<StreamEvent>,
) -> Result<(), String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let cfg = config::get()?.clone();
    let mut chat = state.store.load(&chat_id)?;

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

    let assistant = Message::new("assistant", "", "streaming");
    let assistant_id = assistant.id.clone();
    chat.messages.push(assistant);
    chat.meta.updated_at = now_ms();

    state.store.save(&mut chat)?;
    let history = build_history(&chat, &assistant_id);

    let _ = channel.send(StreamEvent::Started {
        messages: chat.messages.clone(),
        meta: chat.meta.clone(),
    });

    spawn_stream(&state, cfg, channel, chat_id, assistant_id, history);
    Ok(())
}

#[tauri::command]
pub fn stop_stream(state: State<'_, AppState>, chat_id: String) -> Result<(), String> {
    let streams = lock(&state.streams);
    if let Some(token) = streams.get(&chat_id) {
        token.cancel();
    }
    Ok(())
}

fn spawn_stream(
    state: &State<'_, AppState>,
    cfg: config::HarnessConfig,
    channel: Channel<StreamEvent>,
    chat_id: String,
    assistant_id: String,
    history: Vec<serde_json::Value>,
) {
    let store = state.store.clone();
    let streams = state.streams.clone();
    let cancel = CancelToken::new();
    lock(&streams).insert(chat_id.clone(), cancel.clone());

    tauri::async_runtime::spawn(async move {
        let mut content = String::new();
        let mut reasoning = String::new();
        let delta_channel = channel.clone();

        let result = provider::stream_chat(&cfg, &history, cancel, |chunk| match chunk {
            Chunk::Text(text) => {
                content.push_str(&text);
                let _ = delta_channel.send(StreamEvent::Delta { text });
            }
            Chunk::Reasoning(text) => {
                reasoning.push_str(&text);
                let _ = delta_channel.send(StreamEvent::Reasoning { text });
            }
        })
        .await;

        lock(&streams).remove(&chat_id);

        let Ok(mut chat) = store.load(&chat_id) else {
            return;
        };
        let Some(index) = chat.messages.iter().position(|m| m.id == assistant_id) else {
            return;
        };

        let event = match result {
            Ok(Outcome::Completed(usage)) => {
                let message = &mut chat.messages[index];
                message.content = content;
                message.reasoning = if reasoning.is_empty() { None } else { Some(reasoning) };
                message.status = "complete".to_string();
                message.usage = usage;
                chat.meta.updated_at = now_ms();
                let _ = store.save(&mut chat);
                StreamEvent::Done {
                    messages: chat.messages.clone(),
                    meta: chat.meta.clone(),
                }
            }
            Ok(Outcome::Cancelled) => {
                let message = &mut chat.messages[index];
                message.content = content;
                message.reasoning = if reasoning.is_empty() { None } else { Some(reasoning) };
                message.status = "aborted".to_string();
                chat.meta.updated_at = now_ms();
                let _ = store.save(&mut chat);
                StreamEvent::Done {
                    messages: chat.messages.clone(),
                    meta: chat.meta.clone(),
                }
            }
            Err(err) => {
                let message = &mut chat.messages[index];
                message.content = content;
                message.reasoning = if reasoning.is_empty() { None } else { Some(reasoning) };
                message.status = "error".to_string();
                message.error = Some(err.clone());
                chat.meta.updated_at = now_ms();
                let _ = store.save(&mut chat);
                StreamEvent::Error {
                    message: err,
                    messages: chat.messages.clone(),
                    meta: chat.meta.clone(),
                }
            }
        };

        let _ = channel.send(event);
    });
}

fn build_history(chat: &Chat, exclude_id: &str) -> Vec<serde_json::Value> {
    chat.messages
        .iter()
        .filter(|m| m.id != exclude_id)
        .filter(|m| m.status != "error" && m.status != "aborted")
        .filter(|m| !m.content.trim().is_empty())
        .map(|m| {
            serde_json::json!({
                "role": m.role,
                "content": m.content,
            })
        })
        .collect()
}

fn derive_title(text: &str) -> String {
    let first_line = text.lines().next().unwrap_or(text);
    let cleaned = first_line
        .trim_start_matches(|c: char| c == '#' || c == '-' || c == '*' || c.is_whitespace())
        .trim();
    let candidate = if cleaned.is_empty() { text } else { cleaned };
    crate::store::truncate(candidate, 72)
}
