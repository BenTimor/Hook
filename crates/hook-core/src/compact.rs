//! Folding a long conversation into a summary.
//!
//! The chat agent replays its whole conversation in every request, which is
//! what keeps the provider's prefix cache hit. That also means a chat only ever
//! grows: after a few hundred turns every reply pays for the entire history.
//! Compaction bounds it. Once a request would spend a share of the context
//! window ([`config::CompactConfig::at`]) the older turns are summarized into
//! one hidden message, and every later request starts from that summary plus
//! the recent turns.
//!
//! This is the one operation that rewrites the request prefix on purpose, so it
//! happens rarely and once: the summary is stored in the chat as a
//! `role: "compaction"` message parked exactly where the cut happened, and
//! [`turn::build_history`] replays from there. A compaction is a model call of
//! its own, part of the turn it belongs to (it repeats the user message id, so
//! the free plan still counts that message once).
//!
//! The message is hidden: it never counts as a message, never becomes a preview,
//! and the simple view never draws it. Advanced mode shows it as the fold it is.

use std::sync::Arc;

use serde_json::json;

use crate::state::AppState;
use crate::config::HarnessConfig;
use crate::provider::{self, CancelToken, Chunk, Outcome, RequestContext};
use crate::store::{now_ms, Chat, Compaction, Message};
use crate::turn::{self, StreamEvent};

/// Roughly four characters per token, the same rule the memory caps use.
const CHARS_PER_TOKEN: u64 = 4;

/// What one picture costs in characters when the count is only an estimate.
/// A picture is not text: it is billed in tiles, around a thousand tokens.
const IMAGE_CHARS: u64 = 4_000;

/// Longest single message handed to the summarizer. Tool output is already
/// truncated when it is written; this keeps one runaway result from filling the
/// request on its own.
const MAX_MESSAGE_CHARS: usize = 6_000;

/// A window no larger than this is treated as a window: a provider that
/// advertises less than a small chat cannot have any use for compaction.
const MIN_WINDOW: u64 = 8_192;

const SUMMARY_SYSTEM: &str = "You compress a conversation so it can continue with less context. Write a summary that another assistant can continue from without seeing the messages it replaces.

Keep, in the language of the conversation:
- what the user wants, and every requirement, preference and constraint they gave
- decisions made and why
- facts worth remembering: names, numbers, paths, identifiers, results
- what was tried and did not work
- what is still open, and the next step

Do not address the user. Do not offer help. Do not invent anything that is not in the conversation. Answer with the summary only, at most 400 words.";

/// Where the model's view of this chat begins: right after the last compaction.
/// Everything before it is either folded into that summary or older than it.
pub fn context_start(chat: &Chat) -> usize {
    chat.messages
        .iter()
        .rposition(|message| message.role == "compaction" && message.status != "streaming")
        .map(|index| index + 1)
        .unwrap_or(0)
}

/// The summary every request starts from, when the chat has been compacted.
pub fn summary(chat: &Chat) -> Option<&str> {
    let start = context_start(chat);
    if start == 0 {
        return None;
    }
    let message = &chat.messages[start - 1];
    let text = message.content.trim();
    (!text.is_empty()).then_some(text)
}

/// The window the share is measured against. A personal endpoint has no promise
/// of the build's number, so it gets the conservative ceiling the engine is
/// told too (`runtime::write_agent_home`).
pub fn window(cfg: &HarnessConfig, byok: bool) -> u64 {
    let window = cfg.compact.window(&cfg.coding).max(MIN_WINDOW);
    if byok {
        window.min(131_072)
    } else {
        window
    }
}

/// Tokens the next request would carry: the last prompt the provider reported,
/// plus everything written since. Before any reply has reported usage this is
/// a character estimate.
pub fn estimate(chat: &Chat) -> u64 {
    estimate_from(chat, context_start(chat))
}

fn estimate_from(chat: &Chat, start: usize) -> u64 {
    let messages = &chat.messages[start.min(chat.messages.len())..];
    if let Some(index) = messages
        .iter()
        .rposition(|message| message.role == "assistant" && message.usage.is_some())
    {
        let usage = messages[index].usage.as_ref().map(|u| u.prompt_tokens as u64).unwrap_or(0);
        let since: u64 = messages[index + 1..].iter().map(estimate_message).sum();
        return usage + since;
    }
    messages.iter().map(estimate_message).sum()
}

fn estimate_message(message: &Message) -> u64 {
    let mut chars = message.content.chars().count() as u64;
    if let Some(reasoning) = &message.reasoning {
        chars += reasoning.chars().count() as u64;
    }
    if let Some(calls) = &message.tool_calls {
        for call in calls {
            chars += (call.name.chars().count() + call.arguments.chars().count()) as u64 + 12;
        }
    }
    chars += message.attachments.len() as u64 * IMAGE_CHARS;
    chars / CHARS_PER_TOKEN + 4
}

/// What a compaction would fold: everything before the `keep_turns`-th newest
/// user turn, so the cut never separates a tool call from its result.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Plan {
    /// Index in `chat.messages` of the first message kept.
    pub cut: usize,
    /// How many of the chat's messages the summary folds.
    pub messages: usize,
    pub tokens_before: u64,
}

pub fn plan(chat: &Chat, keep_turns: usize) -> Option<Plan> {
    let start = context_start(chat);
    let users: Vec<usize> = (start..chat.messages.len())
        .filter(|&index| chat.messages[index].role == "user")
        .collect();
    let keep = keep_turns.max(1);
    if users.len() <= keep {
        return None;
    }
    let cut = users[users.len() - keep];
    if cut <= start {
        return None;
    }
    Some(Plan {
        cut,
        messages: cut - start,
        tokens_before: estimate(chat),
    })
}

/// Whether this turn should compact before it asks the model, and what it would
/// fold. `None` when the chat is small enough, already compacted, or the build
/// turned compaction off.
pub fn wanted(chat: &Chat, cfg: &HarnessConfig, byok: bool) -> Option<Plan> {
    if !cfg.compact.enabled {
        return None;
    }
    let plan = plan(chat, cfg.compact.keep_turns)?;
    let threshold = (window(cfg, byok) as f64 * cfg.compact.share() as f64) as u64;
    (plan.tokens_before >= threshold).then_some(plan)
}

/// Drop a compaction that never finished.
///
/// A window that closed while a summary was being written leaves a marker with
/// status `streaming` and no text, and a message in that state keeps the chat
/// out of sync for good. The summary never arrived, so the conversation is
/// exactly what it was before the attempt: the marker is removed, not repaired.
pub fn recover(store: &crate::store::Store) {
    let Ok(metas) = store.list() else {
        return;
    };
    for meta in metas {
        let Ok(mut chat) = store.load(&meta.id) else {
            continue;
        };
        let before = chat.messages.len();
        chat.messages
            .retain(|message| !(message.role == "compaction" && message.status == "streaming"));
        if chat.messages.len() == before {
            continue;
        }
        chat.meta.updated_at = now_ms();
        if let Err(error) = store.save(&mut chat) {
            eprintln!("hook: could not drop an unfinished compaction: {error}");
        }
    }
}

/// Whether a provider's refusal means the request did not fit its window.
/// The share is an estimate; this is the endpoint saying so, and the only
/// trigger left when the configured window is larger than the model's.
pub fn looks_like_overflow(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    [
        "context_length_exceeded",
        "context length",
        "context window",
        "maximum context",
        "too many tokens",
        "prompt is too long",
        "reduce the length",
        "input is too long",
        "exceeds the maximum",
    ]
    .iter()
    .any(|needle| error.contains(needle))
}

/// Fold the older turns of `chat` into one hidden summary message.
///
/// Writes the summary at the cut, so it lands where the conversation was cut
/// and [`context_start`] sees it from then on. A failure removes the marker and
/// leaves the chat exactly as it was: an automatic compaction that could not
/// run must not damage the conversation it was trying to shrink.
///
/// `Ok(false)` is a stop, not a failure: the chat is unchanged and the caller
/// should not report anything.
pub async fn run(
    state: &Arc<AppState>,
    chat_id: &str,
    cfg: &HarnessConfig,
    token: &str,
    byok: bool,
    message_id: Option<String>,
    instructions: Option<&str>,
    cancel: CancelToken,
) -> Result<bool, String> {
    let mut chat = state
        .store
        .load(chat_id)
        .map_err(|_| "This chat could not be read.".to_string())?;
    let plan = plan(&chat, cfg.compact.keep_turns)
        .ok_or("There is not enough conversation to compact yet.")?;

    let mut marker = Message::compaction("");
    marker.status = "streaming".into();
    marker.compaction = Some(Compaction {
        messages: plan.messages,
        tokens_before: plan.tokens_before,
        tokens_after: 0,
    });
    let marker_id = marker.id.clone();
    chat.messages.insert(plan.cut, marker);
    chat.meta.updated_at = now_ms();
    state.store.save(&mut chat)?;
    turn::emit(
        state,
        chat_id,
        StreamEvent::Started {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
    // The simple view draws the activity line while there is no reply to show;
    // it must not say "compacting" or the user would see the mechanism.
    turn::emit(
        state,
        chat_id,
        StreamEvent::Activity {
            label: Some("Thinking…".into()),
        },
    );

    let context = RequestContext::chat(chat_id.to_string())
        .for_message(message_id)
        .byok(byok);
    let mut text = String::new();
    let outcome = provider::stream_chat(
        cfg,
        token,
        &context,
        &summary_request(&chat, &plan, instructions),
        None,
        cancel,
        |chunk| {
            if let Chunk::Text(delta) = chunk {
                text.push_str(&delta);
            }
        },
    )
    .await;

    let mut chat = state
        .store
        .load(chat_id)
        .map_err(|_| "This chat could not be read.".to_string())?;
    let Some(index) = chat.messages.iter().position(|m| m.id == marker_id) else {
        return Err("The conversation changed while it was being compacted.".into());
    };
    let summary = text.trim().to_string();
    if let Ok(Outcome::Cancelled) = outcome {
        chat.messages.remove(index);
        chat.meta.updated_at = now_ms();
        let _ = state.store.save(&mut chat);
        return Ok(false);
    }
    let failure = match &outcome {
        Ok(Outcome::Completed(_)) if !summary.is_empty() => None,
        Ok(Outcome::Completed(_)) => Some("The summary came back empty.".to_string()),
        _ => outcome.err(),
    };
    if let Some(error) = failure {
        chat.messages.remove(index);
        chat.meta.updated_at = now_ms();
        let _ = state.store.save(&mut chat);
        return Err(error);
    }

    let tokens_after = {
        let mut total = 0u64;
        for message in &chat.messages[index + 1..] {
            total += estimate_message(message);
        }
        let mut head = Message::compaction(&summary);
        head.status = "complete".into();
        total + estimate_message(&head)
    };
    let entry = &mut chat.messages[index];
    entry.content = summary;
    entry.status = "complete".into();
    if let Some(info) = entry.compaction.as_mut() {
        info.tokens_after = tokens_after;
    }
    chat.meta.updated_at = now_ms();
    state.store.save(&mut chat)?;
    turn::emit(
        state,
        chat_id,
        StreamEvent::Started {
            messages: chat.messages.clone(),
            meta: chat.meta.clone(),
        },
    );
    Ok(true)
}

/// The request that writes the summary: the running summary (when this chat was
/// compacted before), then the turns being folded away. `/compact` may add what
/// the reader wants kept.
fn summary_request(chat: &Chat, plan: &Plan, instructions: Option<&str>) -> Vec<serde_json::Value> {
    let start = context_start(chat);
    let mut body = String::new();
    if let Some(previous) = summary(chat) {
        body.push_str("Summary of the conversation up to now:\n");
        body.push_str(previous);
        body.push_str("\n\nIt continues:\n");
    } else {
        body.push_str("The conversation so far:\n");
    }
    for message in &chat.messages[start..plan.cut] {
        let label = match message.role.as_str() {
            "user" => "User",
            "assistant" => "Assistant",
            "tool" => "Tool result",
            "system" => "Context",
            _ => continue,
        };
        body.push_str(&format!("\n{label}:\n{}\n", clip(&message.content, MAX_MESSAGE_CHARS)));
        if let Some(calls) = &message.tool_calls {
            if !calls.is_empty() {
                let names: Vec<&str> = calls.iter().map(|call| call.name.as_str()).collect();
                body.push_str(&format!("(called: {})\n", names.join(", ")));
            }
        }
    }
    if let Some(instructions) = instructions.map(str::trim).filter(|text| !text.is_empty()) {
        body.push_str("\nWhat the user wants the summary to keep:\n");
        body.push_str(instructions);
        body.push('\n');
    }
    vec![
        json!({ "role": "system", "content": SUMMARY_SYSTEM }),
        json!({ "role": "user", "content": body }),
    ]
}
fn clip(text: &str, max: usize) -> String {
    let flat = text.trim();
    if flat.chars().count() <= max {
        return flat.to_string();
    }
    let mut cut: String = flat.chars().take(max).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    fn message(role: &str, content: &str) -> Message {
        Message::new(role, content, "complete")
    }

    fn chat(roles: &[(&str, &str)]) -> Chat {
        let mut chat = Chat::new();
        chat.messages = roles
            .iter()
            .map(|(role, content)| message(role, content))
            .collect();
        chat
    }

    #[test]
    fn a_plan_cuts_on_a_user_turn() {
        let chat = chat(&[
            ("user", "one"),
            ("assistant", "answer one"),
            ("user", "two"),
            ("assistant", "answer two"),
            ("user", "three"),
            ("assistant", "answer three"),
            ("user", "four"),
            ("assistant", "answer four"),
        ]);
        let plan = plan(&chat, 2).expect("four user turns leave two to fold");
        assert_eq!(plan.cut, 4);
        assert_eq!(plan.messages, 4);
        // The kept block starts with a user message, never a tool result.
        assert_eq!(chat.messages[plan.cut].role, "user");
    }

    #[test]
    fn a_short_chat_is_not_compacted() {
        let chat = chat(&[("user", "one"), ("assistant", "answer")]);
        assert!(plan(&chat, 3).is_none());
        assert!(wanted(&chat, &cfg(), false).is_none());
    }

    #[test]
    fn a_compacted_chat_is_bounded_by_its_summary() {
        let mut chat = chat(&[
            ("user", "one"),
            ("assistant", "answer one"),
            ("user", "two"),
            ("assistant", "answer two"),
        ]);
        let mut marker = Message::compaction("the summary");
        marker.status = "complete".into();
        chat.messages.insert(0, marker);
        assert_eq!(context_start(&chat), 1);
        assert_eq!(summary(&chat), Some("the summary"));
        // The turns before the marker are no longer part of the budget.
        let kept: u64 = chat.messages[1..].iter().map(estimate_message).sum();
        assert_eq!(estimate(&chat), kept);
    }

    #[test]
    fn the_summary_request_carries_the_running_summary() {
        let mut chat = chat(&[
            ("user", "one"),
            ("assistant", "answer one"),
            ("user", "two"),
            ("assistant", "answer two"),
            ("user", "three"),
        ]);
        let mut marker = Message::compaction("folded earlier");
        marker.status = "complete".into();
        chat.messages.insert(0, marker);
        let plan = plan(&chat, 1).expect("two turns after the marker");
        let request = summary_request(&chat, &plan, Some("keep the numbers"));
        let body = request[1]["content"].as_str().unwrap();
        assert!(body.contains("folded earlier"));
        assert!(body.contains("answer one"));
        assert!(body.contains("answer two"));
        // The turn that is being kept verbatim is not part of the summary.
        assert!(!body.contains("three"));
    }

    #[test]
    fn a_too_long_refusal_is_recognized() {
        assert!(looks_like_overflow(
            "400 · {\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"This model's maximum context length is 131072 tokens.\"}}"
        ));
        assert!(looks_like_overflow("The prompt is too long for this model."));
        assert!(!looks_like_overflow("401 · invalid api key"));
        assert!(!looks_like_overflow("400 · tool_calls must be followed by tool messages"));
    }

    #[test]
    fn the_threshold_is_a_share_of_the_window() {
        let mut cfg = cfg();
        cfg.compact.at = 0.30;
        cfg.compact.keep_turns = 2;
        cfg.coding.context_window = 10_000;
        let mut chat = chat(&[
            ("user", "one"),
            ("assistant", &"x".repeat(2_400)),
            ("user", "two"),
            ("assistant", "a"),
            ("user", "three"),
        ]);
        // ~600 tokens of history: under the 3000-token share.
        assert!(wanted(&chat, &cfg, false).is_none());
        chat.messages[1].content = "x".repeat(24_000);
        // ~6000 tokens: over the share, and there are turns to fold.
        assert!(wanted(&chat, &cfg, false).is_some());
    }

    fn cfg() -> HarnessConfig {
        toml::from_str(
            r#"
[provider]
base_url = "https://example.invalid"
api_key = "test"
[model]
name = "test-model"
"#,
        )
        .expect("test config")
    }
}
