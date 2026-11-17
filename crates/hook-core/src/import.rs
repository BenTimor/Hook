//! Import conversations from a ChatGPT or Claude data export.
//!
//! Both vendors hand the user a ZIP containing a `conversations.json`. The
//! shapes differ, but they are both trees once you look closely:
//!
//! - ChatGPT keeps a `mapping` of nodes with `parent`/`children` links and marks
//!   the branch the user actually saw with `current_node`. Editing a prompt
//!   forks that tree, so the bag of nodes holds drafts the user never chose.
//! - Claude keeps a flat `chat_messages` list; regenerating an answer leaves
//!   siblings behind, and the visible branch is the parent chain of the newest
//!   message.
//!
//! Either way we flatten to that one visible branch, which is what the user
//! remembers having.
//!
//! Ids are derived from the source, never random: importing the same export
//! twice, or importing it on a second computer, lands on the same chat id and
//! the same message ids, so sync merges the result instead of duplicating it.
//! That also makes a re-import an update of the chats already there.
//!
//! Nothing here talks to ChatGPT or Claude. The file is the user's own copy,
//! downloaded through the vendor's "export my data" feature — the only route
//! both vendors explicitly provide.

use std::collections::HashSet;
use std::fs::{self, File};
use std::io::Read;
use std::path::Path;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::store::{truncate, Chat, ChatMeta, Message, Store};

/// Claude marks the first message of a conversation with this parent.
const ROOT_SENTINEL: &str = "00000000-0000-4000-8000-000000000000";

/// A conversation longer than this is not a conversation; refuse to walk it.
const MAX_NODES: usize = 100_000;

/// ChatGPT titles are short; Claude names too. Anything longer is a document.
const MAX_TITLE: usize = 120;

const PREFIX_CHATGPT: &str = "cgpt";
const PREFIX_CLAUDE: &str = "cld";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    ChatGpt,
    Claude,
}

impl Source {
    /// Stable key, also what lands in `ChatMeta.source`.
    pub fn key(self) -> &'static str {
        match self {
            Source::ChatGpt => "chatgpt",
            Source::Claude => "claude",
        }
    }

    /// Human name for the UI.
    pub fn label(self) -> &'static str {
        match self {
            Source::ChatGpt => "ChatGPT",
            Source::Claude => "Claude",
        }
    }

    fn prefix(self) -> &'static str {
        match self {
            Source::ChatGpt => PREFIX_CHATGPT,
            Source::Claude => PREFIX_CLAUDE,
        }
    }
}

/// One message, already normalised out of the vendor's shape.
#[derive(Debug, Clone)]
struct ParsedMessage {
    external_id: String,
    role: String,
    content: String,
    reasoning: Option<String>,
    created_at: i64,
}

/// One conversation, already flattened onto its visible branch.
#[derive(Debug, Clone)]
struct Parsed {
    source: Source,
    external_id: String,
    title: String,
    created_at: i64,
    updated_at: i64,
    messages: Vec<ParsedMessage>,
}

impl Parsed {
    fn chat_id(&self) -> String {
        stable_id(self.source.prefix(), &self.external_id)
    }

    /// The newest thing inside the conversation; a stand-in for `update_time`
    /// when the export leaves it null.
    fn last_message_at(&self) -> i64 {
        self.messages
            .iter()
            .map(|m| m.created_at)
            .max()
            .unwrap_or(0)
    }
}

/// What a scan found, before anything is written.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    /// "chatgpt" | "claude"
    pub source: String,
    /// "ChatGPT" | "Claude"
    pub vendor: String,
    /// Archive (or folder) name, for the confirmation line.
    pub file: String,
    /// Conversations with at least one message.
    pub conversations: usize,
    /// Conversations that would be added.
    pub new: usize,
    /// Already imported, with a newer version in this export.
    pub updated: usize,
    /// Already imported, still identical.
    pub unchanged: usize,
    /// Already imported, edited here since. Left alone.
    pub kept_local: usize,
    /// Messages across every conversation in the file.
    pub messages: usize,
    /// Things worth telling the user, already phrased.
    pub warnings: Vec<String>,
}

/// What an import did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub source: String,
    pub vendor: String,
    pub imported: usize,
    pub updated: usize,
    pub unchanged: usize,
    pub kept_local: usize,
    pub messages: usize,
    /// Ids that changed, newest first, so the UI can offer to open one.
    pub chat_ids: Vec<String>,
    pub warnings: Vec<String>,
}

/// Progress for the import card. Emitted as `hook://import`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProgress {
    /// "importing" or "done"
    pub phase: String,
    pub source: String,
    pub done: usize,
    pub total: usize,
}

#[derive(Debug, Clone)]
enum Plan {
    Create,
    Update,
    Unchanged,
    KeepLocal,
}

/// Outcome of one conversation, counted for the UI.
#[derive(Debug, Clone)]
enum Outcome {
    Created(String),
    Updated(String),
    /// Already imported and still identical: nothing was written.
    Unchanged,
    /// Edited in Hook since the last import: the local version won.
    KeepLocal,
}

/// A scan kept between the preview and the confirmation, so a 300 MB export is
/// parsed once instead of twice. Keyed by path, size and mtime: picking another
/// file (or changing this one) simply misses.
struct Cached {
    key: (String, u64, i64),
    parsed: Vec<Parsed>,
    file: String,
    warnings: Vec<String>,
}

#[derive(Default)]
pub struct Importer {
    cache: Mutex<Option<Cached>>,
}

impl Importer {
    pub fn new() -> Self {
        Self::default()
    }

    /// Read the export and say what importing it would do. Writes nothing.
    pub fn scan(&self, store: &Store, path: &Path) -> Result<ImportPreview, String> {
        let (key, parsed, file, warnings) = self.load(path)?;
        let mut preview = ImportPreview {
            source: String::new(),
            vendor: String::new(),
            file,
            conversations: parsed.len(),
            new: 0,
            updated: 0,
            unchanged: 0,
            kept_local: 0,
            messages: parsed.iter().map(|c| c.messages.len()).sum(),
            warnings,
        };
        let source = parsed
            .first()
            .map(|c| c.source)
            .ok_or_else(|| unsupported())?;
        for conversation in &parsed {
            match plan(store, conversation) {
                Plan::Create => preview.new += 1,
                Plan::Update => preview.updated += 1,
                Plan::Unchanged => preview.unchanged += 1,
                Plan::KeepLocal => preview.kept_local += 1,
            }
        }
        preview.source = source.key().to_string();
        preview.vendor = source.label().to_string();
        let _ = self.cache.lock().map(|mut slot| {
            *slot = Some(Cached {
                key,
                parsed,
                file: preview.file.clone(),
                warnings: preview.warnings.clone(),
            })
        });
        Ok(preview)
    }

    /// Write the conversations the preview counted. Reports progress as it goes.
    pub fn apply(
        &self,
        store: &Store,
        path: &Path,
        emit: &dyn Fn(ImportProgress),
    ) -> Result<ImportSummary, String> {
        let (_, parsed, _, warnings) = self.load(path)?;
        let source = parsed
            .first()
            .map(|c| c.source)
            .ok_or_else(|| unsupported())?;

        let total = parsed.len();
        let mut summary = ImportSummary {
            source: source.key().to_string(),
            vendor: source.label().to_string(),
            imported: 0,
            updated: 0,
            unchanged: 0,
            kept_local: 0,
            messages: 0,
            chat_ids: Vec::new(),
            warnings,
        };

        emit(ImportProgress {
            phase: "importing".into(),
            source: summary.source.clone(),
            done: 0,
            total,
        });

        for (index, conversation) in parsed.iter().enumerate() {
            match apply_one(store, conversation)? {
                Outcome::Created(id) => {
                    summary.imported += 1;
                    summary.messages += conversation.messages.len();
                    summary.chat_ids.push(id);
                }
                Outcome::Updated(id) => {
                    summary.updated += 1;
                    summary.messages += conversation.messages.len();
                    summary.chat_ids.push(id);
                }
                Outcome::Unchanged => summary.unchanged += 1,
                Outcome::KeepLocal => summary.kept_local += 1,
            }
            // Every hundred conversations is plenty for a progress bar.
            if index % 100 == 0 || index + 1 == total {
                emit(ImportProgress {
                    phase: "importing".into(),
                    source: summary.source.clone(),
                    done: index + 1,
                    total,
                });
            }
        }

        emit(ImportProgress {
            phase: "done".into(),
            source: summary.source.clone(),
            done: total,
            total,
        });
        Ok(summary)
    }

    /// The cached scan when it still describes this file, otherwise a fresh one.
    ///
    /// The scan is moved out rather than cloned: a large export is a lot of
    /// strings, and the preview and the import are the only two readers.
    fn load(
        &self,
        path: &Path,
    ) -> Result<((String, u64, i64), Vec<Parsed>, String, Vec<String>), String> {
        let meta = fs::metadata(path).map_err(|e| format!("That file could not be read: {e}"))?;
        let stamp = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let key = (path.display().to_string(), meta.len(), stamp);

        if let Ok(mut slot) = self.cache.lock() {
            let hit = slot.as_ref().map(|cached| cached.key == key).unwrap_or(false);
            if hit {
                if let Some(cached) = slot.take() {
                    return Ok((key, cached.parsed, cached.file, cached.warnings));
                }
            }
        }

        let scan = read_export(path)?;
        Ok((key, scan.parsed, scan.file, scan.warnings))
    }
}

fn unsupported() -> String {
    "That doesn't look like a ChatGPT or Claude export. Pick the ZIP you downloaded \
     from their data-export settings."
        .to_string()
}

// ---------------------------------------------------------------- reading

struct Scan {
    parsed: Vec<Parsed>,
    file: String,
    warnings: Vec<String>,
}

/// Read a ZIP, a single JSON file, or a folder an export was unzipped into.
fn read_export(path: &Path) -> Result<Scan, String> {
    let meta = fs::metadata(path).map_err(|e| format!("That file could not be read: {e}"))?;
    let file = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "export".to_string());

    if meta.is_dir() {
        let docs = json_files_in(path)?;
        return collect(docs, file);
    }
    if path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("json"))
        .unwrap_or(false)
    {
        let bytes = fs::read(path).map_err(|e| format!("That file could not be read: {e}"))?;
        return collect(vec![(file.clone(), bytes)], file);
    }

    let handle = File::open(path).map_err(|e| format!("That file could not be opened: {e}"))?;
    let mut archive = zip::ZipArchive::new(handle)
        .map_err(|_| unsupported())?;
    let mut docs = Vec::new();
    for index in 0..archive.len() {
        let mut entry = match archive.by_index(index) {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let name = entry.name().to_string();
        if !name.to_ascii_lowercase().ends_with(".json") {
            continue;
        }
        // ChatGPT splits very large accounts across numbered files; Claude keeps
        // one. Either way we probe every JSON entry rather than trusting a name.
        if entry.size() > 512 * 1024 * 1024 {
            continue;
        }
        let mut bytes = Vec::new();
        if entry.read_to_end(&mut bytes).is_ok() {
            docs.push((name, bytes));
        }
    }
    collect(docs, file)
}

fn json_files_in(dir: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("That folder could not be read: {e}"))?;
    let mut docs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false)
        {
            if let Ok(bytes) = fs::read(&path) {
                docs.push((
                    path.file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default(),
                    bytes,
                ));
            }
        }
    }
    Ok(docs)
}

/// Merge every JSON document in an export. Unknown files (`user.json`,
/// `message_feedback.json`, project metadata) simply fail to look like a
/// conversation and are dropped.
fn collect(docs: Vec<(String, Vec<u8>)>, file: String) -> Result<Scan, String> {
    let mut parsed = Vec::new();
    let mut warnings = Vec::new();
    let mut empty = 0usize;
    let mut unreadable = Vec::new();

    for (name, bytes) in docs {
        let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        let items = match value {
            Value::Array(items) => items,
            // A single conversation object, as the private API returns it.
            object @ Value::Object(_) => vec![object],
            _ => continue,
        };
        let before = parsed.len();
        for item in items {
            let Some(source) = detect(&item) else {
                continue;
            };
            let conversation = match source {
                Source::ChatGpt => parse_chatgpt(&item),
                Source::Claude => parse_claude(&item),
            };
            match conversation {
                Some(conversation) if !conversation.messages.is_empty() => parsed.push(conversation),
                Some(_) => empty += 1,
                None => empty += 1,
            }
        }
        // `user.json`, `projects.json` and friends are not conversations and
        // are dropped silently. Only a file that names itself after
        // conversations and yields none is worth a line.
        if parsed.len() == before && name.to_ascii_lowercase().contains("conversation") {
            unreadable.push(name);
        }
    }

    if parsed.is_empty() {
        return Err(unsupported());
    }
    if empty > 0 {
        warnings.push(format!(
            "{empty} conversation{} had no messages and {} skipped.",
            if empty == 1 { "" } else { "s" },
            if empty == 1 { "was" } else { "were" }
        ));
    }
    if !unreadable.is_empty() {
        warnings.push(format!(
            "{} in the export could not be read.",
            unreadable.join(", ")
        ));
    }
    // Newest first, so an import finishes with the conversations a user is most
    // likely to want to open.
    parsed.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(Scan {
        parsed,
        file,
        warnings,
    })
}

fn detect(item: &Value) -> Option<Source> {
    if item.get("chat_messages").is_some() {
        return Some(Source::Claude);
    }
    if item.get("mapping").is_some()
        || item.get("conversation_id").is_some()
        || item.get("current_node").is_some()
    {
        return Some(Source::ChatGpt);
    }
    if item.get("messages").is_some() && item.get("create_time").is_some() {
        return Some(Source::ChatGpt);
    }
    None
}

// ---------------------------------------------------------------- ChatGPT

fn parse_chatgpt(item: &Value) -> Option<Parsed> {
    let external_id = string_at(item, &["conversation_id", "id"])?;
    let created = number_at(item, "create_time").map(secs_to_ms).unwrap_or(0);
    let updated = number_at(item, "update_time").map(secs_to_ms).unwrap_or(0);

    let mut messages = Vec::new();
    if let Some(mapping) = item.get("mapping").and_then(|v| v.as_object()) {
        for node_id in chatgpt_branch(mapping, item.get("current_node")) {
            let Some(node) = mapping.get(&node_id) else {
                continue;
            };
            let Some(message) = node.get("message").filter(|m| !m.is_null()) else {
                continue;
            };
            // Node ids are unique inside a conversation and stable across
            // exports, so they make a better fallback id than a hash of the text
            // (two identical prompts in one chat would collide).
            if let Some(parsed) = chatgpt_message(message, &node_id) {
                messages.push(parsed);
            }
        }
    } else if let Some(list) = item.get("messages").and_then(|v| v.as_array()) {
        for (index, message) in list.iter().enumerate() {
            let fallback = format!("{external_id}-{index}");
            if let Some(parsed) = chatgpt_message(message, &fallback) {
                messages.push(parsed);
            }
        }
    }

    if messages.is_empty() {
        return None;
    }
    // Exports routinely leave conversation times null; the messages still know.
    let first = messages.iter().map(|m| m.created_at).min().unwrap_or(0);
    let last = messages.iter().map(|m| m.created_at).max().unwrap_or(0);
    let created_at = first_nonzero(created, first);
    let updated_at = first_nonzero(updated, last).max(created_at);
    let title = title_for(item, &["title"], &messages);

    Some(Parsed {
        source: Source::ChatGpt,
        external_id,
        title,
        created_at,
        updated_at,
        messages,
    })
}

/// The ids on the branch the user saw, root first.
fn chatgpt_branch(mapping: &Map<String, Value>, current: Option<&Value>) -> Vec<String> {
    let leaf = current
        .and_then(|v| v.as_str())
        .filter(|id| mapping.contains_key(*id))
        .map(str::to_string)
        .or_else(|| newest_node(mapping));

    let Some(mut cursor) = leaf else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    let mut seen = HashSet::new();
    while seen.insert(cursor.clone()) {
        let Some(node) = mapping.get(&cursor) else {
            break;
        };
        ids.push(cursor.clone());
        if ids.len() > MAX_NODES {
            break;
        }
        match node.get("parent").and_then(|v| v.as_str()) {
            Some(parent) => cursor = parent.to_string(),
            None => break,
        }
    }
    ids.reverse();
    ids
}

/// No `current_node` (older exports, or a trimmed file): follow the newest
/// message, which is what the interface was showing.
fn newest_node(mapping: &Map<String, Value>) -> Option<String> {
    let mut best: Option<(f64, String)> = None;
    for (id, node) in mapping {
        let Some(message) = node.get("message").filter(|m| !m.is_null()) else {
            continue;
        };
        let at = number_at(message, "create_time").unwrap_or(0.0);
        match &best {
            Some((seen, _)) if *seen >= at => {}
            _ => best = Some((at, id.clone())),
        }
    }
    best.map(|(_, id)| id)
}

fn chatgpt_message(message: &Value, fallback_id: &str) -> Option<ParsedMessage> {
    let metadata = message.get("metadata");
    if metadata
        .and_then(|m| m.get("is_visually_hidden_from_conversation"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return None;
    }
    let role = message
        .get("author")
        .and_then(|a| a.get("role"))
        .and_then(|v| v.as_str())?;
    if role != "user" && role != "assistant" {
        return None;
    }

    let content = message.get("content")?;
    let text = chatgpt_text(content)?;
    let text = apply_citations(text, metadata);
    let text = text.trim().to_string();
    if text.is_empty() {
        return None;
    }

    let external_id = string_at(message, &["id"]).unwrap_or_else(|| fallback_id.to_string());
    let created_at = number_at(message, "create_time")
        .map(secs_to_ms)
        .unwrap_or(0);
    Some(ParsedMessage {
        external_id,
        role: role.to_string(),
        content: text,
        reasoning: None,
        created_at,
    })
}

/// ChatGPT's `content` union. `parts` is the ordinary case; tool traffic and
/// internal bookkeeping are dropped rather than rendered as prose.
fn chatgpt_text(content: &Value) -> Option<String> {
    let kind = content
        .get("content_type")
        .and_then(|v| v.as_str())
        .unwrap_or("text");
    match kind {
        "code" | "execution_output" | "thoughts" | "reasoning_recap" | "tether_quote"
        | "tether_browsing_display" | "user_editable_context" | "model_editable_context" => None,
        _ => {
            if let Some(parts) = content.get("parts").and_then(|v| v.as_array()) {
                let joined = parts_text(parts);
                if !joined.trim().is_empty() {
                    return Some(joined);
                }
            }
            content.get("text").and_then(|v| v.as_str()).map(str::to_string)
        }
    }
}

fn parts_text(parts: &[Value]) -> String {
    let mut out = String::new();
    for part in parts {
        if let Some(text) = part.as_str() {
            out.push_str(text);
        }
    }
    out
}

/// Web citations arrive as private-use-area glyphs described by
/// `metadata.content_references`. Swap in the readable link.
fn apply_citations(text: String, metadata: Option<&Value>) -> String {
    let Some(references) = metadata
        .and_then(|m| m.get("content_references"))
        .and_then(|v| v.as_array())
    else {
        return text;
    };
    let mut out = text;
    for reference in references {
        let Some(token) = reference.get("matched_text").and_then(|v| v.as_str()) else {
            continue;
        };
        // Some references point at a bare space; replacing one would eat the
        // whole message, so only tokens carrying a citation glyph qualify.
        if !token.chars().any(is_citation_glyph) {
            continue;
        }
        let Some(alt) = reference.get("alt").and_then(|v| v.as_str()) else {
            continue;
        };
        if out.contains(token) {
            out = out.replace(token, alt);
        }
    }
    out
}

fn is_citation_glyph(c: char) -> bool {
    matches!(c, '\u{E200}'..='\u{E203}')
}

// ---------------------------------------------------------------- Claude

fn parse_claude(item: &Value) -> Option<Parsed> {
    let external_id = string_at(item, &["uuid"])?;
    let messages_raw = item.get("chat_messages").and_then(|v| v.as_array())?;
    let branch = claude_branch(messages_raw);

    let mut messages = Vec::new();
    for (index, message) in branch.iter().enumerate() {
        let sender = message.get("sender").and_then(|v| v.as_str()).unwrap_or("");
        let role = match sender {
            "human" => "user",
            "assistant" => "assistant",
            _ => continue,
        };
        let text = claude_text(message);
        let text = text.trim().to_string();
        if text.is_empty() {
            continue;
        }
        let external_id = string_at(message, &["uuid"])
            .unwrap_or_else(|| format!("{}-{index}", external_id));
        messages.push(ParsedMessage {
            external_id,
            role: role.to_string(),
            content: text,
            reasoning: None,
            created_at: string_at(message, &["created_at"])
                .and_then(|s| iso_to_ms(&s))
                .unwrap_or(0),
        });
    }

    if messages.is_empty() {
        return None;
    }
    let created = string_at(item, &["created_at"])
        .and_then(|s| iso_to_ms(&s))
        .unwrap_or(0);
    let updated = string_at(item, &["updated_at"])
        .and_then(|s| iso_to_ms(&s))
        .unwrap_or(0);
    let first = messages.iter().map(|m| m.created_at).min().unwrap_or(0);
    let last = messages.iter().map(|m| m.created_at).max().unwrap_or(0);
    let created_at = first_nonzero(created, first);
    let updated_at = first_nonzero(updated, last).max(created_at);
    let title = title_for(item, &["name", "title"], &messages);

    Some(Parsed {
        source: Source::Claude,
        external_id,
        title,
        created_at,
        updated_at,
        messages,
    })
}

/// The visible branch: the newest leaf, then its parent chain back to the root.
fn claude_branch(messages: &[Value]) -> Vec<&Value> {
    if messages.is_empty() {
        return Vec::new();
    }
    let parents: HashSet<&str> = messages
        .iter()
        .filter_map(|m| m.get("parent_message_uuid").and_then(|v| v.as_str()))
        .collect();
    let leaf = messages
        .iter()
        .filter(|m| {
            !m.get("uuid")
                .and_then(|v| v.as_str())
                .map(|id| parents.contains(id))
                .unwrap_or(false)
        })
        .max_by_key(|m| m.get("created_at").and_then(|v| v.as_str()).unwrap_or(""));

    let mut chain: Vec<&Value> = Vec::new();
    let Some(mut current) = leaf else {
        return messages.iter().collect();
    };
    let mut seen = HashSet::new();
    loop {
        let uuid = current
            .get("uuid")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string();
        if !seen.insert(uuid) || chain.len() > MAX_NODES {
            break;
        }
        chain.push(current);
        let parent = current
            .get("parent_message_uuid")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if parent.is_empty() || parent == ROOT_SENTINEL {
            break;
        }
        match messages
            .iter()
            .find(|m| m.get("uuid").and_then(|v| v.as_str()) == Some(parent))
        {
            Some(next) => current = next,
            None => break,
        }
    }
    chain.reverse();
    chain
}

/// `content[]` holds typed blocks; `text` is the flattened copy. Prefer the
/// blocks and keep only the plain text ones.
fn claude_text(message: &Value) -> String {
    match message.get("content") {
        Some(Value::Array(blocks)) => {
            let mut out = String::new();
            for block in blocks {
                if block.get("type").and_then(|v| v.as_str()) == Some("text") {
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        out.push_str(text);
                    }
                }
            }
            if !out.trim().is_empty() {
                return out;
            }
            message
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or_default()
                .to_string()
        }
        Some(Value::String(text)) => text.clone(),
        _ => message
            .get("text")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    }
}

// ---------------------------------------------------------------- writing

fn plan(store: &Store, conversation: &Parsed) -> Plan {
    let Ok(existing) = store.load(&conversation.chat_id()) else {
        return Plan::Create;
    };
    // An import stamps the chat with the source's own timestamp. While that
    // stamp is still the chat's version, nobody has touched it here, so the
    // export owns the contents. A reply or a rename moves it, and the local
    // version wins from then on.
    let untouched = match existing.meta.source_updated_at {
        Some(at) => existing.meta.updated_at == at,
        // Imported by a build that did not record it: the import stamped
        // `updated_at` with the source time, so an equal stamp still means
        // untouched.
        None => existing.meta.updated_at == conversation.updated_at,
    };
    if !untouched {
        return Plan::KeepLocal;
    }
    let recorded = existing
        .meta
        .source_updated_at
        .unwrap_or(conversation.updated_at);
    if conversation.updated_at > recorded {
        return Plan::Update;
    }
    if existing.messages.len() != conversation.messages.len() {
        return Plan::Update;
    }
    Plan::Unchanged
}

fn apply_one(store: &Store, conversation: &Parsed) -> Result<Outcome, String> {
    let id = conversation.chat_id();
    match plan(store, conversation) {
        Plan::Unchanged => Ok(Outcome::Unchanged),
        Plan::KeepLocal => Ok(Outcome::KeepLocal),
        Plan::Update => {
            let mut chat = store.load(&id)?;
            // Pinning is Hook's own; the export knows nothing about it.
            let pinned = chat.meta.pinned;
            let pinned_at = chat.meta.pinned_at;
            chat.messages = messages_of(conversation);
            chat.meta.source = Some(conversation.source.key().to_string());
            chat.meta.source_id = Some(conversation.external_id.clone());
            chat.meta.source_updated_at = Some(conversation.updated_at);
            chat.meta.updated_at = conversation.updated_at;
            chat.meta.pinned = pinned;
            chat.meta.pinned_at = pinned_at;
            store.save(&mut chat)?;
            Ok(Outcome::Updated(id))
        }
        Plan::Create => {
            let mut chat = build_chat(conversation);
            store.save(&mut chat)?;
            Ok(Outcome::Created(id))
        }
    }
}

fn build_chat(conversation: &Parsed) -> Chat {
    let mut meta = ChatMeta {
        id: conversation.chat_id(),
        title: conversation.title.clone(),
        created_at: conversation.created_at,
        updated_at: conversation.updated_at,
        pinned: false,
        pinned_at: None,
        message_count: 0,
        preview: String::new(),
        source: Some(conversation.source.key().to_string()),
        source_id: Some(conversation.external_id.clone()),
        source_updated_at: Some(conversation.updated_at),
    };
    if meta.created_at <= 0 {
        meta.created_at = meta.updated_at;
    }
    Chat {
        meta,
        messages: messages_of(conversation),
    }
}

fn messages_of(conversation: &Parsed) -> Vec<Message> {
    let last = conversation.last_message_at();
    conversation
        .messages
        .iter()
        .map(|parsed| {
            let mut message = Message::new(&parsed.role, &parsed.content, "complete");
            message.id = stable_id(conversation.source.prefix(), &parsed.external_id);
            message.created_at = if parsed.created_at > 0 {
                parsed.created_at
            } else {
                last
            };
            if message.created_at <= 0 {
                message.created_at = conversation.created_at;
            }
            message.reasoning = parsed.reasoning.clone();
            message
        })
        .collect()
}

// ---------------------------------------------------------------- helpers

fn title_for(item: &Value, keys: &[&str], messages: &[ParsedMessage]) -> String {
    for key in keys {
        if let Some(title) = item.get(*key).and_then(|v| v.as_str()) {
            let title = title.trim();
            if !title.is_empty() {
                return truncate(title, MAX_TITLE);
            }
        }
    }
    // ChatGPT names a conversation after its first prompt; do the same when the
    // export leaves it blank.
    messages
        .iter()
        .find(|m| m.role == "user")
        .map(|m| truncate(&m.content.replace('\n', " "), 80))
        .unwrap_or_else(|| "Imported chat".to_string())
}

fn string_at(value: &Value, keys: &[&str]) -> Option<String> {
    for key in keys {
        if let Some(found) = value.get(*key).and_then(|v| v.as_str()) {
            if !found.is_empty() {
                return Some(found.to_string());
            }
        }
    }
    None
}

fn number_at(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(|v| match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse::<f64>().ok(),
        _ => None,
    })
}

/// Exports store seconds as floats, sometimes `null`.
fn secs_to_ms(seconds: f64) -> i64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    (seconds * 1000.0).round() as i64
}

fn first_nonzero(primary: i64, fallback: i64) -> i64 {
    if primary > 0 {
        primary
    } else {
        fallback
    }
}

/// A source id when it is already a safe file name, else a digest of it.
/// Deterministic on purpose: the same conversation always lands on the same id.
fn stable_id(prefix: &str, external: &str) -> String {
    let usable = extra_id_safe(external);
    if usable {
        return format!("{prefix}_{external}");
    }
    format!("{prefix}_{}", hash_id(external))
}

fn extra_id_safe(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 48
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn hash_id(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    let mut out = String::with_capacity(32);
    for byte in digest.iter().take(16) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

/// RFC 3339 → epoch ms. Claude dates are ISO strings; chrono is not a dependency
/// here and this is the whole of what is needed.
fn iso_to_ms(text: &str) -> Option<i64> {
    let text = text.trim();
    let bytes = text.as_bytes();
    if bytes.len() < 20 || bytes[4] != b'-' || bytes[7] != b'-' || bytes[10] != b'T' {
        return None;
    }
    let year: i64 = text.get(0..4)?.parse().ok()?;
    let month: i64 = text.get(5..7)?.parse().ok()?;
    let day: i64 = text.get(8..10)?.parse().ok()?;
    let hour: i64 = text.get(11..13)?.parse().ok()?;
    let minute: i64 = text.get(14..16)?.parse().ok()?;
    let second: i64 = text.get(17..19)?.parse().ok()?;
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) || hour > 23 || minute > 59 {
        return None;
    }

    let mut rest = &text[19..];
    let mut millis: i64 = 0;
    if let Some(fraction) = rest.strip_prefix('.') {
        let digits: String = fraction
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        let mut padded = digits.clone();
        while padded.len() < 3 {
            padded.push('0');
        }
        millis = padded.get(0..3)?.parse().ok()?;
        rest = &fraction[digits.len()..];
    }

    let offset_minutes = if rest.eq_ignore_ascii_case("z") || rest.is_empty() {
        0
    } else {
        let sign = match rest.as_bytes().first()? {
            b'+' => 1,
            b'-' => -1,
            _ => return None,
        };
        let hours: i64 = rest.get(1..3)?.parse().ok()?;
        let minutes: i64 = rest.get(4..6)?.parse().ok()?;
        sign * (hours * 60 + minutes)
    };

    let days = days_from_civil(year, month, day);
    let seconds = days * 86_400 + hour * 3_600 + minute * 60 + second - offset_minutes * 60;
    Some(seconds * 1000 + millis)
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = (month + 9) % 12;
    let day_of_year = (153 * month_prime + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn chatgpt_doc() -> Value {
        json!([{
            "conversation_id": "conv-1",
            "title": "Deploy notes",
            "create_time": 1_700_000_000.0,
            "update_time": 1_700_000_100.5,
            "current_node": "a2",
            "mapping": {
                "root": {"id": "root", "message": null, "parent": null, "children": ["u1"]},
                "u1": {"id": "u1", "parent": "root", "children": ["a1", "a2"], "message": {
                    "id": "u1-msg", "author": {"role": "user"}, "create_time": 1_700_000_000.0,
                    "content": {"content_type": "text", "parts": ["how do I deploy?"]}
                }},
                "a1": {"id": "a1", "parent": "u1", "children": [], "message": {
                    "id": "a1-msg", "author": {"role": "assistant"}, "create_time": 1_700_000_010.0,
                    "content": {"content_type": "text", "parts": ["an abandoned draft"]}
                }},
                "a2": {"id": "a2", "parent": "u1", "children": [], "message": {
                    "id": "a2-msg", "author": {"role": "assistant"}, "create_time": 1_700_000_100.5,
                    "content": {"content_type": "text", "parts": ["run ", "make deploy"]}
                }}
            }
        }])
    }

    #[test]
    fn chatgpt_flattens_to_the_branch_the_user_saw() {
        let doc = chatgpt_doc();
        let conversation = parse_chatgpt(&doc[0]).expect("parsed");
        assert_eq!(conversation.title, "Deploy notes");
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[0].role, "user");
        assert_eq!(conversation.messages[1].content, "run make deploy");
        assert_eq!(conversation.created_at, 1_700_000_000_000);
        assert_eq!(conversation.updated_at, 1_700_000_100_500);
        // The abandoned regeneration is not on the branch.
        assert!(!conversation
            .messages
            .iter()
            .any(|m| m.content.contains("abandoned")));
    }

    #[test]
    fn chatgpt_skips_hidden_system_and_tool_traffic() {
        let item = json!({
            "conversation_id": "conv-2",
            "title": "",
            "mapping": {
                "n0": {"id": "n0", "parent": null, "children": ["n1"], "message": {
                    "id": "sys", "author": {"role": "system"}, "create_time": 1.0,
                    "content": {"content_type": "text", "parts": ["You are ChatGPT"]},
                    "metadata": {"is_visually_hidden_from_conversation": true}
                }},
                "n1": {"id": "n1", "parent": "n0", "children": ["n2"], "message": {
                    "id": "u", "author": {"role": "user"}, "create_time": 2.0,
                    "content": {"content_type": "text", "parts": ["hello there"]}
                }},
                "n2": {"id": "n2", "parent": "n1", "children": [], "message": {
                    "id": "a", "author": {"role": "assistant"}, "create_time": 3.0,
                    "content": {"content_type": "multimodal_text", "parts": [
                        {"asset_pointer": "file-service://file-abc"}, "hi!"
                    ]}
                }}
            }
        });
        let conversation = parse_chatgpt(&item).expect("parsed");
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[1].content, "hi!");
        // A blank title falls back to the first prompt.
        assert_eq!(conversation.title, "hello there");
    }

    #[test]
    fn chatgpt_reads_citations_and_ignores_bare_space_references() {
        let item = json!({
            "conversation_id": "conv-3",
            "title": "Cited",
            "mapping": {
                "n1": {"id": "n1", "parent": null, "children": [], "message": {
                    "id": "a", "author": {"role": "assistant"}, "create_time": 3.0,
                    "content": {"content_type": "text", "parts": ["Rust is fast\u{E200}cite\u{E202}turn0search1\u{E201}"]},
                    "metadata": {"content_references": [
                        {"type": "grouped_webpages", "matched_text": "\u{E200}cite\u{E202}turn0search1\u{E201}",
                         "alt": "([rust-lang.org](https://rust-lang.org))"},
                        {"type": "sources_footnote", "matched_text": " ", "alt": "sources"}
                    ]}
                }}
            }
        });
        let conversation = parse_chatgpt(&item).expect("parsed");
        assert_eq!(
            conversation.messages[0].content,
            "Rust is fast([rust-lang.org](https://rust-lang.org))"
        );
    }

    #[test]
    fn chatgpt_accepts_the_flat_messages_shape() {
        let item = json!({
            "conversation_id": "conv-4",
            "title": "Flat",
            "create_time": 10.0,
            "messages": [
                {"id": "m1", "author": {"role": "user"}, "create_time": 10.0,
                 "content": {"content_type": "text", "parts": ["one"]}},
                {"id": "m2", "author": {"role": "assistant"}, "create_time": 11.0,
                 "content": {"content_type": "text", "parts": ["two"]}}
            ]
        });
        let conversation = parse_chatgpt(&item).expect("parsed");
        assert_eq!(conversation.messages.len(), 2);
    }

    fn claude_doc() -> Value {
        json!([{
            "uuid": "cc1",
            "name": "Refactor plan",
            "created_at": "2026-04-01T10:00:00.000Z",
            "updated_at": "2026-04-01T10:05:00.000Z",
            "chat_messages": [
                {"uuid": "m1", "sender": "human", "created_at": "2026-04-01T10:00:00.000Z",
                 "text": "help me refactor", "content": [{"type": "text", "text": "help me refactor"}],
                 "parent_message_uuid": ROOT_SENTINEL},
                {"uuid": "m2a", "sender": "assistant", "created_at": "2026-04-01T10:00:30.000Z",
                 "text": "old answer", "content": [{"type": "text", "text": "old answer"}],
                 "parent_message_uuid": "m1"},
                {"uuid": "m2b", "sender": "assistant", "created_at": "2026-04-01T10:05:00.000Z",
                 "text": "new answer", "content": [
                    {"type": "thinking", "text": "internal"},
                    {"type": "text", "text": "new "},
                    {"type": "tool_use", "text": ""},
                    {"type": "text", "text": "answer"}
                 ], "parent_message_uuid": "m1"}
            ]
        }])
    }

    #[test]
    fn claude_takes_the_latest_branch_and_skips_thinking() {
        let doc = claude_doc();
        let conversation = parse_claude(&doc[0]).expect("parsed");
        assert_eq!(conversation.messages.len(), 2);
        assert_eq!(conversation.messages[0].content, "help me refactor");
        assert_eq!(conversation.messages[1].content, "new answer");
        assert_eq!(conversation.created_at, 1_775_037_600_000);
        assert_eq!(conversation.updated_at, 1_775_037_900_000);
    }

    #[test]
    fn claude_falls_back_to_the_flat_text_field() {
        let item = json!({
            "uuid": "cc2",
            "name": "",
            "created_at": "2026-04-01T10:00:00Z",
            "chat_messages": [
                {"uuid": "m1", "sender": "human", "created_at": "2026-04-01T10:00:00Z",
                 "text": "just text", "content": [{"type": "thinking", "text": "..."}],
                 "parent_message_uuid": ROOT_SENTINEL}
            ]
        });
        let conversation = parse_claude(&item).expect("parsed");
        assert_eq!(conversation.messages[0].content, "just text");
        assert_eq!(conversation.title, "just text");
    }

    #[test]
    fn claude_survives_a_cyclic_parent_chain() {
        let item = json!({
            "uuid": "cc3",
            "name": "Cycle",
            "chat_messages": [
                {"uuid": "a", "sender": "human", "text": "a", "parent_message_uuid": "b"},
                {"uuid": "b", "sender": "assistant", "text": "b", "parent_message_uuid": "a"}
            ]
        });
        // Neither message is a leaf, so the walk must stop instead of spinning.
        let conversation = parse_claude(&item);
        assert!(conversation.is_none() || conversation.unwrap().messages.len() <= 2);
    }

    #[test]
    fn iso_dates_parse_with_and_without_fractions() {
        assert_eq!(iso_to_ms("2026-04-01T10:00:00Z"), Some(1_775_037_600_000));
        assert_eq!(
            iso_to_ms("2026-04-01T10:00:00.123Z"),
            Some(1_775_037_600_123)
        );
        assert_eq!(
            iso_to_ms("2026-04-01T12:00:00+02:00"),
            Some(1_775_037_600_000)
        );
        assert_eq!(iso_to_ms("not a date"), None);
    }

    #[test]
    fn ids_are_derived_from_the_source_not_random() {
        let doc = chatgpt_doc();
        let first = parse_chatgpt(&doc[0]).unwrap();
        let again = parse_chatgpt(&doc[0]).unwrap();
        assert_eq!(first.chat_id(), again.chat_id());
        assert_eq!(first.chat_id(), "cgpt_conv-1");

        let claude = claude_doc();
        let parsed = parse_claude(&claude[0]).unwrap();
        assert_eq!(parsed.chat_id(), "cld_cc1");

        // An id that cannot be a file name is hashed instead of dropped.
        assert!(stable_id("cgpt", "a/b/c").starts_with("cgpt_"));
        assert!(!stable_id("cgpt", "a/b/c").contains('/'));
    }

    #[test]
    fn documents_are_recognised_by_shape() {
        assert_eq!(detect(&chatgpt_doc()[0]), Some(Source::ChatGpt));
        assert_eq!(detect(&claude_doc()[0]), Some(Source::Claude));
        assert_eq!(detect(&json!({"note": "not a conversation"})), None);
    }

    fn temp_store() -> (Store, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("hook-import-{}", uuid::Uuid::new_v4()));
        let store = Store::new(dir.clone()).expect("store");
        (store, dir)
    }

    #[test]
    fn re_importing_creates_then_updates_then_keeps_local_edits() {
        let (store, dir) = temp_store();

        // First import: the chat does not exist yet.
        let mut conversation = parse_chatgpt(&chatgpt_doc()[0]).unwrap();
        assert!(matches!(apply_one(&store, &conversation), Ok(Outcome::Created(_))));
        let saved = store.load(&conversation.chat_id()).unwrap();
        assert_eq!(saved.meta.source.as_deref(), Some("chatgpt"));
        assert_eq!(saved.meta.source_id.as_deref(), Some("conv-1"));
        assert_eq!(saved.messages.len(), 2);
        assert_eq!(saved.meta.updated_at, conversation.updated_at);
        assert_eq!(saved.meta.title, "Deploy notes");

        // Same export again: nothing to do.
        assert!(matches!(apply_one(&store, &conversation), Ok(Outcome::Unchanged)));

        // A newer export of the same conversation updates it in place.
        conversation.updated_at += 5_000;
        conversation.messages.push(ParsedMessage {
            external_id: "u2-msg".into(),
            role: "user".into(),
            content: "thanks".into(),
            reasoning: None,
            created_at: conversation.updated_at,
        });
        assert!(matches!(apply_one(&store, &conversation), Ok(Outcome::Updated(_))));
        assert_eq!(store.load(&conversation.chat_id()).unwrap().messages.len(), 3);

        // The user replies in Hook; a later export must not overwrite that.
        let mut local = store.load(&conversation.chat_id()).unwrap();
        local.meta.updated_at = conversation.updated_at + 60_000;
        local.messages.push(Message::new("user", "a reply typed in Hook", "complete"));
        store.save(&mut local).unwrap();
        conversation.updated_at += 120_000;
        assert!(matches!(apply_one(&store, &conversation), Ok(Outcome::KeepLocal)));
        let after = store.load(&conversation.chat_id()).unwrap();
        assert_eq!(after.messages.len(), 4);
        assert_eq!(after.messages[3].content, "a reply typed in Hook");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_same_source_id_always_lands_on_the_same_chat() {
        let (store, dir) = temp_store();
        let conversation = parse_claude(&claude_doc()[0]).unwrap();
        apply_one(&store, &conversation).unwrap();
        // A second import after a restart re-parses from the file, so the ids
        // have to be derived rather than remembered in memory.
        let again = parse_claude(&claude_doc()[0]).unwrap();
        assert_eq!(conversation.chat_id(), again.chat_id());
        assert!(matches!(apply_one(&store, &again), Ok(Outcome::Unchanged)));
        assert_eq!(store.list().unwrap().len(), 1);
        let _ = fs::remove_dir_all(&dir);
    }

    fn write_zip(path: &std::path::Path, entries: &[(&str, String)]) {
        use std::io::Write;
        let file = File::create(path).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options: zip::write::FileOptions<()> =
            zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (name, body) in entries {
            writer.start_file(*name, options).unwrap();
            writer.write_all(body.as_bytes()).unwrap();
        }
        writer.finish().unwrap();
    }

    #[test]
    fn scanning_then_importing_a_zip_is_idempotent() {
        let (store, dir) = temp_store();
        let archive = dir.join("export.zip");
        write_zip(
            &archive,
            &[
                ("user.json", "{}".to_string()),
                ("conversations.json", chatgpt_doc().to_string()),
            ],
        );

        let importer = Importer::new();
        let preview = importer.scan(&store, &archive).expect("scan");
        assert_eq!(preview.source, "chatgpt");
        assert_eq!(preview.vendor, "ChatGPT");
        assert_eq!(preview.conversations, 1);
        assert_eq!(preview.new, 1);
        assert_eq!(preview.messages, 2);
        assert!(preview.warnings.is_empty());

        let events = std::cell::RefCell::new(Vec::new());
        let summary = importer
            .apply(&store, &archive, &|progress| events.borrow_mut().push(progress))
            .expect("apply");
        assert_eq!(summary.imported, 1);
        assert_eq!(summary.chat_ids, vec!["cgpt_conv-1".to_string()]);
        assert_eq!(store.list().unwrap().len(), 1);
        // Progress: a start, at least one tick and a done.
        let events = events.into_inner();
        assert!(events.len() >= 2);
        assert_eq!(events.last().unwrap().phase, "done");

        // The cached scan is reused and now reports the chat as already there.
        let again = importer.scan(&store, &archive).expect("rescan");
        assert_eq!(again.new, 0);
        assert_eq!(again.unchanged, 1);
        let summary = importer.apply(&store, &archive, &|_| {}).expect("reapply");
        assert_eq!(summary.imported, 0);
        assert_eq!(summary.unchanged, 1);
        assert_eq!(store.list().unwrap().len(), 1);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_zip_export_is_read_and_merged() {
        use std::io::Write;

        let mut buffer = Vec::new();
        {
            let cursor = std::io::Cursor::new(&mut buffer);
            let mut writer = zip::ZipWriter::new(cursor);
            let options: zip::write::FileOptions<()> =
                zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
            writer.start_file("users.json", options).unwrap();
            writer.write_all(b"[]").unwrap();
            writer.start_file("conversations-000.json", options).unwrap();
            writer
                .write_all(chatgpt_doc().to_string().as_bytes())
                .unwrap();
            writer.start_file("conversations-001.json", options).unwrap();
            writer
                .write_all(
                    json!([{
                        "conversation_id": "conv-9",
                        "title": "Second split",
                        "mapping": {
                            "n1": {"id": "n1", "parent": null, "children": [], "message": {
                                "id": "u", "author": {"role": "user"}, "create_time": 5.0,
                                "content": {"content_type": "text", "parts": ["hi"]}
                            }}
                        }
                    }])
                    .to_string()
                    .as_bytes(),
                )
                .unwrap();
            writer.finish().unwrap();
        }

        let dir = std::env::temp_dir().join(format!("hook-import-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.zip");
        fs::write(&path, &buffer).unwrap();

        let scan = read_export(&path).expect("export read");
        assert_eq!(scan.parsed.len(), 2);
        assert_eq!(scan.parsed[0].source, Source::ChatGpt);
        let _ = fs::remove_dir_all(&dir);
    }
}
