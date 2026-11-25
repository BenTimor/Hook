//! What every part of the backend shares.
//!
//! `AppState` lives here rather than in `commands.rs` because it is not an IPC
//! concept: the sync engine, the relay, the turn, the coding-agent supervisor
//! and the browser channel all hold it. `commands.rs` is one of its clients (and
//! the only Tauri-typed one), which is why the state cannot live there once the
//! host binary has to build one without a window.
//!
//! It holds no `AppHandle`. A product says what happened through
//! `events::EventSink`, and that is the whole of what the backend needs from a
//! window.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex, MutexGuard};

use crate::agent::AgentManager;
use crate::auth::AuthStore;
use crate::config;
use crate::events::EventSink;
use crate::preview::PreviewManager;
use crate::projects::ProjectsStore;
use crate::provider::CancelToken;
use crate::settings::SettingsStore;
use crate::store::Store;
use crate::turn::{self, TurnState};

pub struct AppState {
    /// Where this process says what happened: a Tauri window, or nothing.
    pub events: Arc<dyn EventSink>,
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
    /// The loopback surface Hook Browser reads (channel.rs).
    pub channel: Arc<crate::channel::Channel>,
    /// The live account connection: presence, remote commands and chat fan-out.
    pub relay: Arc<crate::relay::RelayClient>,
    /// Chats a controller is driving on this machine. Their live turn and agent
    /// events are mirrored to the relay; a chat used only here never leaves the
    /// process.
    pub remote_chats: Arc<Mutex<HashSet<String>>>,
    /// Deltas waiting for the next relay frame of a chat this machine hosts.
    /// Coalesced so a fast model cannot outrun the relay's frame budget.
    pub mirror: turn::MirrorState,
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
    /// The queue this machine's Hook Browser polls for page work
    /// (`browser.rs`). A task is a tool waiting on a tab; the answer is the
    /// page's text. Empty on a product with no browser.
    pub browser: Arc<crate::browser::BrowserTasks>,
    /// Which product this backend is serving (see `Product`).
    pub product: crate::Product,
    /// What this product's chat agent may do (see `Capabilities`).
    pub capabilities: crate::Capabilities,
}

/// A poisoned lock is a bug, not a reason to stop working: the state behind it
/// is still readable, and refusing every later request would be worse.
pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Drop everything that belonged to the signed-in account: live coding agents,
/// in-flight chat streams and the preview server. Used when the token is revoked
/// server-side or the user signs out.
pub(crate) fn revoke_local(state: &AppState) {
    state.agents.kill_all_sync();
    state.preview.stop();
    state.relay.disconnect();
    for token in lock(&state.streams).values() {
        token.cancel();
    }
    lock(&state.streams).clear();
}

impl AppState {
    /// The live context block, if the product set one.
    pub fn chat_context(&self) -> Option<String> {
        lock(&self.context).clone()
    }

    /// Sets the trailing context frame (the browser's active tab, Workspace's
    /// board). Trimmed and capped: it is appended to every turn, so it must not
    /// be able to eat the prompt.
    pub fn set_chat_context(&self, context: &str) {
        let trimmed = context.trim();
        let value = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.chars().take(4000).collect::<String>())
        };
        *lock(&self.context) = value;
    }
}
