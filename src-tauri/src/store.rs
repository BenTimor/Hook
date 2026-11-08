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
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning: Option<String>,
    pub created_at: i64,
    /// complete | streaming | error | aborted
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}

impl Message {
    pub fn new(role: &str, content: &str, status: &str) -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            role: role.to_string(),
            content: content.to_string(),
            reasoning: None,
            created_at: now_ms(),
            status: status.to_string(),
            error: None,
            usage: None,
        }
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
            },
            messages: Vec::new(),
        }
    }

    /// Recompute derived metadata from the message list.
    pub fn refresh_meta(&mut self) {
        self.meta.message_count = self.messages.len();
        self.meta.preview = self
            .messages
            .iter()
            .rev()
            .find(|m| !m.content.trim().is_empty())
            .map(|m| truncate(&m.content.replace('\n', " "), 160))
            .unwrap_or_default();
    }
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
}

impl Store {
    pub fn new(root: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(root.join("chats")).map_err(|e| format!("create data dir: {e}"))?;
        fs::create_dir_all(root.join("trash")).map_err(|e| format!("create trash dir: {e}"))?;
        Ok(Self {
            root,
            cache: Mutex::new(None),
        })
    }

    fn guard(&self) -> MutexGuard<'_, Option<Vec<ChatMeta>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
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
        Ok(())
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<ChatMeta, String> {
        let mut chat = self.load(id)?;
        let title = title.trim();
        chat.meta.title = if title.is_empty() {
            DEFAULT_TITLE.to_string()
        } else {
            truncate(title, 120)
        };
        self.save(&mut chat)?;
        Ok(chat.meta)
    }

    pub fn set_pinned(&self, id: &str, pinned: bool) -> Result<ChatMeta, String> {
        let mut chat = self.load(id)?;
        chat.meta.pinned = pinned;
        chat.meta.pinned_at = if pinned { Some(now_ms()) } else { None };
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
        Ok(())
    }

    pub fn restore(&self, id: &str) -> Result<ChatMeta, String> {
        if !is_safe_id(id) {
            return Err("Invalid chat id".into());
        }
        let from = self.root.join("trash").join(format!("{id}.json"));
        let to = self.chat_path(id);
        fs::rename(&from, &to).map_err(|e| format!("restore chat: {e}"))?;
        let chat = self.load(id)?;
        let mut guard = self.guard();
        if let Some(metas) = guard.as_mut() {
            if !metas.iter().any(|m| m.id == chat.meta.id) {
                metas.push(chat.meta.clone());
            }
            sort_metas(metas);
        }
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

fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
