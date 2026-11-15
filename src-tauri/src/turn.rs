use std::collections::HashSet;
use std::sync::{Arc, Mutex, MutexGuard};

use serde::Serialize;
use serde_json::json;
use tauri::Emitter;

use crate::agent::AgentInfo;
use crate::commands::AppState;
use crate::config::{self, ReasoningEcho};
use crate::provider::{self, CancelToken, Chunk, Outcome};
use crate::store::{now_ms, truncate, Attachment, Chat, ChatMeta, Message, ToolCallRecord};
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
- Always pass a `plan`: three to six short steps in plain, everyday language, in the order they will happen. This is the checklist the user watches at the bottom of the chat while the agent works, so it must read like 'Setting things up', 'Designing the front page', 'Integrating the real service' - never file names, tool names, package names or jargon. Same language the user writes in.
- Runs are asynchronous. After starting one you may end your turn. You will be woken with a note when it settles, fails, or asks a question.
- agent_status shows progress, steer_agent redirects a live run, answer_agent unblocks a question it is stuck on, stop_agent kills it, and start_coding_agent with resume_session_id continues earlier work (see list_coding_sessions).
- When you are woken and there is something to report, say what actually happened in plain language: what changed, whether it worked, what is left. Never mention agent ids, session ids, tool names, or raw logs.
- If a coding agent asks a question, answer it yourself when the user-s instructions already determine the answer; otherwise ask the user, then answer the agent.

## Preview panel
- Hook has a preview panel on the right side of the window. A coding agent can put one HTML page from its project there with its own show_preview tool; Hook serves it and refreshes it whenever the project changes. You never see the panel and you never set it yourself.
- It is optional. Tell the coding agent to use it when the work has something worth looking at: a frontend task, a UI change, a data analysis with charts or tables, a visual report. Skip it for backend work, refactors, scripts, configuration, or anything with nothing to look at.
- Ask for it early in the brief, not at the end. The coding agent can point at a page it has not written yet; the panel waits for it.
- Frontend work: tell the coding agent to point show_preview at the page the user should see, usually index.html or the project preview entry - never a source file such as App.tsx - and to keep that page working and current, with relative paths, so what the user sees is the real thing.
- Other work worth seeing: tell it to create a standalone, self-contained HTML page (for example preview.html) with the real numbers and charts, and to call show_preview for it. It should keep the page updated as findings change.
- The panel opens itself the first time in a coding session. When that run finishes it stays open and simply stops refreshing on its own; the user can collapse it or reload it by hand. Never ask permission and never explain the mechanics. A few plain words when it matters is enough ('the pricing page is in the preview').

## Steering a running agent
- While a coding agent is working, a message from the user is guidance for that agent, not a request for you to do work. Call list_agents or agent_status, find the live agent in this chat, and pass the instruction on with steer_agent. Then reply with one short line saying what you told it to change.
- Never start a second coding agent for work that is already in progress. If the user changes direction, steer the agent that is running; if they want it over, stop_agent ends it.
- If the user asks how the work is going, answer from the plan and the agent-s progress, not by starting anything.

## Progress
- A note arrives when a coding agent reported something. It is not a request to speak, and most notes are not worth a message.
- A note is never permission to start, steer, or restart coding work. Only a message from the user can do that. When a note says a run finished, leave it finished - report it, or call no_update and stay silent.
- Speak only when the user would learn something they would care about: a milestone you can state concretely, a decision that changes the outcome, a problem, or a picture worth looking at. Then two or three sentences, no preamble, no recap of what you already said.
- Otherwise call no_update and stay silent. Silence is normal: several notes in a row can pass without a word, and a stretch of quiet is expected while work is underway.
- A status line is never news. 'Still working', 'building now', 'on it', 'in progress', 'making good progress' and 'I'll report back when...' are all filler: if that is all you have to say, call no_update instead. Never promise a future update - either there is something to say now or there is not.
- Never narrate the arrival of a note, never say 'still working', 'in progress', 'no news', 'the agent just filed a note', and never mention batches, agent ids, tools, or files.
- A run that settled is not news by itself. Do not describe a run that has stopped as if it were still going, and do not repeat a brief you already gave.
- Pictures that came with a note are shown to the user with your reply. Refer to them naturally (here is the menu as it stands); do not describe every detail.
- Only state what the notes say. If nothing came in, say you do not know yet rather than guessing.
- A note that says new_since_last_update: none carries no new information: call no_update. Never restate or reword your last message - if it is already said, it is said. The only exception is a run you have never told the user about at all: then one sentence, once.
- A failure, an error, or a question always gets an answer, even when nothing is new.

## Style
- Be concise and concrete. Markdown is fine.
- No preamble, no restating the question, no filler.
- Never end a message with a promise about the future: no 'I'll tell you when...', 'I'll report back', 'stay tuned'. If there is something worth saying later, that is when you say it; if you have something to say now, say it now.
- The user never sees the coding agents themselves - no logs, no ids, no session browser - but they do see the plain-language checklist you put in `plan` and a Stop button. Everything else they know comes from your messages.
- The user may attach pictures to their own messages. Treat them as part of the question.";

/// A note the chat agent decided not to talk about. It drops out of the prompt
/// without producing a message.
const STATUS_CONSUMED: &str = "consumed";

/// Upper bound on pictures carried by one progress batch.
const MAX_BATCH_IMAGES: usize = 4;

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
    // `no_update` only makes sense when a coding-agent note is waiting: there is
    // nothing to stay quiet about otherwise.
    let has_notes = state
        .store
        .load(&chat_id)
        .map(|chat| !pending_notes(&chat, "").is_empty())
        .unwrap_or(false);
    let toolset = toolset.map(|mut set| {
        if !has_notes {
            if let Some(list) = set.as_array_mut() {
                list.retain(|tool| tool["function"]["name"] != "no_update");
            }
        }
        set
    });

    // A coding-agent note can wake this turn, but it is not permission to put
    // more work in motion. Only a message the user has not been answered for
    // lets the chat agent start or redirect a coding agent.
    let user_initiated = state
        .store
        .load(&chat_id)
        .map(|chat| user_is_waiting(&chat))
        .unwrap_or(false);

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

        // Thinking-mode APIs require every assistant turn to carry its
        // reasoning back as soon as tools are offered; an empty string is
        // accepted when the model produced none. Outside that mode there is
        // nothing to echo.
        let require_reasoning = (cfg.model.thinking_level().is_some()
            || chat.messages.iter().any(|m| m.reasoning_field.is_some()))
            && cfg.provider.tools;
        // Pictures only go to models that can see them, and only until an
        // endpoint has told us it cannot after all.
        let vision = state
            .vision
            .load(std::sync::atomic::Ordering::Relaxed)
            && !state
                .vision_off
                .load(std::sync::atomic::Ordering::Relaxed);
        // Which pictures the model gets to see: the newest ones, so a long
        // conversation keeps its recent context instead of its oldest.
        let send_images = if vision {
            newest_image_ids(&chat, &assistant_id, cfg.provider.max_images)
        } else {
            HashSet::new()
        };
        let read_image = |attachment: &Attachment| -> Option<String> {
            if !send_images.contains(&attachment.id) {
                return None;
            }
            state.store.read_image(&chat_id, &attachment.id).ok()
        };
        let mut history = build_history(
            &chat,
            &assistant_id,
            &cfg.provider.reasoning_echo(),
            require_reasoning,
            vision.then_some(&read_image),
        );
        history.insert(
            0,
            json!({
                "role": "system",
                "content": system_message(&cfg, &chat, &assistant_id, &state, &chat_id),
            }),
        );
        // Pictures that arrived with this wake: they belong on the reply the
        // user reads, not on the hidden note that prompted it.
        let batch_images: Vec<Attachment> = chat
            .messages
            .iter()
            .skip(
                chat.messages
                    .iter()
                    .rposition(|m| {
                        m.role == "assistant" && m.id != assistant_id && m.status == "complete"
                    })
                    .map(|i| i + 1)
                    .unwrap_or(0),
            )
            .filter(|m| m.role == "system" && !m.attachments.is_empty())
            .flat_map(|m| m.attachments.clone())
            .take(MAX_BATCH_IMAGES)
            .collect();

        let mut content = String::new();
        let mut reasoning = String::new();
        let mut reasoning_field: Option<String> = None;

        let Some(token) = state.auth.token() else {
            let Some(index) = chat.messages.iter().position(|m| m.id == assistant_id) else {
                break;
            };
            let entry = &mut chat.messages[index];
            entry.status = "error".into();
            entry.error = Some("Sign in to Hook to continue.".into());
            chat.meta.updated_at = now_ms();
            let _ = state.store.save(&mut chat);
            emit(
                &state,
                &chat_id,
                StreamEvent::Error {
                    message: "Sign in to Hook to continue.".into(),
                    messages: chat.messages.clone(),
                    meta: chat.meta.clone(),
                },
            );
            break;
        };
        let context = provider::RequestContext::chat(chat_id.clone());

        let outcome = provider::stream_chat(
            &cfg,
            &token,
            &context,
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
                // Non-streamed responses never pass through the chunk path.
                if reasoning.is_empty() && !completion.reasoning.is_empty() {
                    reasoning = completion.reasoning.clone();
                }
                let content = if completion.text.is_empty() {
                    content
                } else {
                    completion.text
                };
                let calls = completion.tool_calls;

                // The chat agent may decide a batch is not worth a message —
                // but only to a note. A user message always gets an answer.
                let notes_are_pending = !pending_notes(&chat, &assistant_id).is_empty();
                if notes_are_pending && calls.iter().any(|call| call.name == "no_update") {
                    let note_ids: Vec<String> =
                        pending_notes(&chat, &assistant_id).iter().map(|m| m.id.clone()).collect();
                    chat.messages.retain(|m| m.id != assistant_id);
                    for message in chat.messages.iter_mut() {
                        if note_ids.contains(&message.id) {
                            // Answered with silence: stop offering it again.
                            message.status = STATUS_CONSUMED.into();
                        }
                    }
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
                        let result = run_tool(&state, &chat_id, call, user_initiated);
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
                if !batch_images.is_empty() {
                    entry.attachments = batch_images.clone();
                }
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
                // 401/403 from the Hook proxy means the account was signed out
                // or unapproved while this window was open. Drop the token and
                // show the login screen; the chat keeps the failed message.
                if err.starts_with("401") || err.starts_with("403") {
                    state.auth.clear_session();
                    crate::commands::revoke_local(&state);
                    let mut view = state.auth.view();
                    view.message = Some(err.clone());
                    let _ = state.app.emit("hook://auth", view);
                }
                if vision && rounds <= MAX_ROUNDS && rejects_images(&err) {
                    // The model card promised vision and the endpoint
                    // disagrees. Drop the images, remember it, and try again.
                    eprintln!("hook: endpoint rejected image input, retrying without images — {err}");
                    state
                        .vision_off
                        .store(true, std::sync::atomic::Ordering::Relaxed);
                    chat.messages.retain(|m| m.id != assistant_id);
                    chat.meta.updated_at = now_ms();
                    let _ = state.store.save(&mut chat);
                    rounds -= 1;
                    continue;
                }
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
fn system_message(
    cfg: &config::HarnessConfig,
    chat: &Chat,
    exclude_id: &str,
    state: &AppState,
    chat_id: &str,
) -> String {
    let mut text = system_prompt(cfg);
    for note in system_notes(chat, exclude_id) {
        text.push_str("\n\n");
        text.push_str(&note);
    }
    if let Some(hint) = live_agent_hint(state, chat_id) {
        text.push_str("\n\n");
        text.push_str(&hint);
    }
    text
}

/// An ephemeral line for this request only. A live coding agent means the
/// user's message is almost certainly guidance for it, and naming the agent id
/// here is what makes the chat agent steer instead of starting a second run.
/// It is never stored in the chat, so it can never turn into a fake note.
fn live_agent_hint(state: &AppState, chat_id: &str) -> Option<String> {
    let active: Vec<AgentInfo> = state
        .agents
        .list()
        .into_iter()
        .filter(|agent| agent.chat_id == chat_id && agent.is_active())
        .collect();
    if active.is_empty() {
        return None;
    }
    let mut hint = String::from("[steering]\nA coding agent is live in this chat right now:\n");
    for agent in &active {
        hint.push_str(&format!(
            "- agent_id: {}, title: {}, state: {}",
            agent.id, agent.title, agent.state
        ));
        if let Some(question) = &agent.question {
            hint.push_str(&format!(" (waiting on: {})", truncate(&question.title, 160)));
        }
        hint.push('\n');
    }
    hint.push_str(
        "If the agent is waiting for an answer (needs_input), use answer_agent for a reply to its question. If the user's message is guidance about that work, pass it on with steer_agent. Never start another agent for the same work, and never do the work yourself. If the message is a new, unrelated request, handle it normally.\n",
    );
    Some(hint)
}

/// Only notes that arrived after the last assistant reply are pending. Once the
/// chat agent has spoken about an event it drops out of the prompt, so old
/// events can never be reported twice.
fn pending_notes<'a>(chat: &'a Chat, exclude_id: &str) -> Vec<&'a Message> {
    let last_reply = chat.messages.iter().rposition(|m| {
        m.role == "assistant" && m.id != exclude_id && m.status == "complete"
    });
    let start = last_reply.map(|i| i + 1).unwrap_or(0);
    chat.messages
        .iter()
        .skip(start)
        .filter(|m| m.id != exclude_id)
        .filter(|m| m.role == "system" && !m.content.trim().is_empty())
        // Notes the chat agent explicitly left unanswered stay answered.
        .filter(|m| m.status != STATUS_CONSUMED)
        .collect()
}

fn system_notes(chat: &Chat, exclude_id: &str) -> Vec<String> {
    pending_notes(chat, exclude_id)
        .into_iter()
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

fn run_tool(
    state: &AppState,
    chat_id: &str,
    call: &ToolCallRecord,
    user_initiated: bool,
) -> String {
    let args = serde_json::from_str::<serde_json::Value>(&call.arguments)
        .unwrap_or_else(|_| json!({}));
    tools::execute(
        &ToolEnv {
            agents: &state.agents,
            projects: &state.projects,
            settings: &state.settings,
            chat_id,
            user_initiated,
        },
        &call.name,
        &args,
    )
}

/// True when the newest visible word in the chat is the user's: they asked for
/// something and no reply has been written yet. A turn woken by a coding-agent
/// note is never user-initiated, even when an older user message sits above it.
fn user_is_waiting(chat: &Chat) -> bool {
    chat.messages
        .iter()
        .rev()
        .find(|m| !m.hidden && (m.role == "user" || m.role == "assistant"))
        .map(|m| m.role == "user")
        .unwrap_or(false)
}

/// Append the agent event the chat agent must react to, then wake the chat.
pub fn on_agent_event(state: Arc<AppState>, info: AgentInfo) {
    let Ok(mut chat) = state.store.load(&info.chat_id) else {
        // The chat is gone; nothing to report into.
        let _ = state.agents.stop(&info.id);
        return;
    };

    // Whatever the agent reported since the last batch rides along with this
    // wake, pictures included — so the chat agent can talk about what it sees.
    let already_reported = state.agents.delivered_progress(&info.id);
    let updates = state.agents.take_updates(&info.id);
    // A settle with nothing new and nothing wrong is the case that used to make
    // the chat agent repeat its last message: hand it a short "nothing new"
    // note instead of the run's whole final report.
    let quiet =
        updates.is_empty() && already_reported && info.error.is_none() && info.question.is_none();
    let mut text = tools::agent_event_note(&info, quiet);
    let mut attachments = Vec::new();
    if !updates.is_empty() {
        text.push_str("\n");
        text.push_str(&tools::progress_block(&updates));
        for path in updates.iter().flat_map(|u| u.images.iter()) {
            if attachments.len() >= MAX_BATCH_IMAGES {
                break;
            }
            match state
                .store
                .adopt_image(&info.chat_id, path, Some("screenshot"))
            {
                Ok(attachment) => attachments.push(attachment),
                Err(error) => eprintln!("hook: skipping progress picture: {error}"),
            }
        }
    }

    let mut note = Message::hidden("system", &text);
    note.attachments = attachments;
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
    require_reasoning: bool,
    images: Option<&dyn Fn(&Attachment) -> Option<String>>,
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
            "user" => user_history_entry(m, images),
            "assistant" => assistant_history_entry(m, echo, require_reasoning),
            "tool" => m.tool_call_id.as_ref().map(|id| {
                json!({ "role": "tool", "tool_call_id": id, "content": m.content })
            }),
            _ => None,
        })
        .collect()
}

/// A user turn: plain text, or text plus the pictures they attached.
///
/// Pictures only travel when the model can see them; otherwise the text gains a
/// short note so the model still knows something was attached.
/// The pictures that will actually be sent: the newest `limit` attachments in
/// the conversation. Everything older becomes a text note, so a chat with fifty
/// screenshots still fits whatever image budget the provider has.
fn newest_image_ids(chat: &Chat, exclude_id: &str, limit: usize) -> HashSet<String> {
    let mut keep = HashSet::new();
    if limit == 0 {
        return keep;
    }
    for message in chat.messages.iter().rev() {
        if message.id == exclude_id || message.status == "error" {
            continue;
        }
        for attachment in message.attachments.iter().rev() {
            if keep.len() >= limit {
                return keep;
            }
            keep.insert(attachment.id.clone());
        }
    }
    keep
}

fn size_note(attachment: &Attachment) -> String {
    let size = if attachment.width > 0 {
        format!("{}x{} ", attachment.width, attachment.height)
    } else {
        String::new()
    };
    format!("{size}{}", attachment.mime.trim_start_matches("image/"))
}

/// A picture the model cannot see, kept in the text so the conversation still
/// makes sense.
fn omitted_note(attachment: &Attachment) -> String {
    format!("[older image omitted: {}]", size_note(attachment))
}

fn user_history_entry(
    m: &Message,
    images: Option<&dyn Fn(&Attachment) -> Option<String>>,
) -> Option<serde_json::Value> {
    let mut text = m.content.clone();
    if text.trim().is_empty() && m.attachments.is_empty() {
        return None;
    }

    let mut image_parts = Vec::new();
    let mut notes = Vec::new();
    match images {
        Some(read) => {
            for attachment in &m.attachments {
                match read(attachment) {
                    Some(url) => image_parts
                        .push(json!({ "type": "image_url", "image_url": { "url": url } })),
                    None => notes.push(omitted_note(attachment)),
                }
            }
        }
        // Vision is off: every picture is described instead of sent.
        None => notes.extend(
            m.attachments
                .iter()
                .map(|a| format!("[attached image: {}]", size_note(a))),
        ),
    }

    if image_parts.is_empty() {
        for note in notes {
            text.push('\n');
            text.push_str(&note);
        }
        return if text.trim().is_empty() {
            None
        } else {
            Some(json!({ "role": "user", "content": text }))
        };
    }

    if text.trim().is_empty() {
        text = "What do you make of this?".into();
    }
    let mut content = vec![json!({ "type": "text", "text": text })];
    content.extend(image_parts);
    if !notes.is_empty() {
        content.push(json!({ "type": "text", "text": notes.join("\n") }));
    }
    Some(json!({ "role": "user", "content": content }))
}

/// Did the endpoint complain about the pictures rather than the request?
fn rejects_images(error: &str) -> bool {
    let lower = error.to_lowercase();
    (lower.contains("400") || lower.contains("415") || lower.contains("invalid_request"))
        && (lower.contains("image") || lower.contains("vision") || lower.contains("modal"))
}

/// One assistant message as the provider expects to see it again. Thinking
/// models (DeepSeek among them) reject the follow-up request unless the
/// reasoning that produced the turn is replayed in the same field.
fn assistant_history_entry(
    m: &Message,
    echo: &ReasoningEcho,
    require_reasoning: bool,
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
            // DeepSeek rejects the whole request, tools and all, unless every
            // assistant turn echoes this field — including turns where the
            // model produced no reasoning. An empty string satisfies it.
            None if require_reasoning => {
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
        let history = build_history(&chat, "none", &ReasoningEcho::Auto, true, None);

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

        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        assert_eq!(
            history[1]["reasoning_content"],
            "I compared the two files first."
        );

        // A legacy message with no recorded field still replays correctly.
        let mut legacy = Message::new("assistant", "Done.", "complete");
        legacy.reasoning = Some("legacy thoughts".into());
        let chat = chat_with(vec![Message::new("user", "hi", "complete"), legacy]);
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        assert_eq!(history[1]["reasoning_content"], "legacy thoughts");

        // "off" drops it entirely.
        let history = build_history(&chat, "x", &ReasoningEcho::Off, true, None);
        assert!(history[1].get("reasoning_content").is_none());

        // An explicit field name wins.
        let history = build_history(&chat, "x", &ReasoningEcho::Fixed("reasoning".into()), true, None);
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

        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        assert_eq!(history[1]["reasoning_content"], "");

        // With thinking off there is nothing to satisfy, so nothing is added.
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, false, None);
        assert!(history[1].get("reasoning_content").is_none());
    }

    fn picture() -> Attachment {
        Attachment {
            id: "img_1".into(),
            file: "img_1.png".into(),
            mime: "image/png".into(),
            width: 1200,
            height: 800,
            bytes: 32,
            kind: Some("user".into()),
        }
    }

    #[test]
    fn user_pictures_become_parts_only_for_models_that_can_see() {
        let mut user = Message::new("user", "look at this", "complete");
        user.attachments.push(picture());
        let chat = chat_with(vec![user]);

        let read = |attachment: &Attachment| {
            Some(format!("data:{};base64,AAAA", attachment.mime))
        };
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, Some(&read));
        assert_eq!(history[0]["content"][0]["type"], "text");
        assert_eq!(history[0]["content"][0]["text"], "look at this");
        assert_eq!(history[0]["content"][1]["type"], "image_url");
        assert_eq!(
            history[0]["content"][1]["image_url"]["url"],
            "data:image/png;base64,AAAA"
        );

        // A text-only model still learns that something was attached.
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        let text = history[0]["content"].as_str().unwrap();
        assert!(text.contains("[attached image: 1200x800 png]"));
    }

    fn picture_named(id: &str) -> Attachment {
        let mut a = picture();
        a.id = id.to_string();
        a.file = format!("{id}.png");
        a
    }

    #[test]
    fn only_the_newest_pictures_are_sent() {
        let mut old = Message::new("user", "first", "complete");
        old.attachments.push(picture_named("img_old"));
        let mut middle = Message::new("user", "second", "complete");
        middle.attachments.push(picture_named("img_mid"));
        let mut newest = Message::new("user", "third", "complete");
        newest.attachments.push(picture_named("img_new"));
        let chat = chat_with(vec![old, middle, newest]);

        let keep = newest_image_ids(&chat, "x", 2);
        assert_eq!(keep.len(), 2);
        assert!(keep.contains("img_new"), "the newest picture must win");
        assert!(keep.contains("img_mid"));
        assert!(!keep.contains("img_old"), "the oldest picture becomes a note");

        // The budget is zero-safe.
        assert!(newest_image_ids(&chat, "x", 0).is_empty());
        // Everything fits, nothing is dropped.
        assert_eq!(newest_image_ids(&chat, "x", 9).len(), 3);
    }

    #[test]
    fn pictures_over_the_budget_become_a_placeholder_not_a_silent_drop() {
        let mut old = Message::new("user", "older", "complete");
        old.attachments.push(picture_named("img_old"));
        let mut newest = Message::new("user", "newer", "complete");
        newest.attachments.push(picture_named("img_new"));
        let chat = chat_with(vec![old, newest]);

        let keep = newest_image_ids(&chat, "x", 1);
        let read = |attachment: &Attachment| {
            keep.contains(&attachment.id)
                .then(|| format!("data:{};base64,AAAA", attachment.mime))
        };
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, Some(&read));

        // The old message keeps its text and says what happened to the picture.
        assert_eq!(history[0]["role"], "user");
        let text = history[0]["content"].as_str().expect("plain text for a dropped picture");
        assert!(text.contains("older"));
        assert!(text.contains("[older image omitted: 1200x800 png]"));

        // The new one still carries the actual image.
        assert_eq!(history[1]["content"][1]["type"], "image_url");
        assert!(history[1]["content"]
            .as_array()
            .unwrap()
            .iter()
            .all(|p| p["type"] != "text" || !p["text"].as_str().unwrap().contains("omitted")));
    }

    #[test]
    fn a_message_with_mixed_pictures_keeps_the_newest_and_notes_the_rest() {
        let mut user = Message::new("user", "three shots", "complete");
        for id in ["img_a", "img_b", "img_c"] {
            user.attachments.push(picture_named(id));
        }
        let chat = chat_with(vec![user]);
        // Budget of two: the third attachment in the message is the newest, so
        // the first one drops.
        let keep = newest_image_ids(&chat, "x", 2);
        assert!(keep.contains("img_c"));
        assert!(keep.contains("img_b"));
        assert!(!keep.contains("img_a"));

        let read = |attachment: &Attachment| {
            keep.contains(&attachment.id)
                .then(|| format!("data:{};base64,AAAA", attachment.mime))
        };
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, Some(&read));
        let parts = history[0]["content"].as_array().unwrap();
        let images = parts.iter().filter(|p| p["type"] == "image_url").count();
        assert_eq!(images, 2);
        let last = parts.last().unwrap();
        assert_eq!(last["type"], "text");
        assert!(last["text"].as_str().unwrap().contains("older image omitted"));
    }

    #[test]
    fn a_picture_without_text_still_reaches_the_model() {
        let mut user = Message::new("user", "", "complete");
        user.attachments.push(picture());
        let chat = chat_with(vec![user]);
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        assert!(history[0]["content"].as_str().unwrap().contains("attached image"));
    }

    #[test]
    fn a_wake_turn_echoes_reasoning_on_the_trailing_reply() {
        // This is the shape that 400s on DeepSeek: an agent report arrives, so
        // the request ends with the last assistant reply plus a system note.
        let mut call = Message::new("assistant", "Setting it up.", "complete");
        call.tool_calls = Some(vec![ToolCallRecord {
            id: "call_1".into(),
            name: "start_coding_agent".into(),
            arguments: "{}".into(),
        }]);
        call.hidden = true;
        let mut result = Message::new("tool", "{\"agent_id\":\"ag_1\"}", "complete");
        result.tool_call_id = Some("call_1".into());
        let reply = Message::new("assistant", "The agent is building it.", "complete");
        let note = Message::hidden("system", "[coding agent update] state: idle");

        let chat = chat_with(vec![
            Message::new("user", "build it", "complete"),
            call,
            result,
            reply,
            note,
        ]);

        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        // Every assistant turn carries the field, empty when nothing streamed.
        assert_eq!(history[1]["reasoning_content"], "");
        assert_eq!(history[3]["reasoning_content"], "");
        assert_eq!(history[3]["content"], "The agent is building it.");

        // Without thinking there is nothing to satisfy.
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, false, None);
        assert!(history[3].get("reasoning_content").is_none());
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

        let history = build_history(&chat, "placeholder", &ReasoningEcho::Auto, true, None);
        assert_eq!(history.len(), 3);
        assert_eq!(history[1]["reasoning_content"], "");

        let notes = system_notes(&chat, "placeholder");
        assert_eq!(notes.len(), 1);
    }

    #[test]
    fn a_note_left_unanswered_stops_being_pending() {
        // The chat agent may answer a weak progress note with silence. That
        // note must not come back on every later turn.
        let note = Message::hidden("system", "[coding agent update] nothing new");
        let mut answered = Message::hidden("system", "[coding agent update] menu done");
        answered.status = "consumed".into();
        let chat = chat_with(vec![Message::new("user", "hi", "complete"), note, answered]);

        let pending = pending_notes(&chat, "x");
        assert_eq!(pending.len(), 1, "only the unanswered note is pending");
        assert!(pending[0].content.contains("nothing new"));
        assert_eq!(system_notes(&chat, "x").len(), 1);
    }

    #[test]
    fn no_update_is_only_offered_alongside_a_note() {
        let tools = crate::tools::definitions();
        let names: Vec<&str> = tools
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str())
            .collect();
        assert!(names.contains(&"no_update"));
        assert!(names.contains(&"list_projects"));
    }

    #[test]
    fn only_an_unanswered_user_message_permits_coding_work() {
        // A note woke the turn, and the user's earlier request was answered.
        let answered = chat_with(vec![
            Message::new("user", "build it", "complete"),
            Message::new("assistant", "Built it.", "complete"),
            Message::hidden("system", "[coding agent update] state: idle"),
        ]);
        assert!(!user_is_waiting(&answered));

        // The user has asked for a change and is waiting for the answer.
        let waiting = chat_with(vec![
            Message::new("assistant", "Built it.", "complete"),
            Message::new("user", "make it bolder", "complete"),
            Message::hidden("system", "[coding agent update] state: idle"),
        ]);
        assert!(user_is_waiting(&waiting));
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
        let history = build_history(&chat, "x", &ReasoningEcho::Auto, true, None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "user");
    }

    #[test]
    fn empty_assistant_placeholders_are_dropped() {
        let user = Message::new("user", "hi", "complete");
        let placeholder = Message::new("assistant", "", "streaming");
        let chat = chat_with(vec![user, placeholder]);
        let history = build_history(&chat, "not-the-placeholder", &ReasoningEcho::Auto, true, None);
        assert_eq!(history.len(), 1);
        assert_eq!(history[0]["role"], "user");
    }

    #[test]
    fn errored_messages_are_not_replayed() {
        let mut bad = Message::new("assistant", "half a thought", "error");
        bad.error = Some("boom".into());
        let user = Message::new("user", "hi", "complete");
        let chat = chat_with(vec![user, bad]);
        assert_eq!(build_history(&chat, "x", &ReasoningEcho::Auto, true, None).len(), 1);
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
