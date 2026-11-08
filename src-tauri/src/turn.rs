use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::json;
use tauri::Emitter;

use crate::agent::AgentInfo;
use crate::commands::AppState;
use crate::config::{self, ReasoningEcho};
use crate::provider::{self, CancelToken, Chunk, Outcome};
use crate::store::{now_ms, Chat, ChatMeta, Message, ToolCallRecord};
use crate::tools::{self, ToolEnv};

/// Instructions for the chat model. The user never sees any of this; it only
/// describes the tools and how to behave around them. Override with
/// `[agent] system_prompt` in harness.config.toml.
const DEFAULT_SYSTEM_PROMPT: &str = "You are Hook, a desktop assistant. You talk with the user in a chat window and put real coding work in motion for them.

## Projects
- A project is a folder in the user-s projects directory. Every chat can use every project.
- Each project carries a short description that you maintain. Call list_projects whenever the task might match existing work; those descriptions are your index.
- You cannot read or edit project files yourself. create_project and update_project_description are your only direct project tools; anything about a project-s contents comes from a coding agent.

## Coding agents
- start_coding_agent runs pi inside a project folder with full permissions, sandboxed to that folder. Write a complete brief: the goal, the constraints, anything the user said that matters, and how to verify success.
- Runs are asynchronous. After starting one you may end your turn. You will be woken with a note when it settles, fails, or asks a question.
- agent_status shows progress, steer_agent redirects a live run, answer_agent unblocks a question it is stuck on, stop_agent kills it, and start_coding_agent with resume_session_id continues earlier work (see list_coding_sessions).
- When you are woken, tell the user what actually happened in plain language: what changed, whether it worked, what is left. Never mention agent ids, session ids, tool names, or raw logs.
- If a coding agent asks a question, answer it yourself when the user-s instructions already determine the answer; otherwise ask the user, then answer the agent.

## Style
- Be concise and concrete. Markdown is fine.
- No preamble, no restating the question, no filler.
- The user never sees the coding agents directly; everything they know comes from your messages.";

/// One assistant reply may need a few tool round-trips. Beyond this the turn is
/// stopped with an honest error instead of looping forever.
const MAX_ROUNDS: usize = 6;

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatEvent {
    pub chat_id: String,
    pub event: StreamEvent,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn emit(state: &AppState, chat_id: &str, event: StreamEvent) {
    let _ = state.app.emit(
        "hook://chat",
        ChatEvent {
            chat_id: chat_id.to_string(),
            event,
        },
    );
}

/// Tracks which chats are mid-turn and which have a pending wake.
#[derive(Default)]
pub struct TurnState {
    active: Mutex<HashSet<String>>,
    queued: Mutex<HashSet<String>>,
}

impl TurnState {
    fn begin(&self, chat_id: &str) -> bool {
        lock(&self.active).insert(chat_id.to_string())
    }

    fn queue(&self, chat_id: &str) {
        lock(&self.queued).insert(chat_id.to_string());
    }

    fn release(&self, chat_id: &str) -> bool {
        lock(&self.active).remove(chat_id);
        lock(&self.queued).remove(chat_id)
    }

    pub fn is_busy(&self, chat_id: &str) -> bool {
        lock(&self.active).contains(chat_id)
    }
}

/// Starts a turn if the chat is free, otherwise remembers to run one later.
pub fn kick(state: Arc<AppState>, chat_id: String) {
    tauri::async_runtime::spawn(async move {
        run_turn(state, chat_id).await;
    });
}

pub async fn run_turn(state: Arc<AppState>, chat_id: String) {
    if !state.turns.begin(&chat_id) {
        state.turns.queue(&chat_id);
        return;
    }

    let cancel = CancelToken::new();
    lock(&state.streams).insert(chat_id.clone(), cancel.clone());

    let cfg = match config::get() {
        Ok(cfg) => cfg.clone(),
        Err(err) => {
            if let Ok(mut chat) = state.store.load(&chat_id) {
                let _ = state.store.save(&mut chat);
                emit(&state, &chat_id, StreamEvent::Error {
                    message: err,
                    messages: chat.messages.clone(),
                    meta: chat.meta.clone(),
                });
            }
            finish(&state, &chat_id);
            return;
        }
    };

    let toolset = if cfg.provider.tools {
        Some(tools::definitions())
    } else {
        None
    };

    let mut rounds = 0usize;

    loop {
        rounds += 1;
        let Ok(mut chat) = state.store.load(&chat_id) else {
            break;
        };

        let assistant = Message::new("assistant", "", "streaming");
        let assistant_id = assistant.id.clone();
        chat.messages.push(assistant);
        chat.meta.updated_at = now_ms();
        let _ = state.store.save(&mut chat);
        emit(
            &state,
            &chat_id,
            StreamEvent::Started {
                messages: chat.messages.clone(),
                meta: chat.meta.clone(),
            },
        );

        // Reasoning is required on tool turns when this build asks for
        // thinking, or when the conversation already carries reasoning from
        // the provider (regardless of what the config says today).
        let thinking_on = cfg.model.thinking_level().is_some()
            || chat.messages.iter().any(|m| m.reasoning_field.is_some());
        let mut history = build_history(
            &chat,
            &assistant_id,
            &cfg.provider.reasoning_echo(),
            thinking_on,
        );
        history.insert(
            0,
            json!({
                "role": "system",
                "content": system_message(&cfg, &chat, &assistant_id),
            }),
        );
        let mut content = String::new();
        let mut reasoning = String::new();
        let mut reasoning_field: Option<String> = None;

        let outcome = provider::stream_chat(
            &cfg,
            &history,
            toolset.as_ref(),
            cancel.clone(),
            |chunk| match chunk {
                Chunk::Text(text) => {
                    content.push_str(&text);
                    emit(&state, &chat_id, StreamEvent::Delta { text });
                }
                Chunk::Reasoning(text) => {
                    reasoning.push_str(&text);
                    emit(&state, &chat_id, StreamEvent::Reasoning { text });
                }
            },
        )
        .await;

        let Ok(mut chat) = state.store.load(&chat_id) else {
            break;
        };
        let Some(index) = chat.messages.iter().position(|m| m.id == assistant_id) else {
            break;
        };

        match outcome {
            Ok(Outcome::Completed(completion)) => {
                reasoning_field = completion.reasoning_field.clone();
                let content = if completion.text.is_empty() {
                    content
                } else {
                    completion.text
                };
                let calls = completion.tool_calls;
                if !calls.is_empty() {
                    if rounds >= MAX_ROUNDS {
                        let message = format!(
                            "Stopped after {MAX_ROUNDS} tool rounds without a final answer. Send another message to continue."
                        );
                        let entry = &mut chat.messages[index];
                        entry.content = content;
                        entry.reasoning = non_empty(reasoning);
                        entry.reasoning_field = reasoning_field.clone();
                        entry.status = "error".into();
                        entry.error = Some(message.clone());
                        entry.tool_calls = Some(calls);
                        chat.meta.updated_at = now_ms();
                        let _ = state.store.save(&mut chat);
                        emit(
                            &state,
                            &chat_id,
                            StreamEvent::Error {
                                message,
                                messages: chat.messages.clone(),
                                meta: chat.meta.clone(),
                            },
                        );
                        break;
                    }

                    let entry = &mut chat.messages[index];
                    entry.content = content;
                    entry.reasoning = non_empty(reasoning);
                        entry.reasoning_field = reasoning_field.clone();
                    entry.status = "complete".into();
                    entry.tool_calls = Some(calls.clone());
                    // A tool-call-only assistant turn carries no visible text.
                    entry.hidden = entry.content.trim().is_empty();
                    chat.meta.updated_at = now_ms();
                    let _ = state.store.save(&mut chat);
                    emit(
                        &state,
                        &chat_id,
                        StreamEvent::Done {
                            messages: chat.messages.clone(),
                            meta: chat.meta.clone(),
                        },
                    );

                    for call in &calls {
                        let result = run_tool(&state, &chat_id, call);
                        let mut message = Message::new("tool", &result, "complete");
                        message.tool_call_id = Some(call.id.clone());
                        message.hidden = true;
                        chat.messages.push(message);
                    }
                    chat.meta.updated_at = now_ms();
                    let _ = state.store.save(&mut chat);
                    continue;
                }

                let entry = &mut chat.messages[index];
                entry.content = content;
                entry.reasoning = non_empty(reasoning);
                        entry.reasoning_field = reasoning_field.clone();
                entry.status = "complete".into();
                entry.usage = completion.usage;
                chat.meta.updated_at = now_ms();
                let _ = state.store.save(&mut chat);
                emit(
                    &state,
                    &chat_id,
                    StreamEvent::Done {
                        messages: chat.messages.clone(),
                        meta: chat.meta.clone(),
                    },
                );
                break;
            }
            Ok(Outcome::Cancelled) => {
                let entry = &mut chat.messages[index];
                entry.content = content;
                entry.reasoning = non_empty(reasoning);
                        entry.reasoning_field = reasoning_field.clone();
                entry.status = "aborted".into();
                chat.meta.updated_at = now_ms();
                let _ = state.store.save(&mut chat);
                emit(
                    &state,
                    &chat_id,
                    StreamEvent::Done {
                        messages: chat.messages.clone(),
                        meta: chat.meta.clone(),
                    },
                );
                break;
            }
            Err(err) => {
                let entry = &mut chat.messages[index];
                entry.content = content;
                entry.reasoning = non_empty(reasoning);
                        entry.reasoning_field = reasoning_field.clone();
                entry.status = "error".into();
                entry.error = Some(err.clone());
                chat.meta.updated_at = now_ms();
                let _ = state.store.save(&mut chat);
                emit(
                    &state,
                    &chat_id,
                    StreamEvent::Error {
                        message: err,
                        messages: chat.messages.clone(),
                        meta: chat.meta.clone(),
                    },
                );
                break;
            }
        }
    }

    finish(&state, &chat_id);
}

fn finish(state: &Arc<AppState>, chat_id: &str) {
    lock(&state.streams).remove(chat_id);
    if state.turns.release(chat_id) {
        // Something arrived while this turn was running.
        let state = state.clone();
        let chat_id = chat_id.to_string();
        tauri::async_runtime::spawn(async move {
            run_turn(state, chat_id).await;
        });
    }
}

/// The single system message: Hook's instructions plus every pending agent
/// note. Keeping it to one leading message is the most portable shape.
fn system_message(cfg: &config::HarnessConfig, chat: &Chat, exclude_id: &str) -> String {
    let mut text = system_prompt(cfg);
    for note in system_notes(chat, exclude_id) {
        text.push_str("\n\n");
        text.push_str(&note);
    }
    text
}

/// Only notes that arrived after the last assistant reply are pending. Once the
/// chat agent has spoken about an event it drops out of the prompt, so old
/// events can never be reported twice.
fn system_notes(chat: &Chat, exclude_id: &str) -> Vec<String> {
    let last_reply = chat.messages.iter().rposition(|m| {
        m.role == "assistant" && m.id != exclude_id && m.status == "complete"
    });
    let start = last_reply.map(|i| i + 1).unwrap_or(0);
    chat.messages
        .iter()
        .skip(start)
        .filter(|m| m.id != exclude_id)
        .filter(|m| m.role == "system" && !m.content.trim().is_empty())
        .map(|m| m.content.trim().to_string())
        .collect()
}

fn system_prompt(cfg: &config::HarnessConfig) -> String {
    cfg.agent
        .custom_prompt()
        .map(str::to_string)
        .unwrap_or_else(|| DEFAULT_SYSTEM_PROMPT.to_string())
}

fn non_empty(value: String) -> Option<String> {
    if value.trim().is_empty() {
        None
    } else {
        Some(value)
    }
}

fn run_tool(state: &AppState, chat_id: &str, call: &ToolCallRecord) -> String {
    let args = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .unwrap_or_else(|_| json!({}));
    tools::execute(
        &ToolEnv {
            agents: &state.agents,
            projects: &state.projects,
            settings: &state.settings,
            chat_id,
        },
        &call.name,
        &args,
    )
}

/// Append the agent event the chat agent must react to, then wake the chat.
pub fn on_agent_event(state: Arc<AppState>, info: AgentInfo) {
    let Ok(mut chat) = state.store.load(&info.chat_id) else {
        // The chat is gone; nothing to report into.
        let _ = state.agents.stop(&info.id);
        return;
    };

    let mut note = Message::hidden("system", &tools::agent_event_note(&info));
    note.created_at = now_ms();
    chat.messages.push(note);
    chat.meta.updated_at = now_ms();
    let _ = state.store.save(&mut chat);

    kick(state, info.chat_id.clone());
}

fn build_history(
    chat: &Chat,
    exclude_id: &str,
    echo: &ReasoningEcho,
    thinking_on: bool,
) -> Vec<serde_json::Value> {
    // Tool results are only valid directly after the assistant message that
    // requested them; drop any orphan (e.g. its parent errored out).
    let live_calls: std::collections::HashSet<&str> = chat
        .messages
        .iter()
        .filter(|m| m.id != exclude_id && m.status != "error")
        .filter_map(|m| m.tool_calls.as_ref())
        .flatten()
        .map(|call| call.id.as_str())
        .collect();

    chat.messages
        .iter()
        .filter(|m| m.id != exclude_id)
        .filter(|m| m.status != "error")
        .filter(|m| {
            m.role != "tool"
                || m.tool_call_id
                    .as_deref()
                    .map(|id| live_calls.contains(id))
                    .unwrap_or(false)
        })
        .filter_map(|m| match m.role.as_str() {
            "user" => (!m.content.trim().is_empty()).then(|| {
                json!({ "role": "user", "content": m.content })
            }),
            "assistant" => assistant_history_entry(m, echo, thinking_on),
            "tool" => m.tool_call_id.as_ref().map(|id| {
                json!({ "role": "tool", "tool_call_id": id, "content": m.content })
            }),
            _ => None,
        })
        .collect()
}

/// One assistant message as the provider expects to see it again. Thinking
/// models (DeepSeek among them) reject the follow-up request unless the
/// reasoning that produced the turn is replayed in the same field.
fn assistant_history_entry(
    m: &Message,
    echo: &ReasoningEcho,
    thinking_on: bool,
) -> Option<serde_json::Value> {
    let empty_text = m.content.trim().is_empty();
    if empty_text && m.tool_calls.is_none() {
        return None;
    }

    let mut object = serde_json::Map::new();
    object.insert("role".into(), json!("assistant"));
    object.insert(
        "content".into(),
        if empty_text {
            serde_json::Value::Null
        } else {
            json!(m.content)
        },
    );
    if let Some(calls) = &m.tool_calls {
        object.insert("tool_calls".into(), tool_calls_json(calls));
    }
    if let Some(field) = echo.field_for(m.reasoning_field.as_deref()) {
        match m.reasoning.as_deref().filter(|text| !text.trim().is_empty()) {
            Some(reasoning) => {
                object.insert(field, json!(reasoning));
            }
            // Thinking-mode providers reject the *next* request when an
            // assistant turn with tool calls omits this field, even when the
            // model produced no reasoning. An empty string satisfies them.
            None if m.tool_calls.is_some() && thinking_on => {
                object.insert(field, json!(""));
            }
            None => {}
        }
    }
    Some(serde_json::Value::Object(object))
}

fn tool_calls_json(calls: &[ToolCallRecord]) -> serde_json::Value {
    serde_json::Value::Array(
        calls
            .iter()
            .map(|call| {
                json!({
                    "id": call.id,
                    "type": "function",
                    "function": { "name": call.name, "arguments": call.arguments },
                })
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chat_with(messages: Vec<Message>) -> Chat {
        let mut chat = Chat::new();
        chat.messages = messages;
        chat
    }

    #[test]
    fn history_keeps_tool_pairs_and_hidden_notes() {
        let mut assistant = Message::new("assistant", "", "complete");
        assistant.tool_calls = Some(vec![ToolCallRecord {
            id: "call_1".into(),
            name: "list_projects".into(),
            arguments: "{}".into(),
        }]);
        assistant.hidden = true;
        let mut tool = Message::new("tool", "{\"projects\":[]}", "complete");
        tool.tool_call_id = Some("call_1".into());
        tool.hidden = true;
        let note = Message::hidden("system", "[coding agent update] done");
        let user = Message::new("user", "hello", "complete");

        // Real order after a wake: the note lands after the last reply.
        let chat = chat_with(vec![user, assistant, tool, note]);
        let notes = system_notes(&chat, "none");
        let history = build_history(&chat, "none", &ReasoningEcho::Auto, true);

        // The agent note is folded into the single leading system message.
        assert_eq!(notes.len(), 1);
        assert!(notes[0].contains("coding agent update"));
        assert_eq!(history.len(), 3);
        assert_eq!(history[0]["role"], "user");
        assert_eq!(history[1]["role"], "assistant");
        assert!(history[1]["content"].is_null());
        assert_eq!(history[1]["tool_calls"][0]["id"], "call_1");
        assert_eq!(history[2]["role"], "tool");
        assert_eq!(history[2]["tool_call_id"], "call_1");
    }

    #[test]
    fn notes_stop_being_pending_once_the_agent_has_answered() {
        let note = Message::hidden("system", "[coding agent update] done");
        let user = Message::new("user", "hi", "complete");
        let reply = Message::new("assistant", "All done.", "complete");
        let chat = chat_with(vec![user, note, reply]);
        assert!(system_notes(&chat, "none").is_empty());

        // A fresh event after the reply is pending again.
        let mut chat = chat;
        chat.messages
            .push(Message::hidden("system", "[coding agent update] needs input"));
        assert_eq!(system_notes(&chat, "none").len(), 1);
    }

    #[test]
    fn reasoning_is_replayed_in_the_field_the_provider_used() {
        let mut reply = Message::new("assistant", "All done.", "complete");
        reply.reasoning = Some("I compared the two files first.".into());
        reply.reasoning_field = Some("reasoning_content".into());
        let user = Message::new("user", "do it", "complete");
        let chat = chat_with(vec![user, reply]);

        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true);
        assert_eq!(
            history[1]["reasoning_content"],
            "I compared the two files first."
        );

        // A legacy message with no recorded field still replays correctly.
        let mut legacy = Message::new("assistant", "Done.", "complete");
        legacy.reasoning = Some("legacy thoughts".into());
        let chat = chat_with(vec![Message::new("user", "hi", "complete"), legacy]);
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true);
        assert_eq!(history[1]["reasoning_content"], "legacy thoughts");

        // "off" drops it entirely.
        let history = build_history(&chat, "x", &ReasoningEcho::Off, true);
        assert!(history[1].get("reasoning_content").is_none());

        // An explicit field name wins.
        let history = build_history(&chat, "x", &ReasoningEcho::Fixed("reasoning".into()), true);
        assert_eq!(history[1]["reasoning"], "legacy thoughts");
    }

    #[test]
    fn tool_turns_without_reasoning_still_carry_the_field() {
        // The exact DeepSeek failure mode: a tool call with no reasoning text.
        let mut call = Message::new("assistant", "", "complete");
        call.tool_calls = Some(vec![ToolCallRecord {
            id: "call_1".into(),
            name: "list_projects".into(),
            arguments: "{}".into(),
        }]);
        call.hidden = true;
        let mut result = Message::new("tool", "{\"projects\":[]}", "complete");
        result.tool_call_id = Some("call_1".into());
        let chat = chat_with(vec![
            Message::new("user", "hi", "complete"),
            call,
            result,
        ]);

        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true);
        assert_eq!(history[1]["reasoning_content"], "");

        // With thinking off there is nothing to satisfy, so nothing is added.
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, false);
        assert!(history[1].get("reasoning_content").is_none());
    }

    #[test]
    fn a_wake_turn_has_the_shape_thinking_providers_require() {
        // [system note + instructions] user, assistant(tool_calls), tool
        let mut call = Message::new("assistant", "", "complete");
        call.tool_calls = Some(vec![ToolCallRecord {
            id: "call_1".into(),
            name: "start_coding_agent".into(),
            arguments: "{}".into(),
        }]);
        call.hidden = true;
        let mut result = Message::new("tool", "{\"agent_id\":\"ag_1\"}", "complete");
        result.tool_call_id = Some("call_1".into());
        let note = Message::hidden("system", "[coding agent update] state: idle");
        let chat = chat_with(vec![
            Message::new("user", "build it", "complete"),
            call,
            result,
            note,
        ]);

        let history = build_history(&chat, "placeholder", &ReasoningEcho::Auto, true);
        assert_eq!(history.len(), 3);
        assert_eq!(history[1]["reasoning_content"], "");

        let notes = system_notes(&chat, "placeholder");
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn a_failed_reply_does_not_consume_the_pending_note() {
        let note = Message::hidden("system", "[coding agent update] done");
        let mut failed = Message::new("assistant", "", "error");
        failed.error = Some("400".into());
        let chat = chat_with(vec![Message::new("user", "hi", "complete"), note, failed]);
        assert_eq!(system_notes(&chat, "x").len(), 1);
    }

    #[test]
    fn orphan_tool_results_are_dropped() {
        let mut orphan = Message::new("tool", "{\"projects\":[]}", "complete");
        orphan.tool_call_id = Some("call_gone".into());
        let user = Message::new("user", "hi", "complete");
        let chat = chat_with(vec![user, orphan]);
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "user");
    }

    #[test]
    fn empty_assistant_placeholders_are_dropped() {
        let user = Message::new("user", "hi", "complete");
        let placeholder = Message::new("assistant", "", "streaming");
        let chat = chat_with(vec![user, placeholder]);
        let history = build_history(&chat, "not-the-placeholder", &ReasoningEcho::Auto, true);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "user");
    }

    #[test]
    fn errored_messages_are_not_replayed() {
        let mut bad = Message::new("assistant", "half a thought", "error");
        bad.error = Some("boom".into());
        let user = Message::new("user", "hi", "complete");
        let chat = chat_with(vec![user, bad]);
        assert_eq!(build_history(&chat, "x", &ReasoningEcho::Auto, true).len(), 1);
    }

    #[test]
    fn turn_state_queues_instead_of_overlapping() {
        let turns = TurnState::default();
        assert!(turns.begin("c1"));
        assert!(!turns.begin("c1"));
        turns.queue("c1");
        assert!(turns.release("c1"));
        assert!(turns.begin("c1"));
    }
}
