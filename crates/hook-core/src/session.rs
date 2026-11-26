//! The operations a conversation is driven through.
//!
//! Three surfaces reach the same store and the same turn: Tauri's IPC
//! (`commands.rs`), the loopback channel Hook Browser reads (`channel.rs`) and
//! the relay's remote commands (`remote.rs`). A message from the dock, a Stop
//! pressed on a phone, and a Delete in the relay all end up here — one
//! implementation per operation, so the three cannot disagree about what a chat
//! is allowed to do.
//!
//! This module is deliberately free of Tauri: the host process
//! (`crates/hook-host`) has no window and serves the same channel.

use std::sync::Arc;
use std::time::Duration;

use crate::auth::{AuthView, LoginOutcome};
use crate::state::{lock, AppState};
use crate::store::{now_ms, Chat, Message};

/// Remove a conversation this machine owns. Both the local command and the
/// relay's `coding.delete` end here: a host deletes the same way whichever
/// device asked.
pub(crate) fn delete_local_chat(state: &Arc<AppState>, chat_id: &str) -> Result<(), String> {
    let meta = state.store.load(chat_id).ok().map(|chat| chat.meta);
    if let Some(meta) = &meta {
        if meta.is_owned_coding(&state.agents.device_id()) {
            state.sync.forget_stub(chat_id);
        }
    }
    for agent in state.agents.list() {
        if agent.chat_id == chat_id && agent.is_live() {
            let _ = state.agents.stop(&agent.id);
        }
    }
    state.preview.stop_chat(chat_id);
    state.store.delete(chat_id)?;
    state.sync.wake();
    Ok(())
}

/// Starts the device flow for the browser's sign-in card.
///
/// The browser is the thing on screen, so nothing is opened here. The page shows
/// the code and polls `auth/status`; the poll still runs in this process,
/// because `auth.rs` is what writes the shared account file, and the browser only
/// reads it.
pub(crate) async fn begin_browser_sign_in(state: &Arc<AppState>) -> Result<AuthView, String> {
    let (generation, _device_code, _interval) = state.auth.begin().await?;
    let view = state.auth.view();

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

/// Append `message` to `chat`, save it, and start the turn. The window, the
/// browser channel and a remote controller all end here, so a message from any
/// of them looks the same in the store and in the sync queue.
pub(crate) fn commit_and_start(
    state: &Arc<AppState>,
    chat: &mut Chat,
    message: Message,
) -> Result<String, String> {
    chat.messages.push(message);
    state.store.save(chat)?;
    crate::turn::trace("send_message saved");
    state.sync.wake();
    crate::turn::trace("sync woken");

    crate::turn::kick(state.clone(), chat.meta.id.clone());
    // Analytics only: the request has already left, and a personal endpoint is
    // the one thing Hook's own metering never sees.
    if state.settings.custom_provider().is_some() && state.auth.required() {
        crate::analytics::track(state, "byok_turn");
    }
    crate::turn::trace("turn kicked");
    Ok(chat.meta.id.clone())
}

/// A message typed in Hook Browser's dock: text only, an ordinary chat, and the
/// same code path the window uses.
pub(crate) fn send_chat_message(
    state: &Arc<AppState>,
    chat_id: &str,
    text: &str,
) -> Result<(), String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Message is empty".into());
    }
    let mut chat = state.store.load(chat_id)?;
    if crate::coding::is_coding(&chat) {
        return Err("This conversation belongs to a coding agent.".into());
    }
    if chat.meta.remote {
        return Err("This conversation is owned by another machine.".into());
    }
    chat.meta.updated_at = now_ms();
    commit_and_start(state, &mut chat, Message::new("user", text, "complete"))?;
    Ok(())
}

/// Cancel a chat's stream, without the coding/remote branches `stop_stream`
/// needs: the channel only serves ordinary chats.
pub(crate) fn stop_chat_turn(state: &Arc<AppState>, chat_id: &str) {
    if let Some(token) = lock(&state.streams).get(chat_id).cloned() {
        token.cancel();
    }
}

/// One RPC to another machine, with its failure flattened to the sentence the
/// host gave.
pub(crate) async fn remote_rpc(
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
