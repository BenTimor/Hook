//! The conversation the user has with a coding agent directly.
//!
//! An ordinary chat is a model turn: `turn.rs` asks the provider, runs Hook's
//! tools and writes the reply. A *coding-agent chat* is the same window around
//! a different engine — `pi` runs in the folder the user picked and they talk to
//! it themselves. No chat agent briefs it, relays it or answers for it.
//!
//! That is why this module exists rather than a second chat UI: the records pi
//! already emits over RPC (`message_start`, `message_update`, `message_end`,
//! `tool_execution_end`, `agent_settled`) are turned back into the very messages
//! the thread, the work blocks, the task board and the preview panel already
//! draw. A direct conversation therefore gets thinking, tool calls, the plan and
//! the preview for free, and `packages/chat` never learns that `pi` exists.
//!
//! The user's own messages, the assistant's answers and the tool results all
//! live in the chat file, so reopening the window shows the conversation and a
//! restart resumes the same pi session (`meta.sessionId`).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use serde_json::Value;

use crate::agent::{AgentInfo, Picture, STATE_NEEDS_INPUT};
use crate::state::AppState;
use crate::store::{
    now_ms, strip_verbatim, Attachment, Chat, ChatMeta, Compaction, IncomingImage, Message, Store,
    ToolCallRecord, KIND_CODING,
};
use crate::turn::{self, StreamEvent};

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The assistant message a running agent is still writing, per chat.
///
/// Kept here rather than in the chat file: a message that is mid-stream is only
/// meaningful to this process, and the file already says `streaming` if the
/// window dies.
#[derive(Default)]
pub struct CodingState {
    live: Mutex<HashMap<String, String>>,
}

impl CodingState {
    fn begin(&self, chat_id: &str, message_id: &str) {
        lock(&self.live).insert(chat_id.to_string(), message_id.to_string());
    }

    fn take(&self, chat_id: &str) -> Option<String> {
        lock(&self.live).remove(chat_id)
    }

    fn peek(&self, chat_id: &str) -> Option<String> {
        lock(&self.live).get(chat_id).cloned()
    }
}

/// True for a chat the user drives as a coding agent.
pub fn is_coding(chat: &Chat) -> bool {
    chat.meta.kind.as_deref() == Some(KIND_CODING)
}

/// Create the conversation before the user has said anything. The folder is the
/// whole setup: `pi` starts on the first message, so a chat that is opened and
/// left alone costs nothing.
pub fn create(state: &Arc<AppState>, folder: &str) -> Result<ChatMeta, String> {
    // Advanced mode is the door to everything the coding engine does; the
    // command refuses even if a stale window still shows the option. A remote
    // create skips this: the controller's paid, sync-enabled account and the
    // host's accept-remote-work switch are the door on that side.
    if !state.advanced_mode() {
        return Err("Coding agents are part of advanced mode.".into());
    }
    // A free account has no coding agents unless it brought its own endpoint.
    if state.auth.is_free() && state.settings.custom_provider().is_none() {
        crate::analytics::track(state, "coding_blocked_free");
        return Err(
            "Coding agents are part of a paid plan. Add your own model provider in Settings to use one."
                .into(),
        );
    }
    create_at(state, folder)
}

/// Create a direct coding chat for a controller. The host owns the folder, the
/// engine and the session; the caller only names a project it can already see.
pub fn create_on_host(state: &Arc<AppState>, folder: &str) -> Result<ChatMeta, String> {
    if state.auth.is_free() && state.settings.custom_provider().is_none() {
        crate::analytics::track(state, "coding_blocked_free");
        return Err(
            "Coding agents are part of a paid plan. Add your own model provider in Settings to use one."
                .into(),
        );
    }
    create_at(state, folder)
}

fn create_at(state: &Arc<AppState>, folder: &str) -> Result<ChatMeta, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder for the coding agent.".into());
    }
    let path = std::path::PathBuf::from(folder)
        .canonicalize()
        .map_err(|_| format!("The folder \"{folder}\" is not available."))?;
    if !path.is_dir() {
        return Err(format!("\"{folder}\" is not a folder."));
    }
    let mut chat = Chat::new_coding(&strip_verbatim(path));
    chat.meta.device_id = Some(state.agents.device_id());
    chat.meta.device_name = Some(state.agents.device_name());
    state.store.save(&mut chat)?;
    state.sync.wake();
    Ok(chat.meta)
}

/// Point an existing coding chat at a different folder. The pi session is
/// dropped: it belongs to the folder it was started in.
pub fn set_folder(state: &Arc<AppState>, chat_id: &str, folder: &str) -> Result<ChatMeta, String> {
    let folder = folder.trim();
    if folder.is_empty() {
        return Err("Choose a folder for the coding agent.".into());
    }
    let path = std::path::PathBuf::from(folder)
        .canonicalize()
        .map_err(|_| format!("The folder \"{folder}\" is not available."))?;
    if !path.is_dir() {
        return Err(format!("\"{folder}\" is not a folder."));
    }
    let mut chat = state.store.load(chat_id)?;
    if !is_coding(&chat) {
        return Err("This conversation is not a coding agent.".into());
    }
    chat.meta.project_path = Some(strip_verbatim(path).to_string_lossy().to_string());
    chat.meta.session_id = None;
    chat.meta.updated_at = now_ms();
    state.store.save(&mut chat)?;
    state.sync.wake();
    Ok(chat.meta)
}

/// Turn any reply left streaming by a window that died into the error it was.
///
/// Without this, a crash mid-run leaves a reply that spins forever: nothing is
/// left to finish it.
pub fn recover(store: &Store) {
    let Ok(metas) = store.list() else {
        return;
    };
    for meta in metas.into_iter().filter(|meta| meta.is_coding()) {
        let Ok(mut chat) = store.load(&meta.id) else {
            continue;
        };
        let mut changed = false;
        for message in chat.messages.iter_mut() {
            if message.role == "assistant" && message.status == "streaming" {
                message.status = "error".into();
                message.error = Some(
                    "Hook closed while the coding agent was working. Say something to pick it up."
                        .into(),
                );
                changed = true;
            }
        }
        if changed {
            chat.meta.updated_at = now_ms();
            let _ = store.save(&mut chat);
        }
    }
}

/// Send one message from the user: start the agent, steer it, or answer the
/// question it is blocked on.
///
/// The message is written before the engine is touched, so the conversation
/// always shows what was asked even when the agent cannot start.
pub fn send(
    state: &Arc<AppState>,
    chat: &mut Chat,
    text: &str,
    images: &[IncomingImage],
) -> Result<(), String> {
    send_with_id(state, chat, text, images, None)
}

/// The same send, with a caller-chosen message id. A controller generates the
/// id so the user's message looks identical on both sides of the relay.
pub fn send_with_id(
    state: &Arc<AppState>,
    chat: &mut Chat,
    text: &str,
    images: &[IncomingImage],
    message_id: Option<&str>,
) -> Result<(), String> {
    let Some(folder) = chat.meta.project_path.clone() else {
        return Err("This coding agent has no folder. Choose one first.".into());
    };

    // A question is a dialog with options, not a message: a picture has nowhere
    // to go in the answer, and dropping it silently is worse than saying so.
    if !images.is_empty() {
        if let Some(info) = state.agents.for_chat(&chat.meta.id) {
            if info.is_live() && info.state == STATE_NEEDS_INPUT {
                return Err(
                    "That agent is waiting for an answer to a question. Answer it first, then send the picture."
                        .into(),
                );
            }
        }
    }

    // The pictures are stored first: the engine can fail to start, and the
    // conversation still has to show what the user sent it.
    let stored = state.store.save_incoming(&chat.meta.id, images)?;
    let pictures: Vec<Picture> = stored
        .iter()
        .map(|(attachment, bytes)| Picture::new(attachment.mime.clone(), bytes.clone()))
        .collect();

    let mut message = Message::new("user", text, "complete");
    message.attachments = stored
        .into_iter()
        .map(|(attachment, _)| attachment)
        .collect::<Vec<Attachment>>();
    if let Some(id) = message_id.map(str::trim).filter(|id| !id.is_empty()) {
        message.id = id.to_string();
    }
    // A retry after a lost answer must not add the same message twice.
    if !chat.messages.iter().any(|m| m.id == message.id) {
        chat.messages.push(message);
    }
    chat.meta.updated_at = now_ms();
    state.store.save(chat)?;
    emit_started(state, chat);

    let existing = state.agents.for_chat(&chat.meta.id);
    let result = match existing.as_ref() {
        Some(info) if info.is_live() => {
            if info.state == STATE_NEEDS_INPUT {
                state.agents.answer(&info.id, text)
            } else {
                state.agents.steer(&info.id, text, &pictures)
            }
        }
        _ => start(state, chat, text, &pictures, &folder),
    };

    match result {
        // The agent's records finish the turn from here.
        Ok(_) => {
            state.sync.wake();
            Ok(())
        }
        // The engine closed between the check and the write: resume the session
        // rather than losing what the user typed.
        Err(error) if existing.is_some() => match start(state, chat, text, &pictures, &folder) {
            Ok(_) => {
                state.sync.wake();
                Ok(())
            }
            Err(retry) => fail(state, chat, &format!("{error} ({retry})")),
        },
        Err(error) => fail(state, chat, &error),
    }
}

/// Fold this conversation's older turns into a summary.
///
/// pi owns the transcript, so this is pi's own compaction: a live agent is asked
/// over RPC, and a settled one (or one whose process is gone) is started again
/// on its session just to compact it. The summary pi writes is shown in advanced
/// mode when the `compaction_end` record arrives.
pub fn compact(
    state: &Arc<AppState>,
    chat: &Chat,
    instructions: Option<&str>,
) -> Result<(), String> {
    let Some(folder) = chat.meta.project_path.clone() else {
        return Err("This coding agent has no folder. Choose one first.".into());
    };
    match state.agents.for_chat(&chat.meta.id) {
        Some(info) if info.is_live() => {
            state.agents.compact(&info.id, instructions)?;
        }
        _ => {
            state.agents.start_compact(
                &chat.meta.id,
                &folder,
                Some(chat.meta.title.as_str()),
                chat.meta.session_id.as_deref(),
                instructions,
            )?;
        }
    }
    // The engine's own records take it from here; this is what the window says
    // while the summary is being written.
    turn::emit(
        state,
        &chat.meta.id,
        StreamEvent::Activity {
            label: Some("Compacting the conversation…".into()),
        },
    );
    state.sync.wake();
    Ok(())
}

fn start(
    state: &Arc<AppState>,
    chat: &mut Chat,
    text: &str,
    pictures: &[Picture],
    folder: &str,
) -> Result<AgentInfo, String> {
    let info = state.agents.start_direct(
        &chat.meta.id,
        folder,
        text,
        pictures,
        Some(&chat.meta.title),
        chat.meta.session_id.as_deref(),
    )?;
    // The session is what a restart continues; it is local, like the folder.
    if chat.meta.session_id.as_deref() != Some(info.session_id.as_str()) {
        chat.meta.session_id = Some(info.session_id.clone());
        chat.meta.updated_at = now_ms();
        let _ = state.store.save(chat);
    }
    Ok(info)
}

/// Stop the run in this conversation. The Stop button means the whole tree, and
/// the chat has to say so even when the engine never answers the abort.
pub fn stop(state: &Arc<AppState>, chat_id: &str) {
    if let Some(info) = state.agents.for_chat(chat_id) {
        if info.is_live() {
            let _ = state.agents.stop(&info.id);
        }
    }
    close(state, chat_id, "aborted");
}

/// Answer the question a direct agent is blocked on, from the task board.
pub fn answer(state: &Arc<AppState>, chat_id: &str, answer: &str) -> Result<(), String> {
    let info = state
        .agents
        .for_chat(chat_id)
        .ok_or("That coding agent is not running.")?;
    if info.question.is_none() {
        return Err("That coding agent is not asking anything right now.".into());
    }
    state.agents.answer(&info.id, answer)?;
    Ok(())
}

/// The chat-side half of a stop: whatever is still streaming becomes "Stopped".
pub fn close(state: &Arc<AppState>, chat_id: &str, status: &str) {
    let Ok(mut chat) = state.store.load(chat_id) else {
        return;
    };
    let live = state.coding.take(chat_id);
    let mut changed = false;
    for message in chat.messages.iter_mut() {
        let target = match &live {
            Some(id) => message.id == *id,
            None => message.role == "assistant" && message.status == "streaming",
        };
        if target && message.status == "streaming" {
            message.status = status.to_string();
            changed = true;
        }
    }
    if changed {
        chat.meta.updated_at = now_ms();
        let _ = state.store.save(&mut chat);
    }
    state.sync.wake();
    turn::emit(state, chat_id, StreamEvent::Activity { label: None });
    turn::emit(
        state,
        chat_id,
        StreamEvent::Done {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
}

fn fail(state: &Arc<AppState>, chat: &mut Chat, error: &str) -> Result<(), String> {
    let mut message = Message::new("assistant", "", "error");
    message.error = Some(error.to_string());
    chat.messages.push(message);
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(chat);
    state.sync.wake();
    turn::emit(state, &chat.meta.id, StreamEvent::Activity { label: None });
    turn::emit(
        state,
        &chat.meta.id,
        StreamEvent::Error {
            message: error.to_string(),
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
    Ok(())
}

/// One RPC record from a directly-driven agent.
pub fn on_record(state: &Arc<AppState>, chat_id: &str, agent_id: &str, record: &Value) {
    let kind = record.get("type").and_then(Value::as_str).unwrap_or("");
    match kind {
        "message_start" => {
            // Only the assistant speaks here: the prompt is already in the chat
            // as the user's own message.
            if role_of(record.get("message")) == Some("assistant") {
                open_message(state, chat_id);
            }
        }
        "message_update" => {
            if let Some(event) = record.get("assistantMessageEvent") {
                stream_delta(state, chat_id, event);
            }
        }
        "message_end" => close_message(state, chat_id, record),
        "tool_execution_start" => {
            let tool = record
                .get("toolName")
                .and_then(Value::as_str)
                .unwrap_or("tool");
            let args = record
                .get("args")
                .map(Value::to_string)
                .unwrap_or_else(|| "{}".to_string());
            if let Some(label) = turn::activity_label(tool, &args) {
                turn::emit(
                    state,
                    chat_id,
                    StreamEvent::Activity {
                        label: Some(label),
                    },
                );
            }
        }
        "tool_execution_end" => tool_result(state, chat_id, record),
        "compaction_start" => {
            turn::emit(
                state,
                chat_id,
                StreamEvent::Activity {
                    label: Some("Compacting the conversation…".into()),
                },
            );
        }
        "compaction_end" => compaction_end(state, chat_id, record),
        "agent_settled" => {
            // Everything pi wrote is in the chat by now.
            let info = state.agents.get(agent_id);
            match info {
                Some(info) if info.error.is_some() && !already_reported(state, chat_id) => {
                    close(state, chat_id, "complete");
                    let error = info.error.unwrap_or_default();
                    let Ok(mut chat) = state.store.load(chat_id) else {
                        return;
                    };
                    let _ = fail(state, &mut chat, &error);
                }
                _ => close(state, chat_id, "complete"),
            }
        }
        "agent_exit" => {
            // The process is gone: whatever it left streaming is over, and a
            // crash still has to reach the user.
            let info = state.agents.get(agent_id);
            close(state, chat_id, "complete");
            if let Some(info) = info {
                if info.error.is_some() && !already_reported(state, chat_id) {
                    let error = info.error.unwrap_or_default();
                    let Ok(mut chat) = state.store.load(chat_id) else {
                        return;
                    };
                    let _ = fail(state, &mut chat, &error);
                }
            }
        }
        _ => {}
    }
}

/// pi finished (or failed) a compaction. A manual one is its own turn and ends
/// the conversation's activity; an automatic one happens inside a run that is
/// still going, so it must not emit a `Done` of its own.
fn compaction_end(state: &Arc<AppState>, chat_id: &str, record: &Value) {
    let manual = record.get("reason").and_then(Value::as_str) == Some("manual");
    if let Some(error) = record
        .get("errorMessage")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|error| !error.is_empty())
    {
        if manual {
            close(state, chat_id, "complete");
            if let Ok(mut chat) = state.store.load(chat_id) {
                let _ = fail(state, &mut chat, error);
            }
        }
        return;
    }
    let Some(result) = record.get("result") else {
        return;
    };
    let summary = result
        .get("summary")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if summary.is_empty() {
        return;
    }
    let Ok(mut chat) = state.store.load(chat_id) else {
        return;
    };
    let mut message = Message::compaction(&summary);
    message.compaction = Some(Compaction {
        // pi keeps the transcript; it counts tokens, not Hook's messages.
        messages: 0,
        tokens_before: result.get("tokensBefore").and_then(Value::as_u64).unwrap_or(0),
        tokens_after: result
            .get("estimatedTokensAfter")
            .and_then(Value::as_u64)
            .unwrap_or(0),
    });
    chat.messages.push(message);
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(&mut chat);
    if manual {
        close(state, chat_id, "complete");
    }
}

fn role_of(message: Option<&Value>) -> Option<&str> {
    message?.get("role").and_then(Value::as_str)
}

/// The chat already ends with an error the agent reported; do not repeat it.
fn already_reported(state: &Arc<AppState>, chat_id: &str) -> bool {
    state
        .store
        .load(chat_id)
        .ok()
        .and_then(|chat| {
            chat.messages
                .iter()
                .rev()
                .find(|message| message.error.is_some())
                .map(|message| message.status == "error")
        })
        .unwrap_or(false)
}

fn emit_started(state: &Arc<AppState>, chat: &Chat) {
    turn::emit(
        state,
        &chat.meta.id,
        StreamEvent::Started {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
}

/// A new assistant message begins streaming. `pi` may emit several of these in
/// one turn (one per tool round), exactly like the chat agent's own turn, and
/// the thread folds them into one work block.
fn open_message(state: &Arc<AppState>, chat_id: &str) {
    let Ok(mut chat) = state.store.load(chat_id) else {
        return;
    };
    // A previous message that never ended is closed with what it has: this one
    // takes over the stream.
    finish_open(state, &mut chat);
    let message = Message::new("assistant", "", "streaming");
    let id = message.id.clone();
    chat.messages.push(message);
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(&mut chat);
    state.coding.begin(chat_id, &id);
    emit_started(state, &chat);
}

/// Thinking and answer text as it arrives. The engine also sends the
/// authoritative block at the end of each one; those are ignored here because
/// the store would otherwise show the text twice, and `message_end` replaces
/// whatever was accumulated anyway.
fn stream_delta(state: &Arc<AppState>, chat_id: &str, event: &Value) {
    let kind = event.get("type").and_then(Value::as_str).unwrap_or("");
    let delta = event.get("delta").and_then(Value::as_str).unwrap_or("");
    if delta.is_empty() {
        return;
    }
    // `pi` starts a message before it writes to it, but a provider that streams
    // a delta first must not lose it.
    if state.coding.peek(chat_id).is_none() {
        open_message(state, chat_id);
    }
    match kind {
        "thinking_delta" => turn::emit(
            state,
            chat_id,
            StreamEvent::Reasoning {
                text: delta.to_string(),
            },
        ),
        "text_delta" => turn::emit(
            state,
            chat_id,
            StreamEvent::Delta {
                text: delta.to_string(),
            },
        ),
        _ => {}
    }
}

/// The assistant message is complete: take the engine's own copy (text,
/// thinking and the tool calls it made) instead of the accumulated deltas.
fn close_message(state: &Arc<AppState>, chat_id: &str, record: &Value) {
    let Some(message) = record.get("message") else {
        return;
    };
    if role_of(Some(message)) != Some("assistant") {
        return;
    }
    let (text, reasoning, calls) = assistant_parts(message);
    let stop = message
        .get("stopReason")
        .and_then(Value::as_str)
        .unwrap_or("");
    let error = message.get("errorMessage").and_then(Value::as_str);

    let Ok(mut chat) = state.store.load(chat_id) else {
        return;
    };
    let id = state.coding.take(chat_id).or_else(|| {
        chat.messages
            .iter()
            .rev()
            .find(|entry| entry.role == "assistant" && entry.status == "streaming")
            .map(|entry| entry.id.clone())
    });
    let index = match id {
        Some(id) => chat.messages.iter().position(|entry| entry.id == id),
        None => None,
    };
    let Some(index) = index else {
        return;
    };

    if text.trim().is_empty() && reasoning.is_none() && calls.is_none() && error.is_none() {
        // A turn that produced nothing at all is not worth a bubble.
        chat.messages.remove(index);
    } else {
        let entry = &mut chat.messages[index];
        entry.content = text;
        entry.reasoning = reasoning;
        entry.tool_calls = calls;
        entry.status = match stop {
            "aborted" => "aborted".into(),
            "error" => "error".into(),
            _ => "complete".into(),
        };
        if error.is_some() {
            entry.status = "error".into();
            entry.error = error.map(str::to_string);
        }
    }
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(&mut chat);
    turn::emit(
        state,
        chat_id,
        StreamEvent::Done {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
}

/// One tool call finished: its output becomes a `tool` message the work block
/// draws under the call that asked for it.
fn tool_result(state: &Arc<AppState>, chat_id: &str, record: &Value) {
    let call_id = record
        .get("toolCallId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if call_id.is_empty() {
        return;
    }
    let output = record
        .get("result")
        .map(text_of)
        .unwrap_or_default();
    let failed = record
        .get("isError")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let output = if failed && !output.trim().is_empty() {
        output
    } else if failed {
        "The tool failed.".to_string()
    } else {
        output
    };

    let Ok(mut chat) = state.store.load(chat_id) else {
        return;
    };
    match chat
        .messages
        .iter_mut()
        .find(|entry| entry.role == "tool" && entry.tool_call_id.as_deref() == Some(&call_id))
    {
        Some(entry) => entry.content = output,
        None => {
            let mut message = Message::new("tool", &output, "complete");
            message.tool_call_id = Some(call_id);
            // Internal bookkeeping, like the chat agent's own tool results:
            // the work block reads it, search and the preview do not.
            message.hidden = true;
            chat.messages.push(message);
        }
    }
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(&mut chat);
    turn::emit(
        state,
        chat_id,
        StreamEvent::Done {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
}

/// Close the message the run is still writing, if any. Called when a new one
/// starts and when the chat is finally closed.
fn finish_open(state: &Arc<AppState>, chat: &mut Chat) {
    let Some(id) = state.coding.take(&chat.meta.id) else {
        return;
    };
    let Some(index) = chat.messages.iter().position(|entry| entry.id == id) else {
        return;
    };
    let empty = {
        let entry = &chat.messages[index];
        entry.content.trim().is_empty()
            && entry.reasoning.is_none()
            && entry.tool_calls.is_none()
    };
    if empty {
        chat.messages.remove(index);
        return;
    }
    if chat.messages[index].status == "streaming" {
        chat.messages[index].status = "complete".into();
    }
}

/// A pi assistant message → the fields a chat message keeps.
///
/// Thinking becomes `reasoning` (the same place the provider's reasoning goes),
/// text becomes the content, and each tool call becomes a `ToolCallRecord` with
/// its parsed arguments as JSON — which is what the work block already knows how
/// to draw.
fn assistant_parts(message: &Value) -> (String, Option<String>, Option<Vec<ToolCallRecord>>) {
    let mut text = String::new();
    let mut thinking = String::new();
    let mut calls: Vec<ToolCallRecord> = Vec::new();
    if let Some(blocks) = message.get("content").and_then(Value::as_array) {
        for block in blocks {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "text" => {
                    if let Some(part) = block.get("text").and_then(Value::as_str) {
                        text.push_str(part);
                    }
                }
                "thinking" => {
                    if let Some(part) = block.get("thinking").and_then(Value::as_str) {
                        if !thinking.is_empty() {
                            thinking.push('\n');
                        }
                        thinking.push_str(part);
                    }
                }
                "toolCall" => {
                    let id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_string();
                    let name = block
                        .get("name")
                        .and_then(Value::as_str)
                        .unwrap_or("tool")
                        .to_string();
                    let arguments = block
                        .get("arguments")
                        .map(Value::to_string)
                        .unwrap_or_else(|| "{}".to_string());
                    calls.push(ToolCallRecord {
                        id,
                        name,
                        arguments,
                    });
                }
                _ => {}
            }
        }
    }
    let reasoning = if thinking.trim().is_empty() {
        None
    } else {
        Some(thinking)
    };
    let calls = if calls.is_empty() { None } else { Some(calls) };
    (text, reasoning, calls)
}

/// The text of a tool result, whether it is a string or `{content: [...]}`.
fn text_of(value: &Value) -> String {
    match value.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|block| block.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => value.as_str().map(str::to_string).unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn an_assistant_message_keeps_thinking_text_and_calls() {
        let message = json!({
            "role": "assistant",
            "content": [
                { "type": "thinking", "thinking": "look at the files" },
                { "type": "text", "text": "Let me check." },
                { "type": "toolCall", "id": "c1", "name": "read", "arguments": { "path": "a.txt" } }
            ],
            "stopReason": "toolUse"
        });
        let (text, reasoning, calls) = assistant_parts(&message);
        assert_eq!(text, "Let me check.");
        assert_eq!(reasoning.as_deref(), Some("look at the files"));
        let calls = calls.expect("a tool call");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].name, "read");
        // The chat renderer parses arguments as JSON, exactly as the chat
        // agent's own tool calls arrive.
        assert_eq!(
            serde_json::from_str::<Value>(&calls[0].arguments).unwrap(),
            json!({ "path": "a.txt" })
        );
    }

    #[test]
    fn a_reply_with_no_blocks_and_no_error_has_nothing_to_show() {
        let (text, reasoning, calls) = assistant_parts(&json!({ "role": "assistant" }));
        assert!(text.is_empty());
        assert!(reasoning.is_none());
        assert!(calls.is_none());
    }

    #[test]
    fn a_tool_result_is_read_from_either_shape() {
        assert_eq!(
            text_of(&json!({ "content": [{ "type": "text", "text": "done" }] })),
            "done"
        );
        assert_eq!(text_of(&json!("plain")), "plain");
        assert_eq!(text_of(&json!({})), "");
    }

    #[test]
    fn only_a_coding_chat_is_one() {
        let ordinary = Chat::new();
        assert!(!is_coding(&ordinary));
        let path = std::env::temp_dir().join("demo");
        let coding = Chat::new_coding(&path);
        assert!(is_coding(&coding));
        assert_eq!(coding.meta.kind.as_deref(), Some(KIND_CODING));
    }
}
