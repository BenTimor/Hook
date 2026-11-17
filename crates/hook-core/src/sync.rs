//! Two-way sync of conversations and project metadata.
//!
//! Everything here runs in the background for a signed-in account. There is no
//! button: a cycle pulls changes, pushes local ones, and lets the server merge
//! them. Code is not in this module — that is real git, driven by the agents
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
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::Notify;

use crate::auth::AuthStore;
use crate::git::{self, GitRuntime};
use crate::projects::ProjectsStore;
use crate::settings::SettingsStore;
use crate::store::{now_ms, Chat, Store};

const CYCLE: Duration = Duration::from_secs(15);
const MAX_BACKOFF: Duration = Duration::from_secs(120);
const MAX_BATCH: usize = 10;
const MAX_BATCH_BYTES: usize = 8 * 1024 * 1024;
const MAX_PREPARED_PER_CYCLE: usize = 3;
const MEDIA_MEMORY: usize = 2000;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
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
}

/// What the Settings sheet (and support) can show without exposing any git.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncView {
    pub enabled: bool,
    /// off | idle | syncing | error
    pub state: String,
    pub cursor: i64,
    pub pending: usize,
    pub last_sync_at: i64,
    pub message: Option<String>,
}

impl SyncView {
    fn off() -> Self {
        Self {
            enabled: false,
            state: "off".into(),
            cursor: 0,
            pending: 0,
            last_sync_at: 0,
            message: None,
        }
    }
}

/// How the engine tells the window that something arrived. A closure keeps the
/// engine testable without a running Tauri app.
pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

pub struct SyncEngine {
    emit: Emitter,
    data_dir: PathBuf,
    auth: Arc<AuthStore>,
    store: Arc<Store>,
    projects: Arc<ProjectsStore>,
    settings: Arc<SettingsStore>,
    git: Option<GitRuntime>,
    state: Mutex<SyncState>,
    view: Mutex<SyncView>,
    notify: Notify,
    client: reqwest::Client,
    configured_token: Mutex<Option<String>>,
    media_seen: Mutex<HashSet<String>>,
}

impl SyncEngine {
    pub fn new(
        emit: Emitter,
        data_dir: &Path,
        auth: Arc<AuthStore>,
        store: Arc<Store>,
        projects: Arc<ProjectsStore>,
        settings: Arc<SettingsStore>,
        git: Option<GitRuntime>,
    ) -> Self {
        let path = data_dir.join("sync.json");
        let state = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<SyncState>(&raw).ok())
            .unwrap_or_default();
        let media_seen = state.media.iter().cloned().collect();
        let view = if auth.required() {
            SyncView {
                enabled: true,
                state: "idle".into(),
                cursor: state.cursor,
                pending: state.pending_chats.len(),
                last_sync_at: 0,
                message: None,
            }
        } else {
            SyncView::off()
        };
        let engine = Self {
            emit,
            data_dir: data_dir.to_path_buf(),
            auth,
            store,
            projects,
            settings,
            git,
            state: Mutex::new(state),
            view: Mutex::new(view),
            notify: Notify::new(),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(Duration::from_secs(45))
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
            configured_token: Mutex::new(None),
            media_seen: Mutex::new(media_seen),
        };
        // A device that has never synced uploads the whole local history once.
        if engine.auth.required() && engine.state.lock().map(|s| s.owner.is_empty()).unwrap_or(true) {
            engine.store.mark_all_dirty();
        }
        engine
    }

    pub fn status(&self) -> SyncView {
        let mut view = lock(&self.view).clone();
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

    pub fn spawn(self: Arc<Self>) {
        tauri::async_runtime::spawn(async move {
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
        self.ensure_owner(&owner)?;
        {
            let mut view = lock(&self.view);
            view.state = "syncing".into();
            view.enabled = true;
        }
        self.configure_git().await;
        self.push_chats(&token).await?;
        self.push_projects(&token).await?;
        self.pull(&token).await?;
        self.prepare_projects().await;
        Ok(())
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
    async fn push_chats(&self, token: &str) -> Result<(), String> {
        let mut ids = self.store.dirty_ids();
        for id in lock(&self.state).pending_chats.clone() {
            if !ids.contains(&id) {
                ids.push(id);
            }
        }
        ids.sort();
        ids.dedup();
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
                    } else if let Some(chat_value) = result.get("chat") {
                        match serde_json::from_value::<Chat>(chat_value.clone()) {
                            Ok(mut chat) => {
                                if let Err(error) = self.store.save_remote(&mut chat) {
                                    eprintln!("hook: could not apply a synced chat: {error}");
                                }
                            }
                            Err(error) => {
                                eprintln!("hook: the account returned a broken chat: {error}")
                            }
                        }
                    }
                    applied.push(id.to_string());
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
            let _ = self.store.save_remote(chat);
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
        let mut sends: Vec<(String, String)> = Vec::new();
        {
            let state = lock(&self.state);
            for project in &projects {
                let fingerprint = format!("{}|{}", project.name, project.description);
                if state.project_versions.get(&project.id) != Some(&fingerprint) {
                    sends.push((project.id.clone(), fingerprint));
                }
            }
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
                                eprintln!(
                                    "hook: project {id} was not accepted: {}",
                                    result["error"].as_str().unwrap_or("unknown")
                                );
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

    // ── pull ────────────────────────────────────────────────────────────
    async fn pull(&self, token: &str) -> Result<(), String> {
        let mut cursor = lock(&self.state).cursor;
        let mut chats_changed = false;
        let mut projects_changed = false;
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
                            // written right now; retry once that turn ends.
                            if chat
                                .messages
                                .iter()
                                .any(|message| message.status == "streaming")
                            {
                                deferred = true;
                                break;
                            }
                            if !self.download_media(token, &chat).await {
                                // A transient picture failure: keep the cursor
                                // where it is and retry the whole chat later.
                                deferred = true;
                                break;
                            }
                            if let Err(error) = self.store.save_remote(&mut chat) {
                                eprintln!("hook: could not apply a synced chat: {error}");
                            } else {
                                chats_changed = true;
                            }
                        }
                    }
                    "project" if change["deleted"].as_bool() != Some(true) => {
                        let id = change["id"].as_str().unwrap_or_default();
                        let name = change["name"].as_str().unwrap_or_default();
                        let description = change["description"].as_str().unwrap_or_default();
                        let created_at = change["createdAt"].as_i64().unwrap_or(0);
                        let updated_at = change["updatedAt"].as_i64().unwrap_or(0);
                        match self.projects.bind(
                            &self.settings.projects_dir(),
                            id,
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
                            Err(error) => eprintln!("hook: could not bind a synced project: {error}"),
                        }
                    }
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

        if chats_changed || projects_changed {
            (self.emit)(
                "hook://sync",
                json!({
                    "chats": chats_changed,
                    "projects": projects_changed,
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
            None,
        )
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
                    merged["meta"]["updatedAt"] = serde_json::json!(3000);
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
}

