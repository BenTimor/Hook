use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

pub const DEFAULT_TITLE: &str = "New chat";

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
        }
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
            },
            messages: Vec::new(),
        }
    }

    /// Recompute derived metadata from the message list.
    pub fn refresh_meta(&mut self) {
        self.meta.message_count = self
            .messages
            .iter()
            .filter(|m| !m.hidden && m.role != "tool")
            .count();
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
                dirty.chats.insert(meta.id);
            }
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
        self.save_inner(chat, true)
    }

    /// Write a version that arrived from the account. It is already the
    /// canonical one, so it must not be queued for upload again.
    pub fn save_remote(&self, chat: &mut Chat) -> Result<(), String> {
        self.save_inner(chat, false)
    }

    fn save_inner(&self, chat: &mut Chat, dirty: bool) -> Result<(), String> {
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
        if dirty {
            self.mark_dirty(&chat.meta.id);
        }
        Ok(())
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
            sha256: None,
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
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("write: {e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("commit: {e}"))?;
    Ok(())
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
