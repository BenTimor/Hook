//! Two-way sync of conversations and project metadata.
//!
//! Everything here runs in the background for an account that may sync: a paid
//! plan whose account-wide switch is on. A free account, or one that switched
//! sync off, still has its ownership settled — so the next account cannot
//! inherit its chats — but sends nothing. There is no button: a cycle pulls
//! changes, pushes local ones, and lets the server merge them. Code is not in this module — that is real git, driven by the agents
//! and prepared here (repository, remote, first snapshot, first pull).
//!
//! Order matters. Pushing before pulling means the server always sees a
//! device's latest version and can merge it with the other devices' versions;
//! applying the result afterwards makes every machine converge. A chat that is
//! streaming locally is never pushed or overwritten: its turn finishes first.
//!
//! State lives in `sync.json` (owner, cursor, pending ids). The cursor is the
//! account's monotonic sequence, so one integer describes what this device has
//! seen. The merge itself happens once, on the server (`server/sync.mjs`).

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::auth::AuthStore;
use crate::git::{self, GitRuntime};
use crate::memory::{Entry, MemoryStore};
use crate::projects::ProjectsStore;
use crate::settings::SettingsStore;
use crate::store::{now_ms, sha256_hex, Chat, ChatMeta, Store, KIND_CODING};

const CYCLE: Duration = Duration::from_secs(15);
const MAX_BACKOFF: Duration = Duration::from_secs(120);
/// How often the account itself is checked while the app is running. A plan
/// change or a sync switch flipped in another product must reach this window
/// without a restart; a minute is soon enough for both.
const ACCOUNT_CHECK: Duration = Duration::from_secs(60);
const MAX_BATCH: usize = 10;
const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREPARED_PER_CYCLE: usize = 3;
const MEDIA_MEMORY: usize = 2000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The id shape the account accepts (`server/sync.mjs`), checked before an id is
/// sent so one bad entry cannot reject a whole batch.
fn project_id_ok(id: &str) -> bool {
    (4..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    /// The account this local workspace belongs to. A different account gets a
    /// fresh workspace; the previous one is moved aside, never uploaded.
    owner: String,
    cursor: i64,
    /// Uploads that have not been accepted yet (a failed batch, a chat that was
    /// streaming). Persisted so a restart resumes instead of forgetting.
    pending_chats: Vec<String>,
    /// Fingerprint of each project's name + description as last accepted.
    project_versions: HashMap<String, String>,
    /// Content hashes already uploaded, so a picture is sent once.
    media: Vec<String>,
    /// Projects whose repository is prepared on this machine.
    prepared: Vec<String>,
    /// Projects deleted here whose row on the account still exists. Sent once,
    /// then forgotten; without the tombstone the next pull creates the folder
    /// again and the account's copy can never be removed.
    #[serde(default)]
    pending_project_deletes: Vec<String>,
    /// Fingerprint of each owned direct chat's stub as last accepted, so an
    /// unchanged stub is not pushed every cycle.
    #[serde(default)]
    stub_versions: HashMap<String, String>,
    /// Stubs whose chat was deleted here; sent once, then forgotten.
    #[serde(default)]
    pending_stub_deletes: Vec<String>,
    /// The personal-endpoint change stamp last pushed to or adopted from the
    /// account. An unchanged endpoint is not sent every cycle, and one that was
    /// adopted is not echoed straight back.
    #[serde(default)]
    provider_synced_at: i64,
}

/// What the Settings sheet (and support) can show without exposing any git.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    /// The engine is actually syncing: a paid account whose cloud-sync switch
    /// is on.
    pub enabled: bool,
    /// The plan allows cloud sync at all. A free account has nothing to switch.
    pub available: bool,
    /// Why sync is off, when it is: `free` or `off` (the account's switch).
    /// `None` when sync is running or the build has no account service.
    pub reason: Option<String>,
    /// off | idle | syncing | error
    pub state: String,
    pub cursor: i64,
    pub pending: usize,
    pub last_sync_at: i64,
    pub message: Option<String>,
}

/// `(available, enabled, reason)` for the signed-in account.
///
/// The switch is account state, not product state: it is read from the account
/// and changed through `/api/auth/preferences`, so flipping it in Hook also
/// stops Workspace and the phone. A free account never syncs.
fn policy_for(auth: &AuthStore) -> (bool, bool, Option<&'static str>) {
    // No session, no sync: signing out would otherwise leave the last plan's
    // answer on screen until the next sign-in.
    if !auth.required() || auth.token().is_none() {
        return (false, false, None);
    }
    if auth.is_free() {
        return (false, false, Some("free"));
    }
    if auth.cloud_sync() == Some(false) {
        return (true, false, Some("off"));
    }
    (true, true, None)
}

/// How the engine tells the window that something arrived. A closure keeps the
/// engine testable without a running Tauri app.
pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Called when a value the window reads from `settings.json` came from the
/// account (the personal endpoint), so the product can probe the new model
/// again. Optional: a headless build and the tests have nothing to poke.
pub type SettingsSignal = Arc<dyn Fn() + Send + Sync>;

pub struct SyncEngine {
    emit: Emitter,
    data_dir: PathBuf,
    auth: Arc<AuthStore>,
    store: Arc<Store>,
    projects: Arc<ProjectsStore>,
    settings: Arc<SettingsStore>,
    memory: Arc<MemoryStore>,
    git: Option<GitRuntime>,
    state: Mutex<SyncState>,
    view: Mutex<SyncView>,
    /// When `/api/auth/me` was last asked. The plan and the sync switch are
    /// account state another product may change, so every window converges.
    account_checked_at: Mutex<i64>,
    notify: Notify,
    client: reqwest::Client,
    configured_token: Mutex<Option<String>>,
    media_seen: Mutex<HashSet<String>>,
    settings_changed: std::sync::OnceLock<SettingsSignal>,
    /// One attempt per run to share this window's advanced mode with an account
    /// that has never stored one. A retry loop would only fill the log while the
    /// account service has not learned about the preference yet.
    advanced_seed_attempted: AtomicBool,
}

impl SyncEngine {
    pub fn new(
        emit: Emitter,
        data_dir: &Path,
        auth: Arc<AuthStore>,
        store: Arc<Store>,
        projects: Arc<ProjectsStore>,
        settings: Arc<SettingsStore>,
        memory: Arc<MemoryStore>,
        git: Option<GitRuntime>,
    ) -> Self {
        let path = data_dir.join("sync.json");
        let state = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SyncState>(&raw).ok())
            .unwrap_or_default();
        let media_seen = state.media.iter().cloned().collect();
        let (available, enabled, reason) = policy_for(&auth);
        let view = SyncView {
            enabled,
            available,
            reason: reason.map(str::to_string),
            state: if enabled { "idle".into() } else { "off".into() },
            cursor: state.cursor,
            pending: state.pending_chats.len(),
            last_sync_at: 0,
            message: None,
        };
        let engine = Self {
            emit,
            data_dir: data_dir.to_path_buf(),
            auth,
            store,
            projects,
            settings,
            memory,
            git,
            state: Mutex::new(state),
            view: Mutex::new(view),
            account_checked_at: Mutex::new(0),
            notify: Notify::new(),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            configured_token: Mutex::new(None),
            media_seen: Mutex::new(media_seen),
            settings_changed: std::sync::OnceLock::new(),
            advanced_seed_attempted: AtomicBool::new(false),
        };
        // A device that has never synced uploads the whole local history once.
        if engine.auth.required() && engine.state.lock().map(|s| s.owner.is_empty()).unwrap_or(true) {
            engine.store.mark_all_dirty();
        }
        engine
    }

    pub fn status(&self) -> SyncView {
        let (available, enabled, reason) = policy_for(&self.auth);
        let mut view = lock(&self.view).clone();
        view.available = available;
        view.enabled = enabled;
        view.reason = reason.map(str::to_string);
        if !enabled {
            // The stored view can still say `idle` from before the switch was
            // flipped. A window that asks now must not draw a lie.
            view.state = "off".into();
            view.message = None;
        }
        view.pending = self
            .state
            .lock()
            .map(|s| s.pending_chats.len())
            .unwrap_or(0)
            .max(self.store.dirty_count());
        view.cursor = lock(&self.state).cursor;
        view
    }

    /// Ask the loop to run now (sign-in, window focus, a finished turn).
    pub fn wake(&self) {
        self.notify.notify_one();
    }

    /// The product's reaction to an endpoint that arrived from the account.
    pub fn on_settings_changed(&self, signal: SettingsSignal) {
        let _ = self.settings_changed.set(signal);
    }

    /// A deleted direct chat is back. Drop the tombstone that has not been sent
    /// yet and let the next push describe it again.
    pub fn revive_stub(&self, chat_id: &str) {
        {
            let mut state = lock(&self.state);
            state.pending_stub_deletes.retain(|id| id != chat_id);
            state.stub_versions.remove(chat_id);
        }
        let _ = self.save_state();
        self.notify.notify_one();
    }

    /// The owner deleted a direct chat: its stub has to go too, or every other
    /// device keeps listing a conversation that no longer exists. The tombstone
    /// is sent on the next cycle; the chat file is already gone by then.
    pub fn forget_stub(&self, chat_id: &str) {
        {
            let mut state = lock(&self.state);
            if !state.pending_stub_deletes.iter().any(|id| id == chat_id) {
                state.pending_stub_deletes.push(chat_id.to_string());
            }
            state.stub_versions.remove(chat_id);
        }
        if let Err(error) = self.save_state() {
            eprintln!("hook: could not remember a deleted remote stub: {error}");
        }
        self.notify.notify_one();
    }

    pub fn spawn(self: Arc<Self>) {
        crate::rt::spawn(async move {
            let mut failures = 0u32;
            loop {
                if self.auth.token().is_some() {
                    match self.cycle().await {
                        Ok(()) => {
                            failures = 0;
                            let mut view = lock(&self.view);
                            view.state = "idle".into();
                            view.message = None;
                            view.last_sync_at = now_ms();
                        }
                        Err(error) => {
                            failures = failures.saturating_add(1);
                            eprintln!("hook: sync failed: {error}");
                            let mut view = lock(&self.view);
                            view.state = "error".into();
                            view.message = Some(error);
                        }
                    }
                }
                let backoff = if failures == 0 {
                    CYCLE
                } else {
                    std::cmp::min(
                        MAX_BACKOFF,
                        Duration::from_secs(2u64.saturating_pow(failures.min(6))),
                    )
                };
                tokio::select! {
                    _ = tokio::time::sleep(backoff) => {}
                    _ = self.notify.notified() => {}
                }
            }
        });
    }

    fn base(&self) -> &str {
        self.auth.base_url().trim_end_matches('/')
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base())
    }

    fn save_state(&self) -> Result<(), String> {
        let state = lock(&self.state).clone();
        let raw = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
        crate::store::write_atomic(&self.data_dir.join("sync.json"), raw.as_bytes())
    }

    async fn cycle(&self) -> Result<(), String> {
        if !self.auth.required() {
            return Ok(());
        }
        let Some(token) = self.auth.token() else {
            return Ok(());
        };
        let Some(owner) = self.auth.subject() else {
            return Ok(());
        };
        // Ownership is settled even when nothing may leave this computer. A free
        // account (or an account with the switch off) that signs out must not
        // leave its conversations where the next account would inherit them on
        // its first paid sync. Memory is account data too, and both products read
        // it, so it is bound here rather than after the policy check.
        self.ensure_owner(&owner)?;
        self.memory.bind(Some(&owner));
        // The account is checked even when sync is off: the plan and the switch
        // live on the server, and another product may have changed them.
        self.refresh_account().await;
        let (_, enabled, _) = policy_for(&self.auth);
        if !enabled {
            lock(&self.view).state = "off".into();
            return Ok(());
        }
        lock(&self.view).state = "syncing".into();
        self.configure_git().await;
        self.push_chats(&token).await?;
        // A stub is a convenience for other devices; an older account service
        // without the route must not stop ordinary chats from syncing.
        if let Err(error) = self.push_remote_stubs(&token).await {
            eprintln!("hook: remote chat stubs: {error}");
        }
        self.push_projects(&token).await?;
        self.push_memory(&token).await?;
        // The personal endpoint is small but is a credential: push what this
        // device has, then adopt a newer one from another device.
        if let Err(error) = self.sync_provider(&token).await {
            eprintln!("hook: personal endpoint: {error}");
        }
        self.pull(&token).await?;
        self.prepare_projects().await;
        Ok(())
    }

    /// Ask the account service who this is now: plan, approval and the
    /// cloud-sync switch. A change is announced on `hook://auth`, which is the
    /// same event sign-in uses, so every window redraws from one place.
    async fn refresh_account(&self) {
        let now = now_ms();
        let due = {
            let mut last = lock(&self.account_checked_at);
            if now.saturating_sub(*last) < ACCOUNT_CHECK.as_millis() as i64 {
                false
            } else {
                *last = now;
                true
            }
        };
        if !due {
            return;
        }
        let before = (
            self.auth.plan(),
            self.auth.cloud_sync(),
            self.auth.advanced_mode(),
        );
        match self.auth.refresh().await {
            crate::auth::RefreshOutcome::Revoked(message) => {
                self.auth.clear_session();
                let view = crate::auth::AuthView::signed_out(Some(message));
                if let Ok(value) = serde_json::to_value(view) {
                    let _ = (self.emit)("hook://auth", value);
                }
                return;
            }
            crate::auth::RefreshOutcome::Unreachable(error) => {
                eprintln!("hook: could not check the account: {error}");
            }
            crate::auth::RefreshOutcome::Valid => {}
        }
        // The account has never stored a display preference, and this window has
        // one switched on: share it. Without this, a computer that already had
        // advanced mode on would not reach the phone until somebody toggled it
        // twice. Only `true` is seeded — `false` is the default everywhere.
        if self.auth.advanced_mode().is_none()
            && self.settings.advanced_mode()
            && !self.advanced_seed_attempted.swap(true, Ordering::SeqCst)
        {
            if let Err(error) = self.auth.set_advanced_mode(true).await {
                eprintln!("hook: could not share advanced mode: {error}");
            }
        }
        // Keep the local fallback in step with the account that just answered,
        // so a signed-out window does not draw a view the account turned off.
        if let Some(enabled) = self.auth.advanced_mode() {
            if self.settings.advanced_mode() != enabled {
                if let Err(error) = self.settings.set_advanced_mode(enabled) {
                    eprintln!("hook: could not cache advanced mode: {error}");
                }
            }
        }
        if before
            != (
                self.auth.plan(),
                self.auth.cloud_sync(),
                self.auth.advanced_mode(),
            )
        {
            if let Ok(value) = serde_json::to_value(self.auth.view()) {
                let _ = (self.emit)("hook://auth", value);
            }
        }
    }

    fn ensure_owner(&self, owner: &str) -> Result<(), String> {
        let (current, first) = {
            let state = lock(&self.state);
            (state.owner.clone(), state.owner.is_empty())
        };
        if first {
            lock(&self.state).owner = owner.to_string();
            self.store.mark_all_dirty();
            self.save_state()?;
            return Ok(());
        }
        if current == owner {
            return Ok(());
        }
        self.quarantine(owner)
    }

    /// A different account signed in on this machine. Move every conversation
    /// that belongs to the previous one out of the live folders so it can never
    /// be uploaded to the new account. Project folders are the user's files and
    /// stay where they are.
    fn quarantine(&self, owner: &str) -> Result<(), String> {
        let old = lock(&self.state).owner.clone();
        let tag = &sha256_hex(old.as_bytes())[..16];
        let dest = self.data_dir.join("accounts").join(tag);
        fs::create_dir_all(&dest).map_err(|e| format!("create account folder: {e}"))?;
        self.store.quarantine(&dest)?;
        self.projects.clear_notes()?;
        *lock(&self.state) = SyncState {
            owner: owner.to_string(),
            ..SyncState::default()
        };
        lock(&self.media_seen).clear();
        self.save_state()?;
        eprintln!(
            "hook: a different account signed in; previous conversations moved to {}",
            dest.display()
        );
        Ok(())
    }

    async fn configure_git(&self) {
        if self.git.is_none() {
            return;
        }
        let token = self.auth.ensure_git_token().await;
        let current = lock(&self.configured_token).clone();
        if current == token {
            return;
        }
        match git::write_agent_config(
            &self.data_dir.join("agent-home"),
            self.auth.base_url(),
            token.as_deref(),
        ) {
            Ok(_) => *lock(&self.configured_token) = token,
            Err(error) => eprintln!("hook: {error}"),
        }
    }

    async fn post(&self, token: &str, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .post(self.url(path))
            .bearer_auth(token)
            .header("x-hook-device", self.auth.device_id())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Could not reach Hook: {e}"))?;
        self.parse(response).await
    }

    async fn get(&self, token: &str, path: &str) -> Result<Value, String> {
        let response = self
            .client
            .get(self.url(path))
            .bearer_auth(token)
            .header("x-hook-device", self.auth.device_id())
            .send()
            .await
            .map_err(|e| format!("Could not reach Hook: {e}"))?;
        self.parse(response).await
    }

    async fn put(&self, token: &str, path: &str, body: Value) -> Result<Value, String> {
        let response = self
            .client
            .put(self.url(path))
            .bearer_auth(token)
            .header("x-hook-device", self.auth.device_id())
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("Could not reach Hook: {e}"))?;
        self.parse(response).await
    }

    async fn parse(&self, response: reqwest::Response) -> Result<Value, String> {
        let status = response.status();
        let value: Value = response.json().await.unwrap_or(Value::Null);
        if status.is_success() {
            return Ok(value);
        }
        let message = value
            .get("error")
            .and_then(|error| error.get("message"))
            .and_then(|message| message.as_str())
            .unwrap_or(status.as_str())
            .to_string();
        Err(format!("Hook sync: {message}"))
    }

    // ── push ────────────────────────────────────────────────────────────
    /// Push the existence of this machine's direct coding chats. The stub is
    /// deliberately tiny: a viewer learns there is a conversation, which host
    /// owns it and that it is running, and asks that host for the transcript
    /// over the relay. No message, folder or session id enters the account.
    async fn push_remote_stubs(&self, token: &str) -> Result<(), String> {
        let device = self.auth.device_id();
        let owned: Vec<ChatMeta> = self
            .store
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|meta| meta.is_owned_coding(&device))
            .collect();
        let pending = lock(&self.state).pending_stub_deletes.clone();
        let mut chats: Vec<Value> = Vec::new();
        let mut versions: HashMap<String, String> = HashMap::new();
        for meta in owned {
            let state = self.stub_state(&meta.id);
            let fingerprint = format!(
                "{}|{}|{}|{}",
                meta.updated_at, meta.message_count, state, meta.title
            );
            let unchanged = lock(&self.state)
                .stub_versions
                .get(&meta.id)
                .map(|known| known == &fingerprint)
                .unwrap_or(false);
            if unchanged {
                continue;
            }
            chats.push(json!({
                "id": meta.id,
                "title": meta.title,
                "createdAt": meta.created_at,
                "updatedAt": meta.updated_at,
                "state": state,
                "messageCount": meta.message_count,
                "deleted": false,
            }));
            versions.insert(meta.id, fingerprint);
        }
        for id in &pending {
            chats.push(json!({
                "id": id,
                "deleted": true,
                "updatedAt": now_ms(),
            }));
        }
        if chats.is_empty() {
            return Ok(());
        }

        for batch in chats.chunks(MAX_BATCH) {
            let response = self
                .post(token, "/api/sync/remote-chats", json!({ "chats": batch }))
                .await?;
            let accepted: std::collections::HashSet<String> = response["chats"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .filter(|item| item["ok"].as_bool() == Some(true))
                .filter_map(|item| item["id"].as_str().map(str::to_string))
                .collect();
            let mut guard = lock(&self.state);
            for item in batch {
                let Some(id) = item["id"].as_str() else {
                    continue;
                };
                if item["deleted"].as_bool() == Some(true) {
                    if accepted.contains(id) {
                        guard.pending_stub_deletes.retain(|pending| pending != id);
                    }
                } else if accepted.contains(id) {
                    if let Some(fingerprint) = versions.get(id) {
                        guard.stub_versions.insert(id.to_string(), fingerprint.clone());
                    }
                } else {
                    // The server refused (the row belongs to another device).
                    // Retrying the same id would only repeat the refusal; keep
                    // the version we know so the next mutation tries again.
                    guard.stub_versions.remove(id);
                }
            }
        }
        self.save_state()
    }

    /// `running` when the engine is writing, `error` when the last reply is one;
    /// otherwise idle. This is the durable half of the badge a viewer draws from
    /// a stub; live state also arrives over the relay while the chat is open.
    fn stub_state(&self, chat_id: &str) -> String {
        let Ok(chat) = self.store.load(chat_id) else {
            return "idle".into();
        };
        if chat
            .messages
            .iter()
            .any(|message| message.status == "streaming")
        {
            return "running".into();
        }
        match chat
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "assistant")
            .map(|message| message.status.as_str())
        {
            Some("error") => "error".into(),
            _ => "idle".into(),
        }
    }

    async fn push_chats(&self, token: &str) -> Result<(), String> {
        let mut ids = self.store.dirty_ids();
        for id in lock(&self.state).pending_chats.clone() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids.sort();
        ids.dedup();
        // A coding-agent chat is this computer's own: its folder, its session
        // file and its engine process do not exist elsewhere, so uploading it
        // would hand another machine a conversation it cannot continue. Ids
        // still in the queue from an older build (a delete, a restore) are
        // dropped here rather than retried forever.
        let local: std::collections::HashSet<String> = self
            .store
            .list()
            .unwrap_or_default()
            .into_iter()
            .filter(|meta| meta.is_local_only())
            .map(|meta| meta.id)
            .collect();
        if !local.is_empty() {
            for id in &ids {
                if local.contains(id) {
                    self.store.clear_dirty(id);
                }
            }
            ids.retain(|id| !local.contains(id));
        }
        if ids.is_empty() {
            return Ok(());
        }
        // Persist the intention before the first byte: a crash mid-upload then
        // resumes from the same list instead of forgetting it.
        lock(&self.state).pending_chats = ids.clone();
        self.save_state()?;

        // Serialize first, so batches can be split by real size (one chat with
        // a long tool transcript can be megabytes on its own).
        let restored = self.store.restored_ids();
        let mut prepared: Vec<(String, Value, i64)> = Vec::new();
        let mut retry: Vec<String> = Vec::new();
        for id in &ids {
            match self.store.load(id) {
                Ok(mut chat) => {
                    if chat
                        .messages
                        .iter()
                        .any(|message| message.status == "streaming")
                    {
                        retry.push(id.clone());
                        continue;
                    }
                    self.upload_media(token, &mut chat).await;
                    let version = chat.meta.updated_at;
                    let mut value = serde_json::to_value(&chat).map_err(|e| e.to_string())?;
                    if restored.iter().any(|entry| entry == id) {
                        value["restored"] = json!(true);
                    }
                    let size = serde_json::to_vec(&value).map(|bytes| bytes.len()).unwrap_or(0);
                    if size > MAX_BATCH_BYTES {
                        // The account accepts up to 8 MB per conversation. A
                        // half-uploaded history would be worse than an honest
                        // local-only chat, so leave it here and say so once.
                        eprintln!(
                            "hook: conversation {} is too large to sync ({size} bytes); it stays local",
                            chat.meta.id
                        );
                        self.store.clear_dirty(id);
                        continue;
                    }
                    prepared.push((id.clone(), value, version));
                }
                Err(_) => prepared.push((
                    id.clone(),
                    json!({ "id": id, "deleted": true, "updatedAt": now_ms() }),
                    0,
                )),
            }
        }

        let mut index = 0;
        while index < prepared.len() {
            let mut end = index;
            let mut bytes = 0usize;
            while end < prepared.len() && end - index < MAX_BATCH {
                let size = serde_json::to_string(&prepared[end].1)
                    .map(|text| text.len())
                    .unwrap_or(0);
                if end > index && bytes + size > MAX_BATCH_BYTES {
                    break;
                }
                bytes += size;
                end += 1;
            }
            let batch = &prepared[index..end];
            index = end;

            let sends: Vec<Value> = batch.iter().map(|(_, value, _)| value.clone()).collect();
            let versions: Vec<(String, i64)> = batch
                .iter()
                .map(|(id, _, version)| (id.clone(), *version))
                .collect();
            let response = self
                .post(token, "/api/sync/chats", json!({ "chats": sends }))
                .await?;
            let mut applied: Vec<String> = Vec::new();
            if let Some(results) = response["results"].as_array() {
                for result in results {
                    let Some(id) = result["id"].as_str() else {
                        continue;
                    };
                    if result["deleted"].as_bool() == Some(true) {
                        self.store.remove_synced(id);
                        applied.push(id.to_string());
                    } else if let Some(chat_value) = result.get("chat") {
                        match serde_json::from_value::<Chat>(chat_value.clone()) {
                            Ok(mut chat) => {
                                if self.local_wins(id, &chat) {
                                    // The turn wrote while this request was in
                                    // flight, so the merged copy predates the
                                    // reply. Keep the file; the next cycle
                                    // merges both sides again.
                                    continue;
                                }
                                match self.store.save_remote(&mut chat) {
                                    Ok(true) => applied.push(id.to_string()),
                                    Ok(false) => {}
                                    Err(error) => {
                                        eprintln!("hook: could not apply a synced chat: {error}")
                                    }
                                }
                            }
                            Err(error) => {
                                eprintln!("hook: the account returned a broken chat: {error}")
                            }
                        }
                    }
                }
            }
            for (id, version) in &versions {
                // A merged chat replaced the local copy, so its old version is
                // no longer the file's version; an accepted result is enough to
                // stop uploading it.
                if applied.iter().any(|entry| entry == id) {
                    self.store.clear_dirty(id);
                } else {
                    self.store.clear_dirty_if(id, *version);
                }
            }
            self.store.clear_restored(&restored);
        }

        // Whatever is still dirty (a save that happened mid-upload, or a chat
        // that was streaming) stays queued for the next cycle.
        let mut pending = self.store.dirty_ids();
        pending.extend(retry);
        pending.sort();
        pending.dedup();
        lock(&self.state).pending_chats = pending;
        self.save_state()
    }

    /// True when this machine's copy has moved past the copy the account wants
    /// to apply, so the incoming one must not replace it.
    ///
    /// A chat is never uploaded while a turn is writing it, so the account's
    /// copy is a snapshot from before the reply existed. Comparing stamps is the
    /// only thing that tells them apart: a picture upload keeps one request in
    /// flight for seconds, long enough for the reply to be written and accepted
    /// as "not streaming" — which is how a finished answer was deleted and the
    /// chat came back looking stopped. The next push merges both sides.
    fn local_wins(&self, id: &str, remote: &Chat) -> bool {
        let remote_at = remote.meta.updated_at;
        let Ok(local) = self.store.load(id) else {
            return false;
        };
        // A turn that has not finished is never uploaded at all; its stamp may
        // even be equal when two saves share a millisecond.
        local.meta.updated_at > remote_at
            || local
                .messages
                .iter()
                .any(|message| message.status == "streaming")
    }

    /// Upload every picture on this chat once. A failed picture never blocks
    /// the conversation itself; the next push retries it.
    async fn upload_media(&self, token: &str, chat: &mut Chat) {
        let mut learned = false;
        let mut uploads: Vec<(String, String, Vec<u8>)> = Vec::new();
        for message in &mut chat.messages {
            for attachment in &mut message.attachments {
                let digest = match attachment.sha256.clone() {
                    Some(digest) if !digest.is_empty() => digest,
                    _ => match self.store.image_file(&chat.meta.id, &attachment.id) {
                        Ok(path) => match fs::read(&path) {
                            Ok(bytes) => {
                                let digest = sha256_hex(&bytes);
                                attachment.sha256 = Some(digest.clone());
                                learned = true;
                                digest
                            }
                            Err(_) => continue,
                        },
                        Err(_) => continue,
                    },
                };
                if lock(&self.media_seen).contains(&digest) {
                    continue;
                }
                if let Ok(path) = self.store.image_file(&chat.meta.id, &attachment.id) {
                    if let Ok(bytes) = fs::read(&path) {
                        uploads.push((digest, attachment.mime.clone(), bytes));
                    }
                }
            }
        }
        if learned {
            // A picture stored before digests were recorded at save time. Put
            // the digest on the chat as it is *now*: this request's copy is a
            // snapshot, and writing it back would undo whatever the turn wrote
            // while the upload was in flight.
            let digests: HashMap<String, String> = chat
                .messages
                .iter()
                .flat_map(|message| message.attachments.iter())
                .filter_map(|attachment| {
                    attachment
                        .sha256
                        .clone()
                        .map(|digest| (attachment.id.clone(), digest))
                })
                .collect();
            if let Ok(mut current) = self.store.load(&chat.meta.id) {
                let mut touched = false;
                for message in &mut current.messages {
                    for attachment in &mut message.attachments {
                        let missing = attachment
                            .sha256
                            .as_deref()
                            .map(str::is_empty)
                            .unwrap_or(true);
                        if !missing {
                            continue;
                        }
                        if let Some(digest) = digests.get(&attachment.id) {
                            attachment.sha256 = Some(digest.clone());
                            touched = true;
                        }
                    }
                }
                if touched {
                    current.meta.updated_at = now_ms();
                    let _ = self.store.save(&mut current);
                }
            }
        }
        for (digest, mime, bytes) in uploads {
            let response = self
                .client
                .put(self.url(&format!("/api/sync/media/{digest}")))
                .bearer_auth(token)
                .header(reqwest::header::CONTENT_TYPE, mime)
                .body(bytes)
                .send()
                .await;
            match response {
                Ok(response) if response.status().is_success() => self.remember_media(&digest),
                Ok(response) => {
                    eprintln!("hook: picture upload failed ({})", response.status())
                }
                Err(error) => eprintln!("hook: picture upload failed: {error}"),
            }
        }
    }

    fn remember_media(&self, digest: &str) {
        {
            let mut seen = lock(&self.media_seen);
            if !seen.insert(digest.to_string()) {
                return;
            }
        }
        let mut state = lock(&self.state);
        state.media.push(digest.to_string());
        if state.media.len() > MEDIA_MEMORY {
            let drain = state.media.len() - MEDIA_MEMORY;
            state.media.drain(..drain);
        }
        drop(state);
        let _ = self.save_state();
    }

    async fn push_projects(&self, token: &str) -> Result<(), String> {
        let root = self.settings.projects_dir();
        let projects = self.projects.list(&root)?;
        // A folder that went away is a project deleted here. The account has to
        // hear about it: its row would otherwise survive and the next pull would
        // create the folder again — a project nobody can delete.
        let dropped = self.projects.take_dropped();
        if !dropped.is_empty() {
            {
                let mut state = lock(&self.state);
                for project in dropped {
                    if !state.pending_project_deletes.contains(&project.id) {
                        state.pending_project_deletes.push(project.id.clone());
                    }
                    state.project_versions.remove(&project.id);
                    state.prepared.retain(|id| id != &project.id);
                }
            }
            self.save_state()?;
        }
        if let Err(error) = self.push_project_deletes(token).await {
            eprintln!("hook: project deletions: {error}");
        }
        let mut sends: Vec<(String, String)> = Vec::new();
        let mut unsyncable: Vec<(String, String)> = Vec::new();
        {
            let state = lock(&self.state);
            for project in &projects {
                let fingerprint = format!("{}|{}", project.name, project.description);
                if state.project_versions.get(&project.id) == Some(&fingerprint) {
                    continue;
                }
                // The account refuses a name it cannot take, and a 400 for the
                // whole batch would take every other project down with it. A
                // folder name longer than 64 characters (one was renamed into
                // existence by the old collision bug) stays local.
                if let Err(reason) = crate::projects::validate_name(&project.name) {
                    eprintln!(
                        "hook: project {} stays on this machine: {reason}",
                        project.id
                    );
                    unsyncable.push((project.id.clone(), fingerprint));
                    continue;
                }
                sends.push((project.id.clone(), fingerprint));
            }
        }
        if !unsyncable.is_empty() {
            let mut state = lock(&self.state);
            for (id, fingerprint) in unsyncable {
                state.project_versions.insert(id, fingerprint);
            }
            drop(state);
            self.save_state()?;
        }
        if sends.is_empty() {
            return Ok(());
        }

        // The account takes ten at a time, the same cap as chats. Sending the
        // whole list in one request was rejected outright, so a workspace with
        // more than ten changed projects never synced at all — and because no
        // fingerprint was recorded, it retried the same failing request forever.
        let mut failure: Option<String> = None;
        for batch in sends.chunks(MAX_BATCH) {
            let body = json!({
                "projects": batch.iter().map(|(id, _)| {
                    let project = projects.iter().find(|p| &p.id == id);
                    json!({
                        "id": id,
                        "name": project.map(|p| p.name.as_str()).unwrap_or_default(),
                        "description": project.map(|p| p.description.as_str()).unwrap_or_default(),
                        "createdAt": project.map(|p| p.created_at).unwrap_or(0),
                        "updatedAt": project.map(|p| p.updated_at).unwrap_or(0),
                    })
                }).collect::<Vec<_>>()
            });
            match self.post(token, "/api/sync/projects", body).await {
                Ok(response) => {
                    if let Some(results) = response["results"].as_array() {
                        for result in results {
                            let Some(id) = result["id"].as_str() else {
                                continue;
                            };
                            if result["ok"].as_bool() == Some(false) {
                                let error = result["error"].as_str().unwrap_or("unknown");
                                let conflict = result["conflictId"].as_str().unwrap_or_default();
                                // The account already has this name, so this
                                // folder is that project seen with another id
                                // (two installs of the same machine, usually).
                                // Adopt the account's id instead of keeping a
                                // copy that can never sync.
                                if error == "duplicate_name"
                                    && !conflict.is_empty()
                                    && self.projects.adopt_id(id, conflict).unwrap_or(false)
                                {
                                    eprintln!(
                                        "hook: project {id} is the account's {conflict}; using that id"
                                    );
                                    continue;
                                }
                                eprintln!("hook: project {id} was not accepted: {error}");
                            }
                            // Either way, stop retrying the same fingerprint every cycle.
                            if let Some((_, fingerprint)) =
                                batch.iter().find(|(entry, _)| entry == id)
                            {
                                lock(&self.state)
                                    .project_versions
                                    .insert(id.to_string(), fingerprint.clone());
                            }
                        }
                    }
                }
                Err(error) => {
                    failure = Some(error);
                    break;
                }
            }
        }
        // Batches that landed must not be sent again next cycle.
        self.save_state()?;
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    /// Queue a tombstone for a project removed through `delete_project`. The
    /// note is already gone; this is what stops the account, and every other
    /// computer, from putting it back.
    pub fn project_deleted(&self, id: &str) {
        if !project_id_ok(id) {
            return;
        }
        {
            let mut state = lock(&self.state);
            if !state.pending_project_deletes.iter().any(|entry| entry == id) {
                state.pending_project_deletes.push(id.to_string());
            }
            state.project_versions.remove(id);
            state.prepared.retain(|entry| entry != id);
        }
        let _ = self.save_state();
    }

    /// Tell the account which projects this device removed. Ten per request,
    /// like every other push, and an id is forgotten once the account agrees.
    async fn push_project_deletes(&self, token: &str) -> Result<(), String> {
        let pending = {
            let mut state = lock(&self.state);
            // An id the account cannot parse would 400 the whole batch and wedge
            // every later cycle, so an unparseable one is dropped here.
            state.pending_project_deletes.retain(|id| project_id_ok(id));
            state.pending_project_deletes.clone()
        };
        if pending.is_empty() {
            return Ok(());
        }
        let now = now_ms();
        for batch in pending.chunks(MAX_BATCH) {
            let body = json!({
                "projects": batch.iter().map(|id| json!({
                    "id": id,
                    "deleted": true,
                    "updatedAt": now,
                })).collect::<Vec<_>>()
            });
            let response = self.post(token, "/api/sync/projects", body).await?;
            let mut landed: Vec<String> = Vec::new();
            if let Some(results) = response["results"].as_array() {
                for result in results {
                    if result["ok"].as_bool() != Some(true) {
                        continue;
                    }
                    if let Some(id) = result["id"].as_str() {
                        landed.push(id.to_string());
                    }
                }
            }
            if !landed.is_empty() {
                lock(&self.state)
                    .pending_project_deletes
                    .retain(|id| !landed.contains(id));
                self.save_state()?;
            }
        }
        Ok(())
    }

    /// Entries changed on this machine. One small batch is enough: memory is a
    /// few hundred short strings, not a conversation.
    async fn push_memory(&self, token: &str) -> Result<(), String> {
        let dirty = self.memory.dirty_entries();
        if dirty.is_empty() {
            return Ok(());
        }
        for batch in dirty.chunks(MAX_BATCH) {
            let response = self
                .post(token, "/api/sync/memory", json!({ "entries": batch }))
                .await?;
            let mut accepted: Vec<String> = Vec::new();
            if let Some(entries) = response["entries"].as_array() {
                for entry in entries {
                    if let Some(id) = entry["id"].as_str() {
                        accepted.push(id.to_string());
                    }
                }
            }
            if accepted.is_empty() {
                accepted = batch.iter().map(|entry| entry.id.clone()).collect();
            }
            self.memory.clear_dirty(&accepted);
        }
        Ok(())
    }

    // ── the personal model endpoint ─────────────────────────────────────

    /// Push this device's endpoint when it changed, then adopt a newer one.
    ///
    /// The endpoint is a credential, so it does not ride with the chats: its
    /// own routes store it encrypted and hand the key back only to a device
    /// that is adopting it. Both directions are last-write-wins on the stamp
    /// the user's action recorded, the same rule memory uses.
    ///
    /// A key belongs to the account that typed it. If a different account signs
    /// in on this machine, the endpoint keeps working here — it always has — but
    /// it is neither uploaded to that account nor overwritten by it.
    async fn sync_provider(&self, token: &str) -> Result<(), String> {
        let Some(subject) = self.auth.subject() else {
            return Ok(());
        };
        if self
            .settings
            .provider_account()
            .is_some_and(|owner| owner != subject)
        {
            return Ok(());
        }
        // A key typed before the owner was recorded belongs to the first account
        // that syncs it, so an existing endpoint still reaches the other devices.
        if let Err(error) = self.settings.claim_provider(&subject) {
            eprintln!("hook: could not take ownership of the endpoint: {error}");
        }
        self.push_provider(token).await?;
        self.pull_provider(token, &subject).await
    }

    async fn push_provider(&self, token: &str) -> Result<(), String> {
        let changed_at = self.settings.provider_changed_at();
        if changed_at <= 0 || changed_at <= lock(&self.state).provider_synced_at {
            return Ok(());
        }
        let body = match self.settings.custom_provider() {
            Some(provider) => json!({
                "updatedAt": changed_at,
                "provider": {
                    "baseUrl": provider.base_url,
                    "apiKey": provider.api_key,
                    "model": provider.model,
                },
            }),
            // A clear is a fact too: the other devices must go back to Hook's
            // models instead of keeping a key nobody wants any more.
            None => json!({ "updatedAt": changed_at, "provider": null }),
        };
        match self.put(token, "/api/provider", body).await {
            Ok(_) => {
                lock(&self.state).provider_synced_at = changed_at;
                self.save_state()
            }
            Err(error) => {
                // An older account service, or the account turned sync off. This
                // must not turn into a sync error every fifteen seconds.
                eprintln!("hook: could not share the personal endpoint: {error}");
                Ok(())
            }
        }
    }

    async fn pull_provider(&self, token: &str, subject: &str) -> Result<(), String> {
        let response = match self.get(token, "/api/provider").await {
            Ok(value) => value,
            Err(error) => {
                eprintln!("hook: could not read the account's endpoint: {error}");
                return Ok(());
            }
        };
        let remote_at = response["updatedAt"].as_i64().unwrap_or(0);
        if remote_at <= 0 || remote_at <= self.settings.provider_changed_at() {
            return Ok(());
        }
        // The key has its own route, so a metadata response can never leak it.
        let secret = self.get(token, "/api/provider/secret").await?;
        let provider = secret["provider"].as_object().and_then(|value| {
            Some(crate::settings::CustomProvider {
                base_url: value.get("baseUrl")?.as_str()?.to_string(),
                api_key: value.get("apiKey")?.as_str()?.to_string(),
                model: value.get("model")?.as_str()?.to_string(),
            })
        });
        // A row with no usable key is not an endpoint; adopting it would leave
        // this device with half a provider and no way to talk to it.
        let provider = provider.filter(crate::settings::CustomProvider::is_complete);
        if remote_at > 0 && secret["provider"].is_object() && provider.is_none() {
            return Ok(());
        }
        if !self.settings.adopt_provider(provider, remote_at, subject) {
            return Ok(());
        }
        lock(&self.state).provider_synced_at = remote_at;
        self.save_state()?;
        if let Some(signal) = self.settings_changed.get() {
            signal();
        }
        (self.emit)(
            "hook://sync",
            json!({
                "chats": false,
                "projects": false,
                "memory": false,
                "settings": true,
                "at": now_ms(),
            }),
        );
        Ok(())
    }

    // ── pull ────────────────────────────────────────────────────────────
    async fn pull(&self, token: &str) -> Result<(), String> {
        let mut cursor = lock(&self.state).cursor;
        let mut chats_changed = false;
        let mut projects_changed = false;
        let mut memory_changed = false;
        let mut pages = 0;
        loop {
            let response = self
                .get(
                    token,
                    &format!("/api/sync/changes?since={cursor}&limit=100"),
                )
                .await?;
            let changes = response["changes"].as_array().cloned().unwrap_or_default();
            let mut last = cursor;
            let mut deferred = false;

            for change in changes {
                let kind = change["kind"].as_str().unwrap_or_default();
                let seq = change["seq"].as_i64().unwrap_or(last);
                match kind {
                    "chat" => {
                        let id = change["id"].as_str().unwrap_or_default().to_string();
                        if change["deleted"].as_bool() == Some(true) {
                            self.store.remove_synced(&id);
                            chats_changed = true;
                        } else {
                            let mut chat: Chat = match serde_json::from_value(change["chat"].clone())
                            {
                                Ok(chat) => chat,
                                Err(error) => {
                                    eprintln!("hook: skipping an unreadable synced chat: {error}");
                                    last = seq;
                                    continue;
                                }
                            };
                            // Never replace a conversation that is being
                            // written right now, and never a copy this machine
                            // has moved past: the incoming copy cannot show a
                            // turn that has not been uploaded. The next push
                            // merges both sides and the union comes back.
                            if self.local_wins(&id, &chat) {
                                last = seq;
                                continue;
                            }
                            if !self.download_media(token, &chat).await {
                                // A transient picture failure: keep the cursor
                                // where it is and retry the whole chat later.
                                deferred = true;
                                break;
                            }
                            match self.store.save_remote(&mut chat) {
                                Ok(true) => chats_changed = true,
                                // This machine is ahead of the account: keep
                                // the local copy and push it next cycle.
                                Ok(false) => {}
                                Err(error) => {
                                    eprintln!("hook: could not apply a synced chat: {error}")
                                }
                            }
                        }
                    }
                    "remoteChat" => {
                        let id = change["id"].as_str().unwrap_or_default();
                        let host = change["deviceId"].as_str().unwrap_or_default();
                        if id.is_empty() || host.is_empty() {
                            last = seq;
                            continue;
                        }
                        // This is the machine's own stub coming back. The local
                        // chat is the original; never turn it into a cache.
                        if host == self.auth.device_id() {
                            last = seq;
                            continue;
                        }
                        if change["deleted"].as_bool() == Some(true) {
                            let local = self.store.load(id).ok();
                            if local.map(|chat| chat.meta.remote).unwrap_or(false) {
                                self.store.remove_synced(id);
                                chats_changed = true;
                            }
                        } else {
                            let meta = ChatMeta {
                                id: id.to_string(),
                                title: change["title"].as_str().unwrap_or("Coding agent").to_string(),
                                created_at: change["createdAt"].as_i64().unwrap_or(0),
                                updated_at: change["updatedAt"].as_i64().unwrap_or(0),
                                pinned: false,
                                pinned_at: None,
                                message_count: change["messageCount"].as_u64().unwrap_or(0)
                                    as usize,
                                preview: String::new(),
                                source: None,
                                source_id: None,
                                source_updated_at: None,
                                kind: Some(KIND_CODING.to_string()),
                                project_path: None,
                                session_id: None,
                                device_id: Some(host.to_string()),
                                device_name: change["deviceName"]
                                    .as_str()
                                    .map(str::to_string),
                                remote: true,
                                stub_state: change["state"].as_str().map(str::to_string),
                            };
                            match self.store.apply_stub(meta) {
                                Ok(true) => chats_changed = true,
                                Ok(false) => {}
                                Err(error) => {
                                    eprintln!("hook: could not apply a remote chat: {error}")
                                }
                            }
                        }
                    }
                    "project" => {
                        let id = change["id"].as_str().unwrap_or_default().to_string();
                        if change["deleted"].as_bool() == Some(true) {
                            // Deleted on another computer: the row is gone for
                            // good, so a note whose folder no longer exists goes
                            // with it. A folder that is still here is this
                            // machine's copy of the project, and its next push
                            // puts it back rather than deleting someone's work
                            // by proxy.
                            if self.projects.forget_missing(&id) {
                                projects_changed = true;
                            }
                            lock(&self.state).project_versions.remove(&id);
                        } else if lock(&self.state)
                            .pending_project_deletes
                            .iter()
                            .any(|entry| entry == &id)
                        {
                            // Our own tombstone has not landed yet. Binding the
                            // row now would recreate the folder we just removed.
                        } else {
                            let name = change["name"].as_str().unwrap_or_default();
                            let description =
                                change["description"].as_str().unwrap_or_default();
                            let created_at = change["createdAt"].as_i64().unwrap_or(0);
                            let updated_at = change["updatedAt"].as_i64().unwrap_or(0);
                            match self.projects.bind(
                                &self.settings.projects_dir(),
                                &id,
                                name,
                                description,
                                created_at,
                                updated_at,
                            ) {
                                Ok(project) => {
                                    // It came from the account; pushing it straight
                                    // back would only bump the cursor for everyone.
                                    lock(&self.state).project_versions.insert(
                                        project.id,
                                        format!("{}|{}", project.name, project.description),
                                    );
                                    projects_changed = true;
                                }
                                Err(error) => {
                                    eprintln!("hook: could not bind a synced project: {error}")
                                }
                            }
                        }
                    }
                    "memory" => match serde_json::from_value::<Entry>(change["entry"].clone()) {
                        Ok(entry) => {
                            self.memory.apply_remote(vec![entry]);
                            memory_changed = true;
                        }
                        Err(error) => {
                            eprintln!("hook: skipping an unreadable synced memory: {error}")
                        }
                    },
                    _ => {}
                }
                last = seq;
            }

            cursor = last;
            lock(&self.state).cursor = cursor;
            self.save_state()?;
            pages += 1;
            if deferred || response["hasMore"].as_bool() != Some(true) || pages > 50 {
                break;
            }
        }

        if chats_changed || projects_changed || memory_changed {
            (self.emit)(
                "hook://sync",
                json!({
                    "chats": chats_changed,
                    "projects": projects_changed,
                    "memory": memory_changed,
                    "at": now_ms(),
                }),
            );
        }
        Ok(())
    }

    /// Download the pictures this chat references. Returns false only for a
    /// failure worth retrying (network or a server error); a 404 means the
    /// other device never managed to upload it, which retrying cannot fix.
    async fn download_media(&self, token: &str, chat: &Chat) -> bool {
        let mut retry = false;
        for message in &chat.messages {
            for attachment in &message.attachments {
                let Some(digest) = attachment
                    .sha256
                    .as_deref()
                    .filter(|digest| !digest.is_empty())
                else {
                    continue;
                };
                if self
                    .store
                    .image_exists(&chat.meta.id, &attachment.id)
                {
                    continue;
                }
                let response = self
                    .client
                    .get(self.url(&format!("/api/sync/media/{digest}")))
                    .bearer_auth(token)
                    .send()
                    .await;
                match response {
                    Ok(response) if response.status().is_success() => {
                        match response.bytes().await {
                            Ok(bytes) => {
                                if let Err(error) = self.store.write_remote_image(
                                    &chat.meta.id,
                                    attachment,
                                    &bytes,
                                ) {
                                    eprintln!("hook: could not store a synced picture: {error}");
                                }
                            }
                            Err(error) => {
                                eprintln!("hook: picture download failed: {error}");
                                retry = true;
                            }
                        }
                    }
                    Ok(response) if response.status() == reqwest::StatusCode::NOT_FOUND => {}
                    Ok(response) => {
                        eprintln!("hook: picture download failed ({})", response.status());
                        retry = true;
                    }
                    Err(error) => {
                        eprintln!("hook: picture download failed: {error}");
                        retry = true;
                    }
                }
            }
        }
        !retry
    }

    // ── project repositories ────────────────────────────────────────────
    async fn prepare_projects(&self) {
        let Some(git) = &self.git else {
            return;
        };
        let config = self.data_dir.join("agent-home").join("gitconfig");
        if !config.is_file() {
            return;
        }
        let Ok(projects) = self.projects.list(&self.settings.projects_dir()) else {
            return;
        };
        let mut prepared_here = 0;
        for project in projects {
            if lock(&self.state)
                .prepared
                .iter()
                .any(|id| id == &project.id)
            {
                continue;
            }
            let path = PathBuf::from(&project.path);
            if !path.is_dir() {
                continue;
            }
            if let Err(error) = git::prepare_project(
                git,
                &config,
                &path,
                self.auth.base_url(),
                &project.id,
            ) {
                eprintln!("hook: could not prepare {}: {error}", project.name);
                continue;
            }
            // A project that only exists on the account (started on another
            // computer) arrives by pulling; an existing local project gets one
            // initial snapshot so the other computers can pull it.
            if !git::has_commits(git, &config, &path) {
                if let Err(error) = git::pull_into_empty(git, &config, &path).await {
                    eprintln!("hook: could not fetch {}: {error}", project.name);
                    continue;
                }
            }
            if !git::has_commits(git, &config, &path) {
                if let Err(error) = git::initial_snapshot(git, &config, &path) {
                    eprintln!("hook: could not snapshot {}: {error}", project.name);
                    continue;
                }
            }
            // Save whatever the account does not have yet. This retries a
            // snapshot whose first push failed and is a no-op when a pull just
            // brought the project down.
            if git::has_commits(git, &config, &path) {
                if let Err(error) = git::push(git, &config, &path).await {
                    eprintln!("hook: could not save {}: {error}", project.name);
                    continue;
                }
            }
            lock(&self.state).prepared.push(project.id.clone());
            self.save_state().ok();
            prepared_here += 1;
            if prepared_here >= MAX_PREPARED_PER_CYCLE {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::StoredSession;
    use crate::store::Message;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn header_end(bytes: &[u8]) -> Option<usize> {
        bytes.windows(4).position(|window| window == b"\r\n\r\n")
    }

    async fn read_request(
        socket: &mut tokio::net::TcpStream,
    ) -> Option<(String, String, Value)> {
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            let read = socket.read(&mut chunk).await.ok()?;
            if read == 0 {
                break;
            }
            buffer.extend_from_slice(&chunk[..read]);
            if let Some(end) = header_end(&buffer) {
                let head = String::from_utf8_lossy(&buffer[..end]).to_string();
                let length = head
                    .lines()
                    .find_map(|line| {
                        let lower = line.to_ascii_lowercase();
                        lower
                            .strip_prefix("content-length:")
                            .and_then(|value| value.trim().parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                if buffer.len() >= end + 4 + length {
                    break;
                }
            }
        }
        let end = header_end(&buffer)?;
        let head = String::from_utf8_lossy(&buffer[..end]).to_string();
        let mut lines = head.lines();
        let request_line = lines.next()?;
        let mut parts = request_line.split_whitespace();
        let method = parts.next()?.to_string();
        let path = parts.next()?.to_string();
        let body = String::from_utf8_lossy(&buffer[end + 4..]).to_string();
        Some((
            method,
            path,
            serde_json::from_str(&body).unwrap_or(Value::Null),
        ))
    }

    /// A tiny HTTP/1.1 JSON server: enough for one sync cycle.
    async fn mock_server(
        handler: impl Fn(&str, &str, &Value) -> Value + Send + Sync + 'static,
    ) -> (String, Arc<Mutex<Vec<(String, String, Value)>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let seen: Arc<Mutex<Vec<(String, String, Value)>>> =
            Arc::new(Mutex::new(Vec::new()));
        let requests = seen.clone();
        let handler = Arc::new(handler);
        tokio::spawn(async move {
            loop {
                let Ok((mut socket, _)) = listener.accept().await else {
                    break;
                };
                let requests = requests.clone();
                let handler = handler.clone();
                tokio::spawn(async move {
                    if let Some((method, path, body)) = read_request(&mut socket).await {
                        requests
                            .lock()
                            .unwrap()
                            .push((method.clone(), path.clone(), body.clone()));
                        let payload = handler(&method, &path, &body);
                        let text = payload.to_string();
                        let response = format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                            text.len(),
                            text
                        );
                        let _ = socket.write_all(response.as_bytes()).await;
                    }
                });
            }
        });
        (format!("http://{address}"), seen)
    }

    struct Fixture {
        base: PathBuf,
        auth: Arc<AuthStore>,
        store: Arc<Store>,
        projects: Arc<ProjectsStore>,
        settings: Arc<SettingsStore>,
    }

    fn fixture(base_url: &str) -> Fixture {
        // One product's data directory, one level below the family root: the
        // shared account file lives next to it, so each test gets its own.
        let root = std::env::temp_dir().join(format!("hook-sync-{}", uuid::Uuid::new_v4()));
        let base = root.join("app.hook.chat");
        fs::create_dir_all(&base).unwrap();
        let auth = Arc::new(AuthStore::new(&base, base_url, true, ""));
        auth.save_session(&StoredSession {
            token: "hk_test_sync_token_0123456789abcdef".into(),
            email: "member@example.test".into(),
            name: Some("Member".into()),
            subject: "subject-sync".into(),
            signed_in_at: 0,
            git_token: None,
            plan: None,
            cloud_sync: None,
            advanced_mode: None,
        })
        .unwrap();
        let store = Arc::new(Store::new(base.clone()).unwrap());
        let projects = Arc::new(ProjectsStore::new(&base));
        let settings = Arc::new(SettingsStore::new(&base));
        settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        Fixture {
            base,
            auth,
            store,
            projects,
            settings,
        }
    }

    fn engine(fixture: &Fixture, emit: Emitter) -> SyncEngine {
        SyncEngine::new(
            emit,
            &fixture.base,
            fixture.auth.clone(),
            fixture.store.clone(),
            fixture.projects.clone(),
            fixture.settings.clone(),
            Arc::new(MemoryStore::new(&fixture.base, Default::default())),
            None,
        )
    }

    #[test]
    fn the_plan_and_the_switch_decide_whether_sync_runs() {
        let fixture = fixture("http://127.0.0.1:1");
        // An account file from before plans existed is not a downgrade: only a
        // server-confirmed free plan switches sync off by itself.
        assert_eq!(policy_for(&fixture.auth), (true, true, None));

        let mut session = fixture.auth.session().expect("a session");
        session.plan = Some("free".into());
        fixture.auth.save_session(&session).unwrap();
        assert_eq!(policy_for(&fixture.auth), (false, false, Some("free")));

        session.plan = Some("pro".into());
        session.cloud_sync = Some(false);
        fixture.auth.save_session(&session).unwrap();
        assert_eq!(policy_for(&fixture.auth), (true, false, Some("off")));

        session.cloud_sync = Some(true);
        fixture.auth.save_session(&session).unwrap();
        assert_eq!(policy_for(&fixture.auth), (true, true, None));
    }

    #[tokio::test]
    async fn a_local_chat_is_pushed_and_the_merged_version_is_applied() {
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/chats")) => {
                    let mut merged = body["chats"][0].clone();
                    merged["messages"]
                        .as_array_mut()
                        .expect("a chat with messages")
                        .push(serde_json::json!({
                            "id": "m-remote",
                            "role": "assistant",
                            "content": "from the other computer",
                            "createdAt": 2000,
                            "status": "complete"
                        }));
                    // The account's merged copy is newer than what was
                    // uploaded (a real one always is), so it lands here.
                    let uploaded = merged["meta"]["updatedAt"].as_i64().unwrap_or(0);
                    merged["meta"]["updatedAt"] = serde_json::json!(uploaded + 1000);
                    serde_json::json!({
                        "results": [{
                            "id": merged["meta"]["id"].clone(),
                            "seq": 7,
                            "deleted": false,
                            "chat": merged
                        }],
                        "cursor": 7
                    })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 7, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let mut chat = Chat::new();
        chat.meta.title = "Local work".into();
        chat.messages.push(Message::new("user", "start here", "complete"));
        fixture.store.save(&mut chat).unwrap();
        let id = chat.meta.id.clone();

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let merged = fixture.store.load(&id).unwrap();
        assert_eq!(merged.messages.len(), 2);
        assert_eq!(merged.messages[1].content, "from the other computer");
        assert_eq!(engine.status().pending, 0);
        assert!(fixture.base.join("sync.json").is_file());
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .any(|(method, path, _)| method == "POST" && path == "/api/sync/chats"),
            "the local chat must reach the account"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn more_than_ten_changed_projects_are_pushed_in_batches() {
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/projects")) => {
                    let projects = body["projects"].as_array().cloned().unwrap_or_default();
                    serde_json::json!({
                        "results": projects
                            .iter()
                            .map(|project| serde_json::json!({
                                "id": project["id"].clone(),
                                "ok": true
                            }))
                            .collect::<Vec<_>>()
                    })
                }
                ("POST", Some("/api/sync/chats")) => {
                    serde_json::json!({ "results": [], "cursor": 0 })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let root = fixture.settings.projects_dir();
        for index in 0..12 {
            fixture
                .projects
                .create(&root, &format!("site-{index}"), "a site")
                .unwrap();
        }

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let posts: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/projects")
            .map(|(_, _, body)| body.clone())
            .collect();
        assert!(
            posts.len() >= 2,
            "12 projects need more than one request, sent {}",
            posts.len()
        );
        for post in &posts {
            let count = post["projects"].as_array().map(|all| all.len()).unwrap_or(0);
            assert!(
                (1..=10).contains(&count),
                "the account takes 1..=10 projects per request, got {count}"
            );
        }
        let total: usize = posts
            .iter()
            .map(|post| post["projects"].as_array().map(|all| all.len()).unwrap_or(0))
            .sum();
        assert_eq!(total, 12, "every project must reach the account");

        // The fingerprints from every batch are recorded, so a quiet cycle
        // sends nothing at all.
        seen.lock().unwrap().clear();
        engine.cycle().await.expect("second cycle");
        let again = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/projects")
            .count();
        assert_eq!(again, 0, "an unchanged workspace must not re-send projects");

        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_chat_from_another_computer_is_pulled_and_announced() {
        let (url, _seen) = mock_server(|method, path, _body| {
            match (method, path.split('?').next()) {
                ("GET", Some("/api/sync/changes")) => serde_json::json!({
                    "cursor": 5,
                    "hasMore": false,
                    "changes": [{
                        "kind": "chat",
                        "id": "chat-remote",
                        "seq": 5,
                        "deleted": false,
                        "updatedAt": 5,
                        "chat": {
                            "meta": {
                                "id": "chat-remote",
                                "title": "From the laptop",
                                "createdAt": 1000,
                                "updatedAt": 2000,
                                "pinned": false,
                                "pinnedAt": null,
                                "messageCount": 1,
                                "preview": "hello"
                            },
                            "messages": [{
                                "id": "m1",
                                "role": "user",
                                "content": "hello",
                                "createdAt": 1000,
                                "status": "complete"
                            }]
                        }
                    }]
                }),
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let engine = engine(
            &fixture,
            Arc::new(move |event, _| captured.lock().unwrap().push(event.to_string())),
        );
        engine.cycle().await.expect("one cycle");

        let chat = fixture.store.load("chat-remote").unwrap();
        assert_eq!(chat.meta.title, "From the laptop");
        assert_eq!(engine.status().cursor, 5);
        assert_eq!(
            events.lock().unwrap().as_slice(),
            ["hook://sync"],
            "the window must be told to refresh"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_duplicate_name_adopts_the_accounts_project_id() {
        // The account already has "banana-store" under another id (the other
        // product, or another install, pushed it first). The local copy must
        // adopt that id rather than keep failing as a duplicate forever.
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/projects")) => {
                    let projects = body["projects"].as_array().cloned().unwrap_or_default();
                    let results: Vec<serde_json::Value> = projects
                        .iter()
                        .map(|project| {
                            if project["id"] == "pj_local_copy" {
                                serde_json::json!({
                                    "id": "pj_local_copy",
                                    "ok": false,
                                    "error": "duplicate_name",
                                    "conflictId": "pj_account_copy"
                                })
                            } else {
                                serde_json::json!({ "id": project["id"].clone(), "ok": true })
                            }
                        })
                        .collect();
                    serde_json::json!({ "results": results })
                }
                ("POST", Some("/api/sync/chats")) => {
                    serde_json::json!({ "results": [], "cursor": 0 })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let root = fixture.settings.projects_dir();
        fs::create_dir_all(root.join("banana-store")).unwrap();
        let note = fixture.base.join("projects.json");
        fs::write(
            &note,
            serde_json::json!({
                "projects": [{
                    "id": "pj_local_copy",
                    "name": "banana-store",
                    "path": root.join("banana-store").to_string_lossy(),
                    "description": "",
                    "createdAt": 1,
                    "updatedAt": 1
                }]
            })
            .to_string(),
        )
        .unwrap();

        let engine = SyncEngine::new(
            Arc::new(|_, _| {}),
            &fixture.base,
            fixture.auth.clone(),
            fixture.store.clone(),
            Arc::new(ProjectsStore::new(&fixture.base)),
            fixture.settings.clone(),
            Arc::new(MemoryStore::new(&fixture.base, Default::default())),
            None,
        );
        engine.cycle().await.expect("one cycle");
        engine.cycle().await.expect("a second cycle");

        let posts: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/projects")
            .map(|(_, _, body)| body.clone())
            .collect();
        let ids: Vec<String> = posts
            .iter()
            .flat_map(|post| post["projects"].as_array().cloned().unwrap_or_default())
            .filter_map(|project| project["id"].as_str().map(str::to_string))
            .collect();
        assert_eq!(ids.first().map(String::as_str), Some("pj_local_copy"));
        assert!(
            ids.iter().any(|id| id == "pj_account_copy"),
            "the second cycle must push the account's id: {ids:?}"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_removed_project_folder_is_tombstoned_once() {
        // The folder going away is a deletion, and the account has to hear it.
        // Its row would otherwise survive, and the next pull would create the
        // folder again: a project nobody can get rid of.
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/projects")) => {
                    let projects = body["projects"].as_array().cloned().unwrap_or_default();
                    serde_json::json!({
                        "results": projects
                            .iter()
                            .map(|project| serde_json::json!({
                                "id": project["id"].clone(),
                                "ok": true,
                                "deleted": true
                            }))
                            .collect::<Vec<_>>()
                    })
                }
                ("POST", Some("/api/sync/chats")) => {
                    serde_json::json!({ "results": [], "cursor": 0 })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let root = fixture.settings.projects_dir();
        let project = fixture.projects.create(&root, "doomed", "").unwrap();
        // Work in the folder makes it the user's: Hook refuses and keeps the note.
        fs::write(root.join("doomed").join("index.html"), "<h1>hi</h1>").unwrap();
        assert!(fixture.projects.delete(&project.id).is_err());
        // Deleting it outside Hook is the way that works, and the note follows.
        fs::remove_dir_all(root.join("doomed")).unwrap();

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let posts: Vec<Value> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/projects")
            .map(|(_, _, body)| body.clone())
            .collect();
        assert_eq!(posts.len(), 1, "one tombstone, not a project push");
        assert_eq!(posts[0]["projects"][0]["id"], project.id);
        assert_eq!(posts[0]["projects"][0]["deleted"], true);
        assert!(fixture.projects.list(&root).unwrap().is_empty());

        // The account took it, so a quiet cycle sends nothing more.
        seen.lock().unwrap().clear();
        engine.cycle().await.expect("second cycle");
        assert!(
            seen.lock()
                .unwrap()
                .iter()
                .all(|(_, path, _)| path != "/api/sync/projects"),
            "a deletion is sent once"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_project_being_deleted_is_not_recreated_by_a_pull() {
        // The account has not taken the tombstone yet and still lists the
        // project. Binding the row now would recreate the folder just removed.
        let (url, _seen) = mock_server(|method, path, _body| {
            match (method, path.split('?').next()) {
                // Nothing lands: the deletion stays queued for the next cycle.
                ("POST", Some("/api/sync/projects")) => serde_json::json!({ "results": [] }),
                ("POST", Some("/api/sync/chats")) => {
                    serde_json::json!({ "results": [], "cursor": 0 })
                }
                ("GET", Some("/api/sync/changes")) => serde_json::json!({
                    "cursor": 3,
                    "hasMore": false,
                    "changes": [{
                        "kind": "project",
                        "id": "pj_doomed",
                        "seq": 3,
                        "deleted": false,
                        "updatedAt": 3,
                        "name": "doomed",
                        "description": "",
                        "createdAt": 1
                    }]
                }),
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.project_deleted("pj_doomed");
        engine.cycle().await.expect("one cycle");

        let root = fixture.settings.projects_dir();
        assert!(
            !root.join("doomed").exists(),
            "a queued deletion must win over the account's row"
        );
        assert!(fixture.projects.list(&root).unwrap().is_empty());
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_project_the_account_cannot_take_does_not_block_the_others() {
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/projects")) => {
                    let projects = body["projects"].as_array().cloned().unwrap_or_default();
                    serde_json::json!({
                        "results": projects
                            .iter()
                            .map(|project| serde_json::json!({
                                "id": project["id"].clone(),
                                "ok": true
                            }))
                            .collect::<Vec<_>>()
                    })
                }
                ("POST", Some("/api/sync/chats")) => serde_json::json!({ "results": [], "cursor": 0 }),
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let root = fixture.settings.projects_dir();
        fixture.projects.create(&root, "good-one", "").unwrap();
        // The kind of name the old rename bug produced. Its folder is on disk
        // and listed, but the account would reject it.
        let monster = "b".repeat(70);
        fs::create_dir_all(root.join(&monster)).unwrap();
        fs::write(root.join(&monster).join("notes.txt"), "x").unwrap();

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let names: Vec<String> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/projects")
            .flat_map(|(_, _, body)| body["projects"].as_array().cloned().unwrap_or_default())
            .filter_map(|project| project["name"].as_str().map(str::to_string))
            .collect();
        assert!(names.iter().any(|name| name == "good-one"), "{names:?}");
        assert!(!names.iter().any(|name| name.len() > 64), "{names:?}");
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_merged_chat_does_not_land_on_top_of_a_reply_being_written() {
        // The race that made a chat spin forever: the push reads the chat, the
        // turn saves its streaming placeholder, the merged copy comes back
        // without it and used to replace the file mid-turn.
        let store_cell: Arc<Mutex<Option<Arc<Store>>>> = Arc::new(Mutex::new(None));
        let cell = store_cell.clone();
        let (url, _seen) = mock_server(move |method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/chats")) => {
                    let chat = body["chats"][0].clone();
                    // The turn starts while the request is in flight.
                    if let Some(store) = cell.lock().unwrap().clone() {
                        let id = chat["meta"]["id"].as_str().unwrap();
                        let mut local = store.load(id).unwrap();
                        local.messages.push(Message::new("assistant", "", "streaming"));
                        store.save(&mut local).unwrap();
                    }
                    // The account's answer predates the placeholder.
                    serde_json::json!({
                        "results": [{ "id": chat["meta"]["id"].clone(), "chat": chat }],
                        "cursor": 5
                    })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 5, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        *store_cell.lock().unwrap() = Some(fixture.store.clone());
        let mut chat = Chat::new();
        chat.messages.push(Message::new("user", "start here", "complete"));
        fixture.store.save(&mut chat).unwrap();
        let id = chat.meta.id.clone();

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let local = fixture.store.load(&id).unwrap();
        assert_eq!(
            local.messages.last().map(|message| message.status.as_str()),
            Some("streaming"),
            "the reply being written must survive a sync cycle"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_finished_reply_survives_the_copy_that_was_uploaded_before_it() {
        // The bug a picture made easy to hit: `upload_media` keeps one push in
        // flight for seconds, so the merged copy of a chat that had only its
        // user message comes back *after* the turn wrote the reply. That copy is
        // older than the file, and applying it deleted the answer — the window
        // showed a stopped turn and the file kept only the question.
        let store_cell: Arc<Mutex<Option<Arc<Store>>>> = Arc::new(Mutex::new(None));
        let cell = store_cell.clone();
        let (url, seen) = mock_server(move |method, path, body| {
            match (method, path.split('?').next()) {
                ("POST", Some("/api/sync/chats")) => {
                    let chat = body["chats"][0].clone();
                    let id = chat["meta"]["id"].as_str().unwrap().to_string();
                    // The turn finishes while the upload is in flight.
                    if let Some(store) = cell.lock().unwrap().clone() {
                        let mut local = store.load(&id).unwrap();
                        if !local.messages.iter().any(|m| m.role == "assistant") {
                            let mut reply = Message::new("assistant", "the answer", "complete");
                            reply.created_at = local.meta.updated_at + 1;
                            local.messages.push(reply);
                            local.meta.updated_at += 1;
                            store.save(&mut local).unwrap();
                        }
                    }
                    // The account's answer predates the reply: it saw the
                    // question only, exactly like a real merge would.
                    serde_json::json!({
                        "results": [{ "id": chat["meta"]["id"].clone(), "chat": chat }],
                        "cursor": 5
                    })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 5, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        *store_cell.lock().unwrap() = Some(fixture.store.clone());
        let mut chat = Chat::new();
        chat.messages.push(Message::new("user", "start here", "complete"));
        fixture.store.save(&mut chat).unwrap();
        let id = chat.meta.id.clone();

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let local = fixture.store.load(&id).unwrap();
        assert_eq!(
            local.messages.last().map(|message| message.content.as_str()),
            Some("the answer"),
            "a copy taken before the reply must not delete it"
        );

        // The reply is still queued, so the next cycle carries it to the
        // account instead of leaving the two copies apart forever.
        engine.cycle().await.expect("a second cycle");
        let pushed = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "POST" && path == "/api/sync/chats")
            .map(|(_, _, body)| body.clone())
            .collect::<Vec<_>>();
        assert!(
            pushed.iter().any(|body| body["chats"][0]["messages"]
                .as_array()
                .map(|messages| messages
                    .iter()
                    .any(|message| message["content"] == "the answer"))
                .unwrap_or(false)),
            "the reply reaches the account on the next cycle"
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_personal_endpoint_is_shared_once() {
        let (url, seen) = mock_server(|method, path, body| {
            match (method, path.split('?').next()) {
                ("PUT", Some("/api/provider")) => serde_json::json!({
                    "provider": {
                        "baseUrl": body["provider"]["baseUrl"].clone(),
                        "model": body["provider"]["model"].clone(),
                        "hasKey": true,
                        "updatedAt": body["updatedAt"].clone()
                    },
                    "updatedAt": body["updatedAt"].clone()
                }),
                ("GET", Some("/api/provider")) => {
                    // Nothing on the account yet: this device is the first.
                    serde_json::json!({ "provider": null, "updatedAt": 0 })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        fixture
            .settings
            .set_custom_provider("https://api.example.test/v1", "sk-local", "gpt-4o", Some("subject-sync"))
            .unwrap();
        let stamp = fixture.settings.provider_changed_at();
        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        let pushed: Vec<_> = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "PUT" && path == "/api/provider")
            .map(|(_, _, body)| body.clone())
            .collect();
        assert_eq!(pushed.len(), 1, "the endpoint is sent once");
        assert_eq!(pushed[0]["updatedAt"], serde_json::json!(stamp));
        assert_eq!(pushed[0]["provider"]["apiKey"], "sk-local");

        // A second cycle has nothing new to say.
        engine.cycle().await.expect("a second cycle");
        let pushes = seen
            .lock()
            .unwrap()
            .iter()
            .filter(|(method, path, _)| method == "PUT" && path == "/api/provider")
            .count();
        assert_eq!(pushes, 1, "an unchanged endpoint is not re-sent");
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn an_endpoint_from_another_device_is_adopted_and_announced() {
        let (url, seen) = mock_server(|method, path, _body| {
            match (method, path.split('?').next()) {
                ("GET", Some("/api/provider")) => serde_json::json!({
                    "provider": {
                        "baseUrl": "https://api.example.test/v1",
                        "model": "gpt-4o",
                        "hasKey": true,
                        "updatedAt": 5000
                    },
                    "updatedAt": 5000
                }),
                ("GET", Some("/api/provider/secret")) => serde_json::json!({
                    "provider": {
                        "baseUrl": "https://api.example.test/v1",
                        "model": "gpt-4o",
                        "apiKey": "sk-from-the-laptop",
                        "updatedAt": 5000
                    },
                    "updatedAt": 5000
                }),
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        let events: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        let poked = Arc::new(Mutex::new(0u32));
        let poked_calls = poked.clone();
        let engine = engine(
            &fixture,
            Arc::new(move |event, payload| {
                assert!(
                    payload["settings"].as_bool() != Some(true)
                        || event == "hook://sync",
                    "a settings change is announced on hook://sync"
                );
                captured.lock().unwrap().push(event.to_string());
            }),
        );
        engine.on_settings_changed(Arc::new(move || {
            *poked_calls.lock().unwrap() += 1;
        }));
        engine.cycle().await.expect("one cycle");

        let adopted = fixture.settings.custom_provider().expect("a provider");
        assert_eq!(adopted.api_key, "sk-from-the-laptop");
        assert_eq!(adopted.model, "gpt-4o");
        assert_eq!(fixture.settings.provider_changed_at(), 5000);
        assert_eq!(*poked.lock().unwrap(), 1, "the model card is asked again");
        assert!(events.lock().unwrap().iter().any(|event| event == "hook://sync"));

        // It is not echoed back, and the secret is fetched once.
        engine.cycle().await.expect("a second cycle");
        let seen = seen.lock().unwrap();
        assert!(
            !seen
                .iter()
                .any(|(method, path, _)| method == "PUT" && path == "/api/provider"),
            "an adopted endpoint is not pushed straight back"
        );
        assert_eq!(
            seen.iter()
                .filter(|(_, path, _)| path == "/api/provider/secret")
                .count(),
            1
        );
        drop(seen);
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn a_clear_from_another_device_removes_the_endpoint_here() {
        let (url, _seen) = mock_server(|method, path, _body| {
            match (method, path.split('?').next()) {
                ("GET", Some("/api/provider")) => {
                    serde_json::json!({ "provider": null, "updatedAt": 9000 })
                }
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        fixture
            .settings
            .adopt_provider(
                Some(crate::settings::CustomProvider {
                    base_url: "https://api.example.test/v1".into(),
                    api_key: "sk-local".into(),
                    model: "gpt-4o".into(),
                }),
                100,
                "subject-sync",
            );
        assert!(fixture.settings.custom_provider().is_some());

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        assert_eq!(fixture.settings.custom_provider(), None);
        assert_eq!(fixture.settings.provider_changed_at(), 9000);
        // The clear is now the newest fact, so it is not pushed back either.
        assert_eq!(lock(&engine.state).provider_synced_at, 9000);
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }

    #[tokio::test]
    async fn an_endpoint_typed_under_another_account_stays_on_this_machine() {
        let (url, seen) = mock_server(|method, path, _body| {
            match (method, path.split('?').next()) {
                ("GET", Some("/api/provider")) => serde_json::json!({
                    "provider": {
                        "baseUrl": "https://theirs.example.test/v1",
                        "model": "theirs",
                        "hasKey": true,
                        "updatedAt": 5000
                    },
                    "updatedAt": 5000
                }),
                ("GET", Some("/api/provider/secret")) => serde_json::json!({
                    "provider": {
                        "baseUrl": "https://theirs.example.test/v1",
                        "model": "theirs",
                        "apiKey": "sk-theirs",
                        "updatedAt": 5000
                    },
                    "updatedAt": 5000
                }),
                ("GET", Some("/api/sync/changes")) => {
                    serde_json::json!({ "cursor": 0, "hasMore": false, "changes": [] })
                }
                _ => serde_json::json!({ "error": { "message": "unexpected request" } }),
            }
        })
        .await;

        let fixture = fixture(&url);
        // A key typed while another account was signed in on this machine.
        fixture.settings.adopt_provider(
            Some(crate::settings::CustomProvider {
                base_url: "https://mine.example.test/v1".into(),
                api_key: "sk-mine".into(),
                model: "mine".into(),
            }),
            100,
            "someone-else",
        );

        let engine = engine(&fixture, Arc::new(|_, _| {}));
        engine.cycle().await.expect("one cycle");

        {
            let seen = seen.lock().unwrap();
            assert!(
                !seen.iter().any(|(_, path, _)| path.starts_with("/api/provider")),
                "another account's key is neither uploaded nor adopted"
            );
        }
        let local = fixture.settings.custom_provider().expect("still on disk");
        assert_eq!(local.api_key, "sk-mine");
        assert_eq!(
            fixture.settings.provider_account().as_deref(),
            Some("someone-else")
        );
        fs::remove_dir_all(fixture.base.parent().unwrap()).ok();
    }
}
