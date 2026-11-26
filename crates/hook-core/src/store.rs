use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// What a conversation is called until its agent names it. A title is written
/// by the model itself, with the `set_title` tool (see
/// [`Chat::set_agent_title`]); Hook never names a conversation after the
/// user's first message.
pub const DEFAULT_TITLE: &str = "Untitled";

/// The longest title an agent may write. Long enough for a sentence, short
/// enough to stay one line in the sidebar.
pub const MAX_GENERATED_TITLE: usize = 72;

/// A conversation the user has with one coding agent directly, without the
/// chat agent in between. It lives in the same list as every other chat; the
/// kind is what sends its turns to `pi` instead of the model, what keeps it out
/// of the other products' quick-access panel, and what hides it from the
/// sidebar while advanced mode is off. It is also local-only: the agent's
/// process, session file and folder exist on one machine, and half of that
/// arriving on another would be worse than not arriving at all.
pub const KIND_CODING: &str = "coding";

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u32,
    #[serde(default)]
    pub completion_tokens: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallRecord {
    pub id: String,
    pub name: String,
    /// Raw JSON arguments exactly as the model produced them.
    #[serde(default)]
    pub arguments: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    /// Field the reasoning was streamed in (`reasoning_content` / `reasoning`).
    /// Thinking-mode providers require it back in the same field on replay.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_field: Option<String>,
    pub created_at: i64,
    /// complete | streaming | error | aborted
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    /// Assistant tool calls, replayed verbatim to the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<ToolCallRecord>>,
    /// Set on `role: "tool"` results.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    /// Internal bookkeeping (agent events, tool traffic) the user never sees.
    #[serde(default, skip_serializing_if = "is_false")]
    pub hidden: bool,
    /// What a hidden context message is for: `memory` for a memory frame, empty
    /// for a coding-agent note. Both are replayed in order like any other
    /// message — that is what keeps the request prefix stable — and the kind is
    /// how the prompt tells "is a note waiting" from "is this a frame".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Pictures that belong to this message.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub attachments: Vec<Attachment>,
    /// Set on `role: "compaction"`: what the summary folded and how big the
    /// context was on either side. The summary itself is `content`. A
    /// compaction message is `hidden`, so it never counts as a message or
    /// becomes a chat's preview; the thread draws it in advanced mode only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compaction: Option<Compaction>,
}

/// How much context one compaction took away. Token counts are estimates
/// (`compact::estimate`), kept to show the reader what happened.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compaction {
    /// Messages folded into the summary.
    pub messages: usize,
    pub tokens_before: u64,
    pub tokens_after: u64,
}

/// One picture attached to a message. Bytes live on disk; the chat file only
/// keeps the reference, so a conversation with screenshots stays small and
/// readable.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    /// File name inside `<data>/images/<chat id>/`.
    pub file: String,
    pub mime: String,
    /// Display hints for the UI (and for the text placeholder when the model
    /// cannot see images).
    #[serde(default)]
    pub width: u32,
    #[serde(default)]
    pub height: u32,
    #[serde(default)]
    pub bytes: u64,
    /// What the picture is, when known: "screenshot", "user", ...
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Content address used by the sync service. Computed on the first upload,
    /// then kept so every device can recognise the same picture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl Message {
    pub fn new(role: &str, content: &str, status: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.to_string(),
            content: content.to_string(),
            reasoning: None,
            reasoning_field: None,
            created_at: now_ms(),
            status: status.to_string(),
            error: None,
            usage: None,
            tool_calls: None,
            tool_call_id: None,
            hidden: false,
            kind: None,
            attachments: Vec::new(),
            compaction: None,
        }
    }

    /// A compaction marker: hidden, so it never counts as a message and never
    /// becomes a preview, but it sits where the cut happened and carries the
    /// summary every later request starts from.
    pub fn compaction(summary: &str) -> Self {
        Self::hidden("compaction", summary)
    }

    /// A message that participates in the model's history but is never drawn.
    pub fn hidden(role: &str, content: &str) -> Self {
        let mut message = Self::new(role, content, "complete");
        message.hidden = true;
        message
    }

    /// A context frame: a hidden message with a kind, so the prompt can tell a
    /// memory frame from a coding-agent note.
    pub fn frame(kind: &str, content: &str) -> Self {
        let mut message = Self::hidden("system", content);
        message.kind = Some(kind.to_string());
        message
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMeta {
    pub id: String,
    pub title: String,
    pub created_at: i64,
    pub updated_at: i64,
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned_at: Option<i64>,
    pub message_count: usize,
    #[serde(default)]
    pub preview: String,
    /// Where an imported conversation came from: "chatgpt" or "claude".
    /// Absent on chats written in Hook (and on chats imported by a build that
    /// predates import); the id is still derived from the source, so a re-import
    /// finds the same chat either way.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    /// The conversation id at the source, so a re-import can tell that this
    /// chat is the same one the export is describing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_id: Option<String>,
    /// The source's own `updated_at` at the moment of the last import. Equal to
    /// `updated_at` while nobody has touched the chat since, which is how a
    /// re-import knows it may replace the contents.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_updated_at: Option<i64>,
    /// `"coding"` when the user talks to a coding agent directly. Absent on
    /// every ordinary chat, so old files need no migration.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// The folder a coding agent works in. Absolute and machine-local: it is
    /// never uploaded, because another computer has no such folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    /// The pi session this coding chat continues after a restart or a settle.
    /// Also local: the session file lives in the app's data folder.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// The machine that owns a direct coding chat. Set on the host that created
    /// it and on a viewer's cached copy; absent on ordinary chats and on coding
    /// chats written before machines existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    /// The account's name for that machine at the time the copy was made. A
    /// display hint; the account service's registry is authoritative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device_name: Option<String>,
    /// This device holds a cached copy of a chat owned by `device_id`, not the
    /// original. Its messages and folder never upload; only the owner's stub
    /// travels through the account.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub remote: bool,
    /// The last live state the owner reported (`idle`, `running`,
    /// `needs_input`, `error`) for a remote stub. Absent on the owner.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stub_state: Option<String>,
}

impl ChatMeta {
    /// The user talks to a coding agent directly in this conversation.
    pub fn is_coding(&self) -> bool {
        self.kind.as_deref() == Some(KIND_CODING)
    }

    /// This machine is the original of a direct coding chat, so it is the one
    /// that pushes the stub the account sees.
    pub fn is_owned_coding(&self, device_id: &str) -> bool {
        self.is_coding()
            && !self.remote
            && self.device_id.as_deref() == Some(device_id)
    }

    /// Chats that belong to this computer only. The account never learns about
    /// their content: see `SyncEngine::push_chats`. A cached remote copy is just
    /// as local — the owner's stub is what the account holds.
    pub fn is_local_only(&self) -> bool {
        self.is_coding() || self.remote
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Chat {
    pub meta: ChatMeta,
    pub messages: Vec<Message>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub chat: ChatMeta,
    pub snippet: String,
}

impl Chat {
    pub fn new() -> Self {
        let now = now_ms();
        Self {
            meta: ChatMeta {
                id: uuid::Uuid::new_v4().to_string(),
                title: DEFAULT_TITLE.to_string(),
                created_at: now,
                updated_at: now,
                pinned: false,
                pinned_at: None,
                message_count: 0,
                preview: String::new(),
                source: None,
                source_id: None,
                source_updated_at: None,
                kind: None,
                project_path: None,
                session_id: None,
                device_id: None,
                device_name: None,
                remote: false,
                stub_state: None,
            },
            messages: Vec::new(),
        }
    }

    /// A conversation with a coding agent in `path`, before it has said
    /// anything. It is untitled like any other chat: the agent names it in its
    /// first reply, and the folder stays where it already is, in
    /// `projectPath` (the window shows it beside the title).
    pub fn new_coding(path: &Path) -> Self {
        let mut chat = Self::new();
        chat.meta.kind = Some(KIND_CODING.to_string());
        chat.meta.project_path = Some(path.to_string_lossy().to_string());
        chat
    }

    /// Name the conversation, or rename it, from the agent's own `set_title`.
    ///
    /// The agent writes the title itself instead of Hook taking the first line
    /// of the user's message: a few words about what the conversation is for
    /// beat a truncated question, and a direct coding agent's folder name says
    /// nothing about the work. The prompt asks for it in the first reply and
    /// after that only when the user asks for a different name; the store does
    /// not enforce either, so someone can always say "call this one X".
    pub fn set_agent_title(&mut self, title: &str) -> Result<String, String> {
        let title = clean_title(title)?;
        self.meta.title = title.clone();
        self.meta.updated_at = now_ms();
        Ok(title)
    }

    /// Recompute derived metadata from the message list.
    pub fn refresh_meta(&mut self) {
        // A remote copy keeps the owner's count: a stub has no messages, and a
        // partial cache still knows how many the host has. The preview is ours
        // to compute when there is something to summarise.
        if !self.meta.remote {
            self.meta.message_count = self
                .messages
                .iter()
                .filter(|m| !m.hidden && m.role != "tool")
                .count();
        }
        self.meta.preview = self
            .messages
            .iter()
            .rev()
            .filter(|m| !m.hidden && m.role != "tool")
            .find(|m| !m.content.trim().is_empty())
            .map(|m| truncate(&m.content.replace('\n', " "), 160))
            .unwrap_or_default();
    }
}

/// Rust canonicalizes Windows paths to verbatim form (`\\?\C:\...`).
/// Strip the prefix so paths stay readable and match what pi writes.
pub fn strip_verbatim(path: impl AsRef<std::path::Path>) -> std::path::PathBuf {
    let path = path.as_ref();
    let Some(text) = path.to_str() else {
        return path.to_path_buf();
    };
    // The verbatim forms Windows hands out for long or UNC paths are not
    // understood by everything we launch, Node included.
    if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
        return std::path::PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        return std::path::PathBuf::from(rest);
    }
    path.to_path_buf()
}

/// A title the model wrote, made fit for the sidebar: one line, no wrapping
/// quotes, no trailing full stop, a bounded length.
fn clean_title(raw: &str) -> Result<String, String> {
    let line = raw.lines().next().unwrap_or("").trim();
    let quoted = line
        .trim_matches(|c: char| matches!(c, '"' | '\'' | '\u{201c}' | '\u{201d}' | '\u{2018}' | '\u{2019}'))
        .trim();
    let sentence = quoted.trim_end_matches('.').trim();
    let collapsed = sentence.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.is_empty() {
        return Err("set_title needs a title of a few words.".into());
    }
    Ok(truncate(&collapsed, MAX_GENERATED_TITLE))
}

pub fn truncate(s: &str, max_chars: usize) -> String {
    let trimmed = s.trim();
    let mut out: String = trimmed.chars().take(max_chars).collect();
    if trimmed.chars().count() > max_chars {
        out.push('…');
    }
    out
}

pub struct Store {
    root: PathBuf,
    cache: Mutex<Option<Vec<ChatMeta>>>,
    /// Chats changed since the last upload, plus the ones the user restored.
    dirty: Mutex<Dirty>,
}

#[derive(Default)]
struct Dirty {
    chats: HashSet<String>,
    restored: HashSet<String>,
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("chats")).map_err(|e| format!("create data dir: {e}"))?;
        fs::create_dir_all(root.join("trash")).map_err(|e| format!("create trash dir: {e}"))?;
        fs::create_dir_all(root.join("images")).map_err(|e| format!("create images dir: {e}"))?;
        Ok(Self {
            root,
            cache: Mutex::new(None),
            dirty: Mutex::new(Dirty::default()),
        })
    }

    fn guard(&self) -> MutexGuard<'_, Option<Vec<ChatMeta>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn mark_dirty(&self, id: &str) {
        self.dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .chats
            .insert(id.to_string());
    }

    /// Ids changed since the last upload. The caller re-reads each chat; one
    /// that no longer loads is a deletion. Peeking instead of draining keeps a
    /// failed upload queued.
    pub fn dirty_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .chats
            .iter()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    /// Forget one id after the account accepted it.
    pub fn clear_dirty(&self, id: &str) {
        self.dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .chats
            .remove(id);
    }

    /// Forget one id once its version reached the account. The version guard
    /// means a save that happened mid-upload stays queued.
    pub fn clear_dirty_if(&self, id: &str, version: i64) {
        let current = self.load(id).map(|chat| chat.meta.updated_at);
        let unchanged = current.map(|value| value == version).unwrap_or(true);
        if unchanged {
            self.dirty
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .chats
                .remove(id);
        }
    }

    /// Chats the user explicitly restored; the server keeps a tombstone and
    /// needs to be told that this push is a revival, not a stale copy.
    pub fn restored_ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .restored
            .iter()
            .cloned()
            .collect();
        ids.sort();
        ids
    }

    pub fn clear_restored(&self, ids: &[String]) {
        let mut dirty = self.dirty.lock().unwrap_or_else(|e| e.into_inner());
        for id in ids {
            dirty.restored.remove(id);
        }
    }

    pub fn mark_all_dirty(&self) {
        if let Ok(metas) = self.list() {
            let mut dirty = self.dirty.lock().unwrap_or_else(|e| e.into_inner());
            for meta in metas {
                // A coding-agent chat belongs to this computer; queueing it
                // would only make the status line report work that never moves.
                if meta.is_local_only() {
                    continue;
                }
                dirty.chats.insert(meta.id);
            }
        }
    }

    /// Give coding chats written before machines existed an owner. The host is
    /// this device; a chat that is not a remote cache was created here. Called
    /// once at startup, after the account's device id is known.
    pub fn own_coding(&self, device_id: &str, device_name: &str) {
        let Ok(metas) = self.list() else {
            return;
        };
        for meta in metas.into_iter().filter(|meta| {
            meta.is_coding() && !meta.remote && meta.device_id.is_none()
        }) {
            let Ok(mut chat) = self.load(&meta.id) else {
                continue;
            };
            chat.meta.device_id = Some(device_id.to_string());
            chat.meta.device_name = Some(device_name.to_string());
            // A coding chat is local-only, so this does not enter the upload
            // queue; the stub path in `sync.rs` handles it instead.
            let _ = self.save(&mut chat);
        }
    }

    /// Number of chats waiting to upload (used by the status line).
    pub fn dirty_count(&self) -> usize {
        self.dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .chats
            .len()
    }

    fn chat_path(&self, id: &str) -> PathBuf {
        self.root.join("chats").join(format!("{id}.json"))
    }

    fn scan(&self) -> Result<Vec<ChatMeta>, String> {
        let dir = self.root.join("chats");
        let entries = fs::read_dir(&dir).map_err(|e| format!("read chats: {e}"))?;
        let mut metas = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            match fs::read(&path)
                .map_err(|e| e.to_string())
                .and_then(|bytes| serde_json::from_slice::<Chat>(&bytes).map_err(|e| e.to_string()))
            {
                Ok(chat) => metas.push(chat.meta),
                Err(e) => eprintln!("hook: skipping unreadable chat {:?}: {e}", path),
            }
        }
        sort_metas(&mut metas);
        Ok(metas)
    }

    pub fn list(&self) -> Result<Vec<ChatMeta>, String> {
        let mut guard = self.guard();
        if guard.is_none() {
            *guard = Some(self.scan()?);
        }
        let mut metas = guard.clone().unwrap_or_default();
        sort_metas(&mut metas);
        Ok(metas)
    }

    pub fn load(&self, id: &str) -> Result<Chat, String> {
        if !is_safe_id(id) {
            return Err("Invalid chat id".into());
        }
        let path = self.chat_path(id);
        let bytes = fs::read(&path).map_err(|_| "Chat not found".to_string())?;
        serde_json::from_slice::<Chat>(&bytes).map_err(|e| format!("Corrupt chat file: {e}"))
    }

    pub fn save(&self, chat: &mut Chat) -> Result<(), String> {
        self.save_inner(chat, true).map(|_| ())
    }

    /// Write a version that arrived from the account. It is already the
    /// canonical one, so it must not be queued for upload again.
    ///
    /// Returns false when this machine has moved past that copy, in which case
    /// nothing is written: the account's copy is a snapshot from before a reply
    /// or a picture the turn wrote meanwhile, and putting it back would delete
    /// it. The caller keeps the chat queued so the next push merges both sides.
    pub fn save_remote(&self, chat: &mut Chat) -> Result<bool, String> {
        if let Ok(local) = self.load(&chat.meta.id) {
            if local.meta.updated_at > chat.meta.updated_at {
                return Ok(false);
            }
        }
        self.save_inner(chat, false)
    }

    /// Apply a remote coding-chat stub. The owner's row is the only copy the
    /// account holds; this device keeps its messages, if it has any, and only
    /// takes the label, the count and the live state. A stub for a chat this
    /// device owns is ignored — the owner is authoritative.
    pub fn apply_stub(&self, stub: ChatMeta) -> Result<bool, String> {
        match self.load(&stub.id) {
            Ok(mut local) => {
                if !local.meta.remote {
                    return Ok(false);
                }
                local.meta.title = stub.title;
                local.meta.message_count = stub.message_count;
                local.meta.stub_state = stub.stub_state;
                local.meta.device_id = stub.device_id;
                local.meta.device_name = stub.device_name;
                // The label is a local meta update: it must not be refused for
                // being older than the transcript this device already has.
                local.meta.updated_at = local.meta.updated_at.max(stub.updated_at);
                self.save_remote(&mut local)?;
                Ok(true)
            }
            Err(_) => {
                let mut chat = Chat {
                    meta: stub,
                    messages: Vec::new(),
                };
                self.save_remote(&mut chat)?;
                Ok(true)
            }
        }
    }

    fn save_inner(&self, chat: &mut Chat, dirty: bool) -> Result<bool, String> {
        chat.refresh_meta();
        let path = self.chat_path(&chat.meta.id);
        let bytes = serde_json::to_vec_pretty(chat).map_err(|e| e.to_string())?;
        write_atomic(&path, &bytes)?;

        let mut guard = self.guard();
        if let Some(metas) = guard.as_mut() {
            match metas.iter_mut().find(|m| m.id == chat.meta.id) {
                Some(existing) => *existing = chat.meta.clone(),
                None => metas.push(chat.meta.clone()),
            }
            sort_metas(metas);
        }
        drop(guard);
        if dirty && !chat.meta.is_local_only() {
            self.mark_dirty(&chat.meta.id);
        }
        Ok(true)
    }

    /// Folder holding the pictures of one chat.
    pub fn image_dir(&self, chat_id: &str) -> PathBuf {
        self.root.join("images").join(chat_id)
    }

    /// True when the picture's bytes are already on this machine.
    pub fn image_exists(&self, chat_id: &str, attachment_id: &str) -> bool {
        self.image_file(chat_id, attachment_id).is_ok()
    }

    /// Store bytes that arrived from the account under the attachment's own
    /// file name. The mime decides the extension when the record has none.
    pub fn write_remote_image(
        &self,
        chat_id: &str,
        attachment: &Attachment,
        bytes: &[u8],
    ) -> Result<(), String> {
        if !is_safe_id(chat_id) || !is_safe_id(&attachment.id) {
            return Err("Invalid image id".into());
        }
        if bytes.is_empty() || bytes.len() > MAX_IMAGE_BYTES {
            return Err("The synced picture has an unusable size.".into());
        }
        let file = if is_safe_file(&attachment.file) {
            attachment.file.clone()
        } else {
            format!(
                "{}.{}",
                attachment.id,
                extension_for(&attachment.mime).unwrap_or("png")
            )
        };
        let dir = self.image_dir(chat_id);
        fs::create_dir_all(&dir).map_err(|e| format!("create image dir: {e}"))?;
        write_atomic(&dir.join(file), bytes)
    }

    /// Remove a chat because the account says it was deleted elsewhere. No
    /// trash entry: a restore from this device would revive it for everyone.
    pub fn remove_synced(&self, id: &str) {
        if !is_safe_id(id) {
            return;
        }
        let _ = fs::remove_file(self.chat_path(id));
        let _ = fs::remove_dir_all(self.image_dir(id));
        let mut guard = self.guard();
        if let Some(metas) = guard.as_mut() {
            metas.retain(|m| m.id != id);
        }
        drop(guard);
        self.dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .chats
            .remove(id);
    }

    /// Move every conversation that belongs to the previous account aside.
    /// Project folders are left alone; they are the user's own files.
    pub fn quarantine(&self, dest: &Path) -> Result<(), String> {
        fs::create_dir_all(dest).map_err(|e| format!("create account folder: {e}"))?;
        for name in ["chats", "trash", "images"] {
            let from = self.root.join(name);
            let to = dest.join(name);
            if !from.is_dir() {
                continue;
            }
            let _ = fs::remove_dir_all(&to);
            fs::rename(&from, &to).map_err(|e| format!("move {name}: {e}"))?;
            fs::create_dir_all(&from).map_err(|e| format!("recreate {name}: {e}"))?;
        }
        *self.guard() = Some(Vec::new());
        *self.dirty.lock().unwrap_or_else(|e| e.into_inner()) = Dirty::default();
        Ok(())
    }

    /// Store encoded bytes as a picture that belongs to `chat_id`.
    pub fn save_image(
        &self,
        chat_id: &str,
        mime: &str,
        data: &[u8],
        width: u32,
        height: u32,
        kind: Option<&str>,
    ) -> Result<Attachment, String> {
        if !is_safe_id(chat_id) {
            return Err("Invalid chat id".into());
        }
        if data.is_empty() {
            return Err("The image is empty.".into());
        }
        if data.len() > MAX_IMAGE_BYTES {
            return Err(format!(
                "That image is {:.1} MB; the limit is {} MB.",
                data.len() as f64 / 1_048_576.0,
                MAX_IMAGE_BYTES / 1_048_576
            ));
        }
        let ext = extension_for(mime)?;
        let dir = self.image_dir(chat_id);
        fs::create_dir_all(&dir).map_err(|e| format!("create image dir: {e}"))?;

        let id = format!("img_{}", uuid::Uuid::new_v4().simple());
        let file = format!("{id}.{ext}");
        write_atomic(&dir.join(&file), data)?;

        Ok(Attachment {
            id,
            file,
            mime: mime.to_string(),
            width,
            height,
            bytes: data.len() as u64,
            kind: kind.map(str::to_string),
            sha256: Some(sha256_hex(data)),
        })
    }

    /// Copy a picture from somewhere on disk (a coding agent's screenshot) into
    /// the chat that should show it.
    pub fn adopt_image(
        &self,
        chat_id: &str,
        source: &Path,
        kind: Option<&str>,
    ) -> Result<Attachment, String> {
        let meta = fs::metadata(source).map_err(|e| format!("{}: {e}", source.display()))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file", source.display()));
        }
        if meta.len() as usize > MAX_IMAGE_BYTES {
            return Err(format!(
                "{} is {:.1} MB; the limit is {} MB.",
                source.display(),
                meta.len() as f64 / 1_048_576.0,
                MAX_IMAGE_BYTES / 1_048_576
            ));
        }
        let mime = mime_for_path(source)?;
        let data = fs::read(source).map_err(|e| format!("{}: {e}", source.display()))?;
        let (width, height) = image_size(&data).unwrap_or((0, 0));
        self.save_image(chat_id, mime, &data, width, height, kind)
    }

    /// Read a stored picture back as a data URL for the UI.
    /// The file behind an attachment, so it can be read, copied or handed to
    /// the OS.
    pub fn image_file(&self, chat_id: &str, attachment_id: &str) -> Result<PathBuf, String> {
        if !is_safe_id(chat_id) || !is_safe_id(attachment_id) {
            return Err("Invalid image id".into());
        }
        let dir = self.image_dir(chat_id);
        let prefix = format!("{attachment_id}.");
        let entry = fs::read_dir(&dir)
            .map_err(|_| "Image not found".to_string())?
            .flatten()
            .find(|e| e.file_name().to_string_lossy().starts_with(&prefix))
            .ok_or_else(|| "Image not found".to_string())?;
        Ok(entry.path())
    }

    pub fn read_image(&self, chat_id: &str, attachment_id: &str) -> Result<String, String> {
        let path = self.image_file(chat_id, attachment_id)?;
        let bytes = fs::read(&path).map_err(|_| "Image not found".to_string())?;
        let mime = mime_for_path(&path).unwrap_or("image/png");
        Ok(format!("data:{mime};base64,{}", base64_encode(&bytes)))
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<ChatMeta, String> {
        let mut chat = self.load(id)?;
        let title = title.trim();
        chat.meta.title = if title.is_empty() {
            DEFAULT_TITLE.to_string()
        } else {
            truncate(title, 120)
        };
        chat.meta.updated_at = now_ms();
        self.save(&mut chat)?;
        Ok(chat.meta)
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<ChatMeta, String> {
        let mut chat = self.load(id)?;
        chat.meta.pinned = pinned;
        chat.meta.pinned_at = if pinned { Some(now_ms()) } else { None };
        chat.meta.updated_at = now_ms();
        self.save(&mut chat)?;
        Ok(chat.meta)
    }

    pub fn delete(&self, id: &str) -> Result<(), String> {
        if !is_safe_id(id) {
            return Err("Invalid chat id".into());
        }
        let from = self.chat_path(id);
        let to = self.root.join("trash").join(format!("{id}.json"));
        fs::rename(&from, &to).map_err(|e| format!("delete chat: {e}"))?;
        let mut guard = self.guard();
        if let Some(metas) = guard.as_mut() {
            metas.retain(|m| m.id != id);
        }
        drop(guard);
        self.mark_dirty(id);
        Ok(())
    }

    pub fn restore(&self, id: &str) -> Result<ChatMeta, String> {
        if !is_safe_id(id) {
            return Err("Invalid chat id".into());
        }
        let from = self.root.join("trash").join(format!("{id}.json"));
        let to = self.chat_path(id);
        fs::rename(&from, &to).map_err(|e| format!("restore chat: {e}"))?;
        let mut chat = self.load(id)?;
        chat.meta.updated_at = now_ms();
        self.save_remote(&mut chat)?;
        let mut guard = self.guard();
        if let Some(metas) = guard.as_mut() {
            if !metas.iter().any(|m| m.id == chat.meta.id) {
                metas.push(chat.meta.clone());
            }
            sort_metas(metas);
        }
        drop(guard);
        self.mark_dirty(id);
        self.dirty
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .restored
            .insert(id.to_string());
        Ok(chat.meta)
    }

    pub fn search(&self, query: &str) -> Result<Vec<SearchHit>, String> {
        let needle = query.trim().to_lowercase();
        if needle.is_empty() {
            return Ok(Vec::new());
        }
        let mut hits = Vec::new();
        for meta in self.list()? {
            if hits.len() >= 24 {
                break;
            }
            let title_match = meta.title.to_lowercase().contains(&needle);
            let Ok(chat) = self.load(&meta.id) else {
                continue;
            };
            let content_match = chat
                .messages
                .iter()
                .filter(|m| !m.hidden)
                .find(|m| m.content.to_lowercase().contains(&needle));
            if title_match {
                hits.push(SearchHit {
                    snippet: if meta.preview.is_empty() {
                        "Title match".to_string()
                    } else {
                        truncate(&plain_text(&meta.preview), 150)
                    },
                    chat: meta,
                });
            } else if let Some(msg) = content_match {
                hits.push(SearchHit {
                    snippet: snippet_around(&msg.content, &needle, 110),
                    chat: meta,
                });
            }
        }
        Ok(hits)
    }
}

fn is_safe_file(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 128
        && file
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
        && !file.starts_with('.')
        && !file.contains("..")
}

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Hard cap for one picture. Bigger than any screenshot or phone photo needs
/// to be after the UI has downscaled it.
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;

fn extension_for(mime: &str) -> Result<&'static str, String> {
    match mime {
        "image/png" => Ok("png"),
        "image/jpeg" | "image/jpg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        "image/gif" => Ok("gif"),
        other => Err(format!("Unsupported image type: {other}")),
    }
}

fn mime_for_path(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => Ok("image/png"),
        Some("jpg") | Some("jpeg") => Ok("image/jpeg"),
        Some("webp") => Ok("image/webp"),
        Some("gif") => Ok("image/gif"),
        other => Err(format!("Unsupported image type: {}", other.unwrap_or("?"))),
    }
}

/// Width and height straight from the file header. No decoder needed: only the
/// three formats Hook accepts, and only for a display hint.
pub fn image_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() > 24 && bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
        let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
        return Some((width, height));
    }
    if bytes.len() > 10 && bytes.starts_with(b"GIF8") {
        let width = u16::from_le_bytes(bytes[6..8].try_into().ok()?) as u32;
        let height = u16::from_le_bytes(bytes[8..10].try_into().ok()?) as u32;
        return Some((width, height));
    }
    if bytes.len() > 4 && bytes[0] == 0xFF && bytes[1] == 0xD8 {
        // JPEG: walk the segment markers until a start-of-frame.
        let mut i = 2;
        while i + 9 < bytes.len() {
            if bytes[i] != 0xFF {
                i += 1;
                continue;
            }
            let marker = bytes[i + 1];
            if (0xC0..=0xCF).contains(&marker) && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                let height = u16::from_be_bytes(bytes[i + 5..i + 7].try_into().ok()?) as u32;
                let width = u16::from_be_bytes(bytes[i + 7..i + 9].try_into().ok()?) as u32;
                return Some((width, height));
            }
            let len = u16::from_be_bytes(bytes[i + 2..i + 4].try_into().ok()?) as usize;
            if len < 2 {
                return None;
            }
            i += 2 + len;
        }
        return None;
    }
    if bytes.len() > 30 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        if &bytes[12..16] == b"VP8X" {
            let width = 1 + u32::from_le_bytes([bytes[24], bytes[25], bytes[26], 0]);
            let height = 1 + u32::from_le_bytes([bytes[27], bytes[28], bytes[29], 0]);
            return Some((width, height));
        }
    }
    None
}

/// Minimal base64 encoder: no newline wrapping, standard alphabet.
pub fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(triple >> 18) as usize & 63] as char);
        out.push(TABLE[(triple >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(triple >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[triple as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

/// Minimal base64 decoder that tolerates data URLs and whitespace.
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let raw = input
        .rsplit(',')
        .next()
        .unwrap_or(input)
        .chars()
        .filter(|c| !c.is_whitespace());
    let mut out = Vec::new();
    let mut buffer: u32 = 0;
    let mut bits = 0;
    for ch in raw {
        let value = match ch {
            'A'..='Z' => ch as u32 - 'A' as u32,
            'a'..='z' => ch as u32 - 'a' as u32 + 26,
            '0'..='9' => ch as u32 - '0' as u32 + 52,
            '+' => 62,
            '/' => 63,
            '=' => break,
            _ => return Err("Invalid base64 image data".into()),
        };
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // A unique temp name, never one shared per target: two writers (a turn and
    // the sync engine, on different threads) would otherwise fill the same file
    // and the rename would commit whichever bytes landed last — a lost update
    // that put an older copy back on disk under a newer save.
    let tmp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4().simple()));
    fs::write(&tmp, bytes).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("commit: {e}")
    })
}

/// The digest the account names a picture by. Computed when the picture is
/// stored, so a chat never has to be re-saved to learn it.
pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn sort_metas(metas: &mut [ChatMeta]) {
    metas.sort_by(|a, b| {
        b.pinned
            .cmp(&a.pinned)
            .then_with(|| b.pinned_at.unwrap_or(0).cmp(&a.pinned_at.unwrap_or(0)))
            .then_with(|| b.updated_at.cmp(&a.updated_at))
    });
}

fn snippet_around(content: &str, needle: &str, radius: usize) -> String {
    let lower = content.to_lowercase();
    let Some(pos) = lower.find(needle) else {
        return truncate(&plain_text(content), radius);
    };
    let start_byte = floor_char_boundary(content, pos.saturating_sub(radius / 2));
    let end_byte = ceil_char_boundary(content, (pos + needle.len() + radius / 2).min(content.len()));
    let slice = plain_text(&content[start_byte..end_byte]);
    let mut out = String::new();
    if start_byte > 0 {
        out.push('…');
    }
    out.push_str(&truncate(&slice, radius));
    if end_byte < content.len() {
        out.push('…');
    }
    out
}

/// Flattens markdown into a single readable line for search snippets.
fn plain_text(input: &str) -> String {
    let mut kept = String::with_capacity(input.len());
    let mut fenced = false;
    for line in input.lines() {
        if line.trim_start().starts_with("```") {
            fenced = !fenced;
            continue;
        }
        if fenced {
            continue;
        }
        kept.push_str(line);
        kept.push(' ');
    }
    let stripped: String = kept
        .chars()
        .map(|c| match c {
            '`' | '*' | '#' | '>' | '|' | '_' => ' ',
            other => other,
        })
        .collect();
    stripped.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn floor_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

fn ceil_char_boundary(s: &str, mut i: usize) -> usize {
    if i >= s.len() {
        return s.len();
    }
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 1x1 pixel PNG.
    const PNG: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    #[test]
    fn a_title_from_the_agent_is_cleaned_and_can_change() {
        let mut chat = Chat::new();
        assert_eq!(chat.meta.title, DEFAULT_TITLE);
        chat.messages.push(Message::new("user", "why is my invoice total wrong", "complete"));
        // The model's own punctuation is not part of the name.
        assert_eq!(
            chat.set_agent_title("  \"Fixing the invoice total.\"  ").unwrap(),
            "Fixing the invoice total"
        );
        assert_eq!(chat.meta.title, "Fixing the invoice total");
        // The user asking for a different name is ordinary work, not a special
        // case: a second call replaces the title like the first one set it.
        assert_eq!(chat.set_agent_title("Invoice totals").unwrap(), "Invoice totals");
        assert_eq!(chat.meta.title, "Invoice totals");
        // A title is one line and it is bounded.
        let title = chat
            .set_agent_title(&format!("{}\nsecond line", "word ".repeat(40)))
            .unwrap();
        assert!(!title.contains('\n'));
        // `truncate` marks the cut with one ellipsis.
        assert!(title.chars().count() <= MAX_GENERATED_TITLE + 1);
        // An empty one is refused rather than becoming a blank row.
        assert!(chat.set_agent_title("   ").is_err());
        assert_ne!(chat.meta.title, DEFAULT_TITLE);
    }

    #[test]
    fn a_picture_records_its_digest_when_it_is_stored() {
        // The account names a picture by its digest. Learning it later meant
        // re-saving the chat mid-upload, which could undo a reply the turn had
        // just written.
        let root = std::env::temp_dir().join(format!("hook-digest-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let mut chat = Chat::new();
        store.save(&mut chat).unwrap();
        let attachment = store.save_image(&chat.meta.id, "image/png", PNG, 1, 1, Some("user")).unwrap();
        assert_eq!(
            attachment.sha256.as_deref(),
            Some(sha256_hex(PNG).as_str()),
            "the digest is known before the first push"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_copy_from_the_account_never_replaces_a_newer_one_here() {
        let root = std::env::temp_dir().join(format!("hook-stamp-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let mut chat = Chat::new();
        chat.messages.push(Message::new("user", "hello", "complete"));
        store.save(&mut chat).unwrap();
        let older = store.load(&chat.meta.id).unwrap();

        // The turn writes the reply after that copy was taken.
        let mut newer = store.load(&chat.meta.id).unwrap();
        newer.messages.push(Message::new("assistant", "the answer", "complete"));
        newer.meta.updated_at = older.meta.updated_at + 5_000;
        store.save(&mut newer).unwrap();

        // The account's snapshot is from before it.
        let mut stale = older.clone();
        assert!(!store.save_remote(&mut stale).unwrap(), "an older copy must not land");
        let kept = store.load(&chat.meta.id).unwrap();
        assert_eq!(kept.messages.len(), 2, "the reply is still there");

        // A copy the account made later does land.
        let mut fresher = older.clone();
        fresher.meta.updated_at = newer.meta.updated_at + 5_000;
        fresher.messages.push(Message::new("user", "from my laptop", "complete"));
        assert!(store.save_remote(&mut fresher).unwrap());
        let applied = store.load(&chat.meta.id).unwrap();
        assert_eq!(
            applied.messages.last().map(|message| message.content.as_str()),
            Some("from my laptop")
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_coding_chat_stays_on_this_computer() {
        let root = std::env::temp_dir().join(format!("hook-img-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let path = root.join("demo project");
        std::fs::create_dir_all(&path).unwrap();

        let mut chat = Chat::new_coding(&path);
        assert!(chat.meta.is_coding());
        assert!(chat.meta.is_local_only());
        // The folder is not the title: the agent names the conversation in its
        // first reply, and the folder stays in `projectPath` where the window
        // shows it.
        assert_eq!(chat.meta.title, DEFAULT_TITLE);
        assert!(chat.meta.project_path.as_deref().unwrap().ends_with("demo project"));
        store.save(&mut chat).unwrap();
        // Never queued for upload, so the account cannot be handed a folder
        // path and a session file that only exist here.
        assert!(store.dirty_ids().is_empty());

        // An ordinary chat still is.
        let mut ordinary = Chat::new();
        store.save(&mut ordinary).unwrap();
        assert_eq!(store.dirty_ids(), vec![ordinary.meta.id.clone()]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_remote_stub_lists_a_chat_without_its_messages() {
        let root = std::env::temp_dir().join(format!("hook-stub-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let stub = ChatMeta {
            id: "remote-1".into(),
            title: "Fix the parser".into(),
            created_at: 1000,
            updated_at: 2000,
            pinned: false,
            pinned_at: None,
            message_count: 7,
            preview: String::new(),
            source: None,
            source_id: None,
            source_updated_at: None,
            kind: Some(KIND_CODING.into()),
            project_path: None,
            session_id: None,
            device_id: Some("studio".into()),
            device_name: Some("Studio Mac".into()),
            remote: true,
            stub_state: Some("running".into()),
        };

        assert!(store.apply_stub(stub.clone()).unwrap());
        let chat = store.load("remote-1").unwrap();
        assert!(chat.messages.is_empty());
        assert_eq!(chat.meta.message_count, 7, "the stub keeps the host's count");
        assert!(chat.meta.remote);
        assert!(chat.meta.is_local_only());
        assert!(store.dirty_ids().is_empty(), "a cache never uploads");

        // A later stub updates the label and the state but keeps the messages
        // this device already fetched.
        let mut cache = chat;
        cache.messages.push(Message::new("user", "hello", "complete"));
        store.save_remote(&mut cache).unwrap();
        let mut next = stub;
        next.title = "Fix the parser again".into();
        next.message_count = 8;
        next.stub_state = Some("idle".into());
        assert!(store.apply_stub(next).unwrap());
        let after = store.load("remote-1").unwrap();
        assert_eq!(after.messages.len(), 1);
        assert_eq!(after.meta.title, "Fix the parser again");
        assert_eq!(after.meta.message_count, 8);
        assert_eq!(after.meta.stub_state.as_deref(), Some("idle"));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_local_coding_chat_is_never_turned_into_a_cache() {
        let root = std::env::temp_dir().join(format!("hook-stub-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let path = root.join("project");
        std::fs::create_dir_all(&path).unwrap();
        let mut own = Chat::new_coding(&path);
        own.meta.device_id = Some("this".into());
        own.meta.device_name = Some("This computer".into());
        assert!(own.meta.is_owned_coding("this"));
        assert!(!own.meta.is_owned_coding("other"));
        store.save(&mut own).unwrap();

        let mut stub = own.meta.clone();
        stub.remote = true;
        stub.device_id = Some("other".into());
        assert!(!store.apply_stub(stub).unwrap());
        assert!(!store.load(&own.meta.id).unwrap().meta.remote);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn base64_round_trips() {
        assert_eq!(base64_encode(b"a"), "YQ==");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
        assert_eq!(base64_decode("YWJj").unwrap(), b"abc");
        assert_eq!(base64_decode("data:image/png;base64,YWI=").unwrap(), b"ab");
        assert!(base64_decode("!!!").is_err());
        assert_eq!(base64_decode(&base64_encode(PNG)).unwrap(), PNG);
    }

    #[test]
    fn image_size_reads_the_header() {
        assert_eq!(image_size(PNG), Some((1, 1)));
        assert_eq!(image_size(b"not an image"), None);
    }

    #[test]
    fn images_are_stored_and_read_back() {
        let root = std::env::temp_dir().join(format!("hook-img-{}", uuid::Uuid::new_v4()));
        let store = Store::new(root.clone()).unwrap();
        let mut chat = Chat::new();
        let id = chat.meta.id.clone();

        let attachment = store
            .save_image(&id, "image/png", PNG, 1, 1, Some("user"))
            .unwrap();
        assert!(attachment.file.ends_with(".png"));
        assert_eq!(attachment.bytes as usize, PNG.len());

        let data_url = store.read_image(&id, &attachment.id).unwrap();
        assert!(data_url.starts_with("data:image/png;base64,"));

        chat.messages.push(Message::new("user", "look", "complete"));
        chat.messages[0].attachments.push(attachment.clone());
        store.save(&mut chat).unwrap();

        let reloaded = store.load(&id).unwrap();
        assert_eq!(reloaded.messages[0].attachments.len(), 1);
        assert_eq!(reloaded.messages[0].attachments[0].id, attachment.id);

        // Unknown ids and refused inputs never guess.
        assert!(store.read_image(&id, "img_nope").is_err());
        assert!(store.save_image("../escape", "image/png", PNG, 1, 1, None).is_err());
        assert!(store.save_image(&id, "image/tiff", PNG, 1, 1, None).is_err());

        let _ = std::fs::remove_dir_all(&root);
    }
}
