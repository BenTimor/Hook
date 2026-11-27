//! The preview panel: one HTML page from a project, served to the webview over
//! a loopback HTTP server and reloaded whenever the project changes on disk.
//!
//! A page is registered by the coding agent's `show_preview` tool; the same
//! agent writes the actual file. Keeping the server on a real origin (`http://127.
//! 0.0.1:<port>`) is what makes relative CSS, images, modules and `fetch` work
//! exactly as they do in a browser. The server only reads files inside the
//! project it was opened for, and it lives exactly as long as the preview.
//!
//! Changes are picked up by polling rather than an OS watcher: a desktop app
//! opens one preview at a time, projects are small, and polling cannot miss the
//! atomic write-and-rename dance every editor does. The scan is bounded and
//! skips the folders that never contain a page asset.

use std::collections::hash_map::DefaultHasher;
use std::collections::HashSet;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;

/// The panel speaks to the webview through one callback, created in `lib.rs`
/// with the app handle. Keeping it a plain closure means the preview module
/// itself never holds (or clones) a Tauri runtime handle.
pub type Emitter = Arc<dyn Fn(PreviewEvent) + Send + Sync>;

/// How often the shown project is scanned for changes.
const POLL: Duration = Duration::from_millis(600);
/// Sleep in slices so ending a preview does not wait for a full poll.
const POLL_SLICE: Duration = Duration::from_millis(100);
/// A preview never needs to see a whole monorepo; stop before the scan gets
/// expensive.
const MAX_WATCH_FILES: usize = 3_000;
const MAX_WATCH_DEPTH: usize = 6;

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// What the webview knows about the panel. One shape for updates and for the
/// state restored on boot.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewView {
    pub active: bool,
    pub chat_id: String,
    /// "page" (an HTML file served from a project) or one of the workspace
    /// kinds: "document", "task", "board", "roadmap", "brainstorm".
    pub kind: String,
    pub project: String,
    /// Project-relative path, always with forward slashes.
    pub file: String,
    pub title: String,
    pub url: String,
    pub version: u64,
    /// True the first time this run showed a preview: open the panel. Later
    /// updates leave the user's collapsed/expanded choice alone.
    pub open: bool,
    /// A Markdown document shown from Hook Workspace.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub document: Option<serde_json::Value>,
    /// A task with its comments.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comments: Option<serde_json::Value>,
    /// The board and its tasks, for the board view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub board: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tasks: Option<serde_json::Value>,
    /// A roadmap and its milestones, for the timeline view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub roadmap: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestones: Option<serde_json::Value>,
    /// A brainstorm and the ideas around its central word.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brainstorm: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ideas: Option<serde_json::Value>,
    /// The page file does not exist yet. The watcher loads it when it appears.
    pub waiting: bool,
    /// The run is still working and the page refreshes itself as files change.
    /// It becomes false when the run settles: the panel stays open and usable,
    /// but the user reloads it by hand from then on.
    pub live: bool,
}

/// One file the remote tunnel asked for.
#[derive(Debug, Clone)]
pub struct PreviewPage {
    pub status: u16,
    pub content_type: String,
    pub body: Vec<u8>,
}

/// Sent when the preview ends: the chat was deleted, another preview replaced
/// it, or the app is quitting. A settled coding-agent run no longer closes the
/// panel.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewClosed {
    pub active: bool,
    pub chat_id: String,
}

#[derive(Clone, Serialize)]
#[serde(untagged)]
pub enum PreviewEvent {
    Open(PreviewView),
    Closed(PreviewClosed),
}

pub struct PreviewManager {
    emit: Emitter,
    active: Mutex<Option<Active>>,
    /// Coding-agent runs whose preview has already opened. The first `show`
    /// in a run opens the panel; later ones never yank it back open.
    opened: Mutex<HashSet<String>>,
    /// Bumped on every start/stop. A watcher thread from an older preview exits
    /// instead of emitting a stale reload.
    epoch: Arc<AtomicU64>,
}

struct Active {
    chat_id: String,
    /// "page" or a workspace kind. Workspace previews have no watcher, no
    /// server and no run behind them: they are a document the chat agent put
    /// in front of the user.
    kind: String,
    document: Option<serde_json::Value>,
    task: Option<serde_json::Value>,
    comments: Option<serde_json::Value>,
    board: Option<serde_json::Value>,
    tasks: Option<serde_json::Value>,
    roadmap: Option<serde_json::Value>,
    milestones: Option<serde_json::Value>,
    brainstorm: Option<serde_json::Value>,
    ideas: Option<serde_json::Value>,
    /// The coding agent that pointed the panel at this page. The preview stops
    /// refreshing when that run settles, but stays open.
    agent_id: String,
    project: String,
    file: String,
    title: String,
    url: String,
    /// Absolute path of the shown HTML file.
    path: PathBuf,
    /// The folder the loopback server serves. The remote tunnel uses the same
    /// root, so absolute and relative asset paths behave identically.
    root: PathBuf,
    version: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    /// Set when the coding-agent run settles. The server keeps serving the
    /// page; only automatic refreshes stop.
    settled: Arc<AtomicBool>,
    server: Option<Server>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Active {
    fn view(&self, open: bool) -> PreviewView {
        PreviewView {
            active: true,
            chat_id: self.chat_id.clone(),
            kind: self.kind.clone(),
            document: self.document.clone(),
            task: self.task.clone(),
            comments: self.comments.clone(),
            board: self.board.clone(),
            tasks: self.tasks.clone(),
            roadmap: self.roadmap.clone(),
            milestones: self.milestones.clone(),
            brainstorm: self.brainstorm.clone(),
            ideas: self.ideas.clone(),
            project: self.project.clone(),
            file: self.file.clone(),
            title: self.title.clone(),
            url: self.url.clone(),
            version: self.version.load(Ordering::SeqCst),
            open,
            waiting: self.kind == "page" && !self.path.is_file(),
            live: !self.settled.load(Ordering::SeqCst),
        }
    }

    fn shutdown(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
        self.server.take();
    }
}

impl PreviewManager {
    pub fn new(emit: Emitter) -> Self {
        Self {
            emit,
            active: Mutex::new(None),
            opened: Mutex::new(HashSet::new()),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }

    /// Point the panel at `file` inside `root`. The file may not exist yet: the
    /// panel shows a waiting state and the watcher opens it when it appears.
    ///
    /// `agent_id` is this coding-agent run. The first preview of a run opens
    /// the panel; the same run later only switches pages. When the run settles
    /// the panel stays open and the watcher stops (see the ticker in `lib.rs`).
    pub fn show(
        &self,
        chat_id: &str,
        agent_id: &str,
        project: &str,
        root: &Path,
        raw_file: &str,
        raw_title: &str,
    ) -> Result<PreviewView, String> {
        // A relative path is a project page; an absolute path is a page
        // anywhere on this machine, served from its own folder. Both end up
        // with a root and a file name, so the loopback server and the remote
        // tunnel share one containment rule.
        let (root, file) = if Path::new(raw_file).is_absolute() {
            let absolute = PathBuf::from(raw_file);
            let parent = absolute
                .parent()
                .ok_or("The preview file has no folder.")?
                .to_path_buf();
            let name = absolute
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .ok_or("The preview file has no name.")?;
            let lower = name.to_ascii_lowercase();
            if !lower.ends_with(".html") && !lower.ends_with(".htm") {
                return Err("The preview file must be an .html page.".into());
            }
            (parent, name)
        } else {
            (root.to_path_buf(), normalize_file(raw_file)?)
        };
        let root = root
            .canonicalize()
            .map_err(|e| format!("Preview folder is unavailable: {e}"))?;
        let root = crate::store::strip_verbatim(root);
        let path = root.join(&file);

        // A symlink inside the project must not escape it.
        if path.exists() {
            let real = crate::store::strip_verbatim(
                path.canonicalize()
                    .map_err(|e| format!("Cannot open {file}: {e}"))?,
            );
            if !real.starts_with(&root) {
                return Err(format!("\"{file}\" is outside the project."));
            }
        }

        let title = {
            let clean = raw_title.trim();
            if clean.is_empty() {
                file.rsplit('/').next().unwrap_or(&file).to_string()
            } else {
                crate::store::truncate(clean, 80)
            }
        };

        // Replace silently: switching the page should not flash the panel shut.
        self.clear(false);
        let my_epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;

        let (port, server) = start_server(root.clone())?;
        let url = format!("http://127.0.0.1:{port}/{}", encode_path(&file));
        let version = Arc::new(AtomicU64::new(0));
        let stop = Arc::new(AtomicBool::new(false));
        let settled = Arc::new(AtomicBool::new(false));
        let thread = start_watch(
            self.emit.clone(),
            root.clone(),
            path.clone(),
            chat_id.to_string(),
            project.to_string(),
            file.clone(),
            title.clone(),
            url.clone(),
            version.clone(),
            stop.clone(),
            settled.clone(),
            self.epoch.clone(),
            my_epoch,
        )?;

        let active = Active {
            chat_id: chat_id.to_string(),
            kind: "page".to_string(),
            document: None,
            task: None,
            comments: None,
            board: None,
            tasks: None,
            roadmap: None,
            milestones: None,
            brainstorm: None,
            ideas: None,
            agent_id: agent_id.to_string(),
            project: project.to_string(),
            file,
            title,
            url,
            path,
            root,
            version,
            stop,
            settled,
            server: Some(server),
            thread: Some(thread),
        };

        // Only the first successful show in a run opens the panel.
        let open = lock(&self.opened).insert(agent_id.to_string());
        let view = active.view(open);
        *lock(&self.active) = Some(active);
        (self.emit)(PreviewEvent::Open(view.clone()));
        Ok(view)
    }

    /// Show a Hook Workspace entity in the panel. There is no run and no
    /// watcher behind it: the chat agent asked, and the panel displays it until
    /// something else replaces it.
    pub fn show_workspace(
        &self,
        chat_id: &str,
        kind: &str,
        title: &str,
        document: Option<serde_json::Value>,
        task: Option<serde_json::Value>,
        comments: Option<serde_json::Value>,
        board: Option<serde_json::Value>,
        tasks: Option<serde_json::Value>,
        roadmap: Option<serde_json::Value>,
        milestones: Option<serde_json::Value>,
        brainstorm: Option<serde_json::Value>,
        ideas: Option<serde_json::Value>,
    ) -> PreviewView {
        self.clear(false);
        let active = Active {
            chat_id: chat_id.to_string(),
            kind: kind.to_string(),
            document,
            task,
            comments,
            board,
            tasks,
            roadmap,
            milestones,
            brainstorm,
            ideas,
            // No coding-agent run owns this preview, so it never settles.
            agent_id: String::new(),
            project: "Workspace".to_string(),
            file: String::new(),
            title: title.to_string(),
            url: String::new(),
            path: PathBuf::new(),
            root: PathBuf::new(),
            version: Arc::new(AtomicU64::new(0)),
            stop: Arc::new(AtomicBool::new(false)),
            settled: Arc::new(AtomicBool::new(true)),
            server: None,
            thread: None,
        };
        let view = active.view(true);
        *lock(&self.active) = Some(active);
        (self.emit)(PreviewEvent::Open(view.clone()));
        view
    }

    /// What the panel is showing, when it is a Hook Workspace entity: the
    /// conversation it belongs to, its kind, and the entity's id. `None` for a
    /// project page, which has no entity to read again.
    pub fn workspace_target(&self) -> Option<(String, String, String)> {
        let guard = lock(&self.active);
        let active = guard.as_ref()?;
        let entity = match active.kind.as_str() {
            "document" => active.document.as_ref(),
            "task" => active.task.as_ref(),
            "board" => active.board.as_ref(),
            "roadmap" => active.roadmap.as_ref(),
            "brainstorm" => active.brainstorm.as_ref(),
            _ => None,
        }?;
        let id = entity.get("id").and_then(serde_json::Value::as_str)?;
        Some((active.chat_id.clone(), active.kind.clone(), id.to_string()))
    }

    /// The same entity, read again: an edit the agent just made has to appear in
    /// the panel showing it, instead of waiting for the reader to close and
    /// reopen the document. Unlike [`Self::show_workspace`] this never opens the
    /// panel — a reader who hid it stays in charge of it.
    #[allow(clippy::too_many_arguments)]
    pub fn refresh_workspace(
        &self,
        chat_id: &str,
        kind: &str,
        title: &str,
        document: Option<serde_json::Value>,
        task: Option<serde_json::Value>,
        comments: Option<serde_json::Value>,
        board: Option<serde_json::Value>,
        tasks: Option<serde_json::Value>,
        roadmap: Option<serde_json::Value>,
        milestones: Option<serde_json::Value>,
        brainstorm: Option<serde_json::Value>,
        ideas: Option<serde_json::Value>,
    ) {
        let mut guard = lock(&self.active);
        let Some(active) = guard.as_mut() else {
            return;
        };
        // Another conversation's panel, or another kind entirely: this edit is
        // not what the reader is looking at.
        if active.chat_id != chat_id || active.kind != kind {
            return;
        }
        active.document = document;
        active.task = task;
        active.comments = comments;
        active.board = board;
        active.tasks = tasks;
        active.roadmap = roadmap;
        active.milestones = milestones;
        active.brainstorm = brainstorm;
        active.ideas = ideas;
        if !title.is_empty() {
            active.title = title.to_string();
        }
        active.version.fetch_add(1, Ordering::SeqCst);
        let view = active.view(false);
        drop(guard);
        (self.emit)(PreviewEvent::Open(view));
    }

    /// One file from the active preview, for the remote tunnel. The path is
    /// the URL path under the preview root; `None`/empty means the page the
    /// panel is showing. This is the same containment rule as the loopback
    /// server, so a tunnel cannot read outside the folder the agent chose.
    pub fn fetch(&self, chat_id: &str, raw_path: &str) -> Result<PreviewPage, String> {
        let guard = lock(&self.active);
        let Some(active) = guard.as_ref() else {
            return Err("No preview is open.".into());
        };
        if active.kind != "page" || active.chat_id != chat_id {
            return Err("No preview is open for this conversation.".into());
        }
        let root = active
            .root
            .canonicalize()
            .map_err(|_| "The preview folder is unavailable.".to_string())?;
        let root = crate::store::strip_verbatim(root);
        let decoded = percent_decode(raw_path.trim_start_matches('/'))
            .ok_or("That preview path is not valid.")?;
        if std::path::Path::new(&decoded)
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err("That preview path is not valid.".into());
        }
        let relative = if decoded.trim().is_empty() {
            active.file.clone()
        } else {
            decoded
        };
        let candidate = root.join(&relative);
        let candidate = candidate
            .canonicalize()
            .map_err(|_| "Not found.".to_string())?;
        let candidate = crate::store::strip_verbatim(candidate);
        if !candidate.starts_with(&root) {
            return Err("Not found.".into());
        }
        let candidate = if candidate.is_dir() {
            candidate.join("index.html")
        } else {
            candidate
        };
        if !candidate.is_file() {
            return Err("Not found.".into());
        }
        let body = std::fs::read(&candidate).map_err(|_| "Could not read the page.".to_string())?;
        Ok(PreviewPage {
            status: 200,
            content_type: content_type(&candidate).to_string(),
            body,
        })
    }

    /// The panel as it stands now, or `None` when nothing is open. Restored by
    /// the webview on boot.
    pub fn snapshot(&self) -> Option<PreviewView> {
        lock(&self.active).as_ref().map(|active| active.view(true))
    }

    /// The coding-agent run settled. Keep the page open and usable, but stop
    /// following the project: no more automatic reloads. Idempotent, because
    /// the ticker keeps asking while the panel stays around.
    pub fn settle(&self) {
        let mut guard = lock(&self.active);
        let Some(active) = guard.as_mut() else {
            return;
        };
        if active.settled.swap(true, Ordering::SeqCst) {
            return;
        }
        // Invalidate a scan that is already in flight, then ask the watcher to
        // exit. Bumping only here keeps the ticker's repeated asks cheap.
        self.epoch.fetch_add(1, Ordering::SeqCst);
        active.stop.store(true, Ordering::SeqCst);
        let view = active.view(false);
        drop(guard);
        (self.emit)(PreviewEvent::Open(view));
    }

    /// End the preview unconditionally.
    pub fn stop(&self) {
        self.clear(true);
    }

    /// The coding agent whose run owns the panel, if one is open.
    pub fn agent_id(&self) -> Option<String> {
        lock(&self.active)
            .as_ref()
            .map(|active| active.agent_id.clone())
            .filter(|id| !id.is_empty())
    }

    /// End the preview only when it belongs to this chat. Used when a chat is
    /// deleted: another run's preview must survive.
    pub fn stop_chat(&self, chat_id: &str) {
        let mine = lock(&self.active)
            .as_ref()
            .map(|active| active.chat_id == chat_id)
            .unwrap_or(false);
        if mine {
            self.clear(true);
        }
    }

    fn clear(&self, announce: bool) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        let Some(mut active) = lock(&self.active).take() else {
            return;
        };
        let chat_id = active.chat_id.clone();
        active.shutdown();
        if announce {
            (self.emit)(PreviewEvent::Closed(PreviewClosed {
                active: false,
                chat_id,
            }));
        }
    }
}

/// A project-relative HTML path, normalized to forward slashes. Rejecting `..`
/// and absolute paths here means the file tool cannot point the panel anywhere
/// outside the project.
fn normalize_file(raw: &str) -> Result<String, String> {
    let text = raw.trim().replace('\\', "/");
    if text.is_empty() {
        return Err("Missing \"file\".".into());
    }
    if text.starts_with('/') || text.contains(':') {
        return Err("Use a path relative to the project, e.g. \"index.html\".".into());
    }
    let mut parts = Vec::new();
    for part in text.split('/') {
        match part {
            "" | "." => continue,
            ".." => return Err("The preview file must stay inside the project.".into()),
            _ => parts.push(part),
        }
    }
    let file = parts.join("/");
    if file.is_empty() {
        return Err("Missing \"file\".".into());
    }
    let ext = file
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.'))
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .unwrap_or_default();
    if ext != "html" && ext != "htm" {
        return Err("The preview file must be an .html page.".into());
    }
    Ok(file)
}

fn encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for byte in path.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(input: &str) -> Option<String> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" | "cjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Files whose changes should refresh the page. Anything else (logs, build
/// junk, editor temp files) is ignored on purpose.
fn is_relevant(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "html"
            | "htm"
            | "css"
            | "js"
            | "mjs"
            | "cjs"
            | "jsx"
            | "ts"
            | "tsx"
            | "json"
            | "svg"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "avif"
            | "ico"
            | "woff"
            | "woff2"
            | "ttf"
            | "otf"
            | "wasm"
            | "txt"
            | "md"
            | "vue"
            | "svelte"
            | "astro"
    )
}

/// Heavy folders that never change what the page renders. The scan does not
/// descend into them.
fn is_ignored(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some("node_modules")
            | Some(".git")
            | Some(".hg")
            | Some(".svn")
            | Some("__pycache__")
            | Some(".venv")
            | Some(".cache")
            | Some("target")
    )
}

/// A cheap, stable fingerprint of every web asset in the project: path, size
/// and modification time. Sorted so directory listing order cannot fake a
/// change.
fn fingerprint(root: &Path) -> u64 {
    let mut stamps = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];

    'walk: while let Some((dir, depth)) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            if stamps.len() >= MAX_WATCH_FILES {
                break 'walk;
            }
            let path = entry.path();
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if depth < MAX_WATCH_DEPTH && !is_ignored(&path) {
                    stack.push((path, depth + 1));
                }
            } else if is_relevant(&path) {
                let Ok(meta) = entry.metadata() else {
                    continue;
                };
                let mut hasher = DefaultHasher::new();
                path.hash(&mut hasher);
                meta.len().hash(&mut hasher);
                if let Ok(modified) = meta.modified() {
                    if let Ok(since) = modified.duration_since(std::time::UNIX_EPOCH) {
                        since.as_nanos().hash(&mut hasher);
                    }
                }
                stamps.push(hasher.finish());
            }
        }
    }

    stamps.sort_unstable();
    let mut hasher = DefaultHasher::new();
    stamps.len().hash(&mut hasher);
    stamps.hash(&mut hasher);
    hasher.finish()
}

struct Server(tokio::task::JoinHandle<()>);

impl Drop for Server {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Bind a loopback server for `root` and return its port. The listener is
/// created on the tokio runtime, so the socket closes when the task is aborted.
fn start_server(root: PathBuf) -> Result<(u16, Server), String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("Could not start the preview server: {e}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not start the preview server: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("Could not start the preview server: {e}"))?
        .port();
    let root = root
        .canonicalize()
        .map_err(|e| format!("Project folder is unavailable: {e}"))?;
    let root = crate::store::strip_verbatim(root);

    let handle = crate::rt::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("hook: preview server failed: {error}");
                return;
            }
        };
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                continue;
            };
            let root = root.clone();
            crate::rt::spawn(async move {
                if let Err(error) = serve(stream, &root).await {
                    if error.kind() != std::io::ErrorKind::BrokenPipe {
                        eprintln!("hook: preview request failed: {error}");
                    }
                }
            });
        }
    });
    Ok((port, Server(handle)))
}

async fn serve(mut stream: tokio::net::TcpStream, root: &Path) -> std::io::Result<()> {
    use tokio::io::AsyncReadExt;

    let mut buf = [0u8; 8192];
    let mut len = 0usize;
    while len < buf.len() {
        let read = stream.read(&mut buf[len..]).await?;
        if read == 0 {
            break;
        }
        len += read;
        if buf[..len].windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    if len == 0 {
        return Ok(());
    }

    let head = String::from_utf8_lossy(&buf[..len]);
    let mut parts = head.lines().next().unwrap_or("").split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/");

    if method == "OPTIONS" {
        return respond(&mut stream, 204, "text/plain; charset=utf-8", b"", false).await;
    }
    if method != "GET" && method != "HEAD" {
        return respond(
            &mut stream,
            405,
            "text/plain; charset=utf-8",
            b"Method not allowed",
            method == "HEAD",
        )
        .await;
    }

    let path = target.split(['?', '#']).next().unwrap_or("/");
    let Some(decoded) = percent_decode(path.trim_start_matches('/')) else {
        return respond(&mut stream, 400, "text/plain; charset=utf-8", b"Bad request", false).await;
    };
    if decoded
        .replace('\\', "/")
        .split('/')
        .any(|part| part == "..")
    {
        return respond(&mut stream, 403, "text/plain; charset=utf-8", b"Forbidden", false).await;
    }

    let candidate = if decoded.is_empty() {
        root.to_path_buf()
    } else {
        root.join(&decoded)
    };
    let Ok(candidate) = candidate.canonicalize() else {
        return respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not found", false).await;
    };
    let candidate = crate::store::strip_verbatim(candidate);
    if !candidate.starts_with(root) {
        return respond(&mut stream, 403, "text/plain; charset=utf-8", b"Forbidden", false).await;
    }
    let candidate = if candidate.is_dir() {
        candidate.join("index.html")
    } else {
        candidate
    };
    let Ok(file) = candidate.canonicalize() else {
        return respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not found", false).await;
    };
    let file = crate::store::strip_verbatim(file);
    if !file.starts_with(root) || !file.is_file() {
        return respond(&mut stream, 404, "text/plain; charset=utf-8", b"Not found", false).await;
    }
    let body = tokio::fs::read(&file).await?;
    respond(
        &mut stream,
        200,
        content_type(&file),
        &body,
        method == "HEAD",
    )
    .await
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {content_type}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store, max-age=0\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n\
         Access-Control-Allow-Headers: *\r\n\
         Cross-Origin-Resource-Policy: cross-origin\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    if !head_only && !body.is_empty() {
        stream.write_all(body).await?;
    }
    stream.flush().await?;
    let _ = stream.shutdown().await;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn start_watch(
    emit: Emitter,
    root: PathBuf,
    path: PathBuf,
    chat_id: String,
    project: String,
    file: String,
    title: String,
    url: String,
    version: Arc<AtomicU64>,
    stop: Arc<AtomicBool>,
    settled: Arc<AtomicBool>,
    epoch: Arc<AtomicU64>,
    my_epoch: u64,
) -> Result<std::thread::JoinHandle<()>, String> {
    std::thread::Builder::new()
        .name("hook-preview-watch".into())
        .spawn(move || {
            // The first poll always reports once: the page may have been
            // written between `show` and this thread's first scan, and the
            // waiting panel must learn that it exists.
            let mut last = 0;
            while !stop.load(Ordering::SeqCst) {
                for _ in 0..(POLL.as_millis() / POLL_SLICE.as_millis()).max(1) {
                    if stop.load(Ordering::SeqCst) {
                        return;
                    }
                    std::thread::sleep(POLL_SLICE);
                }
                let current = fingerprint(&root);
                if current == last {
                    continue;
                }
                last = current;
                if epoch.load(Ordering::SeqCst) != my_epoch {
                    return;
                }
                version.fetch_add(1, Ordering::SeqCst);
                emit(PreviewEvent::Open(PreviewView {
                    active: true,
                    chat_id: chat_id.clone(),
                    kind: "page".to_string(),
                    document: None,
                    task: None,
                    comments: None,
                    board: None,
                    tasks: None,
                    roadmap: None,
                    milestones: None,
                    brainstorm: None,
                    ideas: None,
                    project: project.clone(),
                    file: file.clone(),
                    title: title.clone(),
                    url: url.clone(),
                    version: version.load(Ordering::SeqCst),
                    open: false,
                    waiting: !path.is_file(),
                    live: !settled.load(Ordering::SeqCst),
                }));
            }
        })
        .map_err(|e| format!("Could not watch the project: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_edit_reads_the_panel_again_without_opening_it() {
        let events: Arc<Mutex<Vec<PreviewView>>> = Arc::new(Mutex::new(Vec::new()));
        let collected = events.clone();
        let manager = PreviewManager::new(Arc::new(move |event| {
            if let PreviewEvent::Open(view) = event {
                lock(&collected).push(view);
            }
        }));

        manager.show_workspace(
            "c1",
            "document",
            "Release checklist",
            Some(serde_json::json!({ "id": "doc_1", "markdown": "old" })),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );
        assert_eq!(
            manager.workspace_target(),
            Some(("c1".to_string(), "document".to_string(), "doc_1".to_string()))
        );

        manager.refresh_workspace(
            "c1",
            "document",
            "Release checklist",
            Some(serde_json::json!({ "id": "doc_1", "markdown": "new" })),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );

        let seen = lock(&events);
        assert_eq!(seen.len(), 2);
        assert!(seen[0].open, "the first show is what opens the panel");
        assert!(!seen[1].open, "a refresh never takes the panel back");
        assert_eq!(seen[1].document.as_ref().unwrap()["markdown"], "new");
        drop(seen);

        // Another conversation's panel, or another kind, is left alone.
        manager.refresh_workspace(
            "c2", "document", "x", None, None, None, None, None, None, None, None, None,
        );
        manager.refresh_workspace(
            "c1", "board", "x", None, None, None, None, None, None, None, None, None,
        );
        assert_eq!(lock(&events).len(), 2);
    }

    #[test]
    fn accepts_normal_relative_html_paths() {
        assert_eq!(normalize_file("index.html").unwrap(), "index.html");
        assert_eq!(normalize_file("./dist/index.html").unwrap(), "dist/index.html");
        assert_eq!(normalize_file("a\\b\\page.HTM").unwrap(), "a/b/page.HTM");
        assert_eq!(normalize_file(" reports/summary.html ").unwrap(), "reports/summary.html");
    }

    #[test]
    fn refuses_to_leave_the_project_or_load_non_html() {
        assert!(normalize_file("../evil.html").is_err());
        assert!(normalize_file("a/../../evil.html").is_err());
        assert!(normalize_file("C:/Windows/evil.html").is_err());
        assert!(normalize_file("/etc/passwd").is_err());
        assert!(normalize_file("app.tsx").is_err());
        assert!(normalize_file("").is_err());
    }

    #[test]
    fn paths_are_encoded_for_the_url() {
        assert_eq!(encode_path("dist/index.html"), "dist/index.html");
        assert_eq!(encode_path("my page/ü.html"), "my%20page/%C3%BC.html");
    }

    #[test]
    fn percent_decoding_is_strict() {
        assert_eq!(percent_decode("my%20page").as_deref(), Some("my page"));
        assert_eq!(percent_decode("a+b").as_deref(), Some("a+b"));
        assert!(percent_decode("%zz").is_none());
        assert!(percent_decode("%2").is_none());
    }

    #[test]
    fn content_types_cover_a_web_page() {
        assert_eq!(content_type(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(content_type(Path::new("a.mjs")), "text/javascript; charset=utf-8");
        assert_eq!(content_type(Path::new("a.css")), "text/css; charset=utf-8");
        assert_eq!(content_type(Path::new("a.svg")), "image/svg+xml");
        assert_eq!(content_type(Path::new("a.unknown")), "application/octet-stream");
    }

    #[test]
    fn only_web_assets_matter() {
        assert!(is_relevant(Path::new("index.html")));
        assert!(is_relevant(Path::new("src/App.tsx")));
        assert!(is_relevant(Path::new("styles/site.css")));
        assert!(!is_relevant(Path::new("notes.log")));
        assert!(!is_relevant(Path::new("package-lock.json.bak")));
    }

    #[test]
    fn heavy_folders_are_ignored() {
        assert!(is_ignored(Path::new("C:/site/node_modules")));
        assert!(is_ignored(Path::new("C:/site/.git")));
        assert!(is_ignored(Path::new("C:/site/target")));
        assert!(!is_ignored(Path::new("C:/site/src")));
    }

    #[test]
    fn events_serialize_for_the_webview() {
        // The frontend reads camelCase and treats a closed panel as a tiny
        // payload with only `active` and `chatId`.
        let open = PreviewEvent::Open(PreviewView {
            active: true,
            chat_id: "chat-1".into(),
            kind: "page".into(),
            document: None,
            task: None,
            comments: None,
            board: None,
            tasks: None,
            roadmap: None,
            milestones: None,
            brainstorm: None,
            ideas: None,
            project: "demo".into(),
            file: "dist/index.html".into(),
            title: "Demo".into(),
            url: "http://127.0.0.1:1234/dist/index.html".into(),
            version: 3,
            open: true,
            waiting: false,
            live: true,
        });
        let value = serde_json::to_value(open).unwrap();
        assert_eq!(value["active"], true);
        assert_eq!(value["chatId"], "chat-1");
        assert_eq!(value["version"], 3);
        assert_eq!(value["waiting"], false);
        assert_eq!(value["live"], true);

        let closed = PreviewEvent::Closed(PreviewClosed {
            active: false,
            chat_id: "chat-1".into(),
        });
        let value = serde_json::to_value(closed).unwrap();
        assert_eq!(value["active"], false);
        assert_eq!(value["chatId"], "chat-1");
        assert!(value.get("url").is_none());
    }

    #[test]
    fn an_external_html_page_is_served_from_its_own_folder() {
        let dir = std::env::temp_dir().join(format!("hook-preview-root-{}", uuid::Uuid::new_v4()));
        let outside = std::env::temp_dir().join(format!("hook-preview-out-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        let page = outside.join("report.html");
        std::fs::write(&page, "<h1>outside</h1>").unwrap();

        let manager = PreviewManager::new(Arc::new(|_event: PreviewEvent| {}));
        let view = manager
            .show(
                "chat-1",
                "agent-1",
                "demo",
                &dir,
                page.to_str().unwrap(),
                "Report",
            )
            .unwrap();
        assert_eq!(view.file, "report.html");
        let fetched = manager.fetch("chat-1", "/report.html").unwrap();
        assert!(String::from_utf8_lossy(&fetched.body).contains("outside"));
        assert!(manager.fetch("chat-1", "/../secret").is_err());
        manager.stop();
        let _ = std::fs::remove_dir_all(&outside);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_preview_serves_the_page_and_announces_changes() {
        use std::io::{Read, Write};

        let dir = std::env::temp_dir().join(format!("hook-preview-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>one</h1>").unwrap();

        let events: Arc<Mutex<Vec<serde_json::Value>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = events.clone();
        let manager = PreviewManager::new(Arc::new(move |event: PreviewEvent| {
            sink.lock()
                .unwrap()
                .push(serde_json::to_value(event).unwrap());
        }));

        let view = manager.show("chat-1", "agent-1", "demo", &dir, "index.html", "Demo page").unwrap();
        assert!(!view.waiting);
        assert!(view.open, "the first show in a run opens the panel");
        assert_eq!(view.version, 0);

        // The page is really served, with the right type.
        let rest = view.url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, path) = rest.split_once('/').unwrap();
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        write!(
            stream,
            "GET /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("200 OK"), "{response}");
        assert!(response.contains("Content-Type: text/html"), "{response}");
        assert!(response.contains("<h1>one</h1>"), "{response}");

        // The remote tunnel reads the same file through the same containment
        // rule: the active chat only, and never a path outside the root.
        let fetched = manager.fetch("chat-1", "/index.html").unwrap();
        assert_eq!(fetched.status, 200);
        assert_eq!(fetched.content_type, "text/html; charset=utf-8");
        assert!(String::from_utf8_lossy(&fetched.body).contains("one"));
        assert!(manager.fetch("chat-2", "/index.html").is_err());
        assert!(manager.fetch("chat-1", "/../secret").is_err());

        // A file write bumps the version, which is what makes the frame reload.
        std::fs::write(dir.join("index.html"), "<h1>two</h1>").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let bumped = events
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|event| event["active"] == true)
            .cloned()
            .unwrap();
        assert!(bumped["version"].as_u64().unwrap() >= 1, "{bumped}");

        // A later show in the same run must not yank the panel back open
        // if the user collapsed it.
        let again = manager.show("chat-1", "agent-1", "demo", &dir, "index.html", "Demo again").unwrap();
        assert!(!again.open, "only the first show in a run auto-opens");

        // A page that does not exist yet waits for the agent to write it.
        let waiting = manager.show("chat-2", "agent-2", "demo", &dir, "later.html", "Later").unwrap();
        assert!(waiting.waiting);
        assert!(waiting.open);
        std::fs::write(dir.join("later.html"), "<h1>later</h1>").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        let snapshot = manager.snapshot().unwrap();
        assert!(!snapshot.waiting);
        assert!(snapshot.version >= 1);
        assert!(snapshot.live);

        // When the coding-agent run settles the panel stays available, but the
        // page stops refreshing itself. The server must keep serving it.
        manager.settle();
        let settled = events.lock().unwrap().last().cloned().unwrap();
        assert_eq!(settled["active"], true);
        assert_eq!(settled["live"], false);
        let frozen = manager.snapshot().unwrap();
        assert!(!frozen.live);

        std::fs::write(dir.join("later.html"), "<h1>changed after settle</h1>").unwrap();
        std::thread::sleep(Duration::from_millis(1500));
        assert_eq!(manager.snapshot().unwrap().version, frozen.version);

        let rest = frozen.url.strip_prefix("http://127.0.0.1:").unwrap();
        let (port, path) = rest.split_once('/').unwrap();
        let mut stream =
            std::net::TcpStream::connect(("127.0.0.1", port.parse::<u16>().unwrap())).unwrap();
        stream.set_read_timeout(Some(Duration::from_secs(3))).unwrap();
        write!(
            stream,
            "GET /{path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        assert!(response.contains("200 OK"), "{response}");
        assert!(response.contains("changed after settle"), "{response}");

        // Ending the session stops the watch and announces the close.
        manager.stop();
        let last = events.lock().unwrap().last().cloned().unwrap();
        assert_eq!(last["active"], false);
        assert_eq!(last["chatId"], "chat-2");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_fingerprint_follows_file_changes() {
        let dir = std::env::temp_dir().join(format!("hook-preview-{}", uuid::Uuid::new_v4()));
        let nested = dir.join("assets");
        std::fs::create_dir_all(&nested).unwrap();
        std::fs::write(dir.join("index.html"), "<h1>one</h1>").unwrap();
        std::fs::write(nested.join("app.css"), "body { color: red }").unwrap();
        let first = fingerprint(&dir);

        // Listing order must not matter.
        assert_eq!(first, fingerprint(&dir));

        std::fs::write(nested.join("app.css"), "body { color: blue !important }").unwrap();
        let second = fingerprint(&dir);
        assert_ne!(first, second);

        // Files that cannot affect the page do not disturb it.
        std::fs::write(dir.join("debug.log"), "noise").unwrap();
        assert_eq!(second, fingerprint(&dir));

        std::fs::remove_dir_all(&dir).ok();
    }
}
