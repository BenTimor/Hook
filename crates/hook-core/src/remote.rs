//! What to do with a request that arrives over the relay.
//!
//! The transport (`relay.rs`) only routes frames. This is where a controller's
//! command becomes a local `AgentManager` action on the machine that hosts the
//! run, and where the answer is shaped for the caller.
//!
//! A controller never executes an agent itself. A "this computer" command from
//! Hook Workspace or HookCode is still an RPC: the relay routes it to the Hook
//! host on that machine, which is the one process that owns the engine.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};

use crate::state::AppState;
use crate::relay::RpcFailure;
use crate::store::Chat;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartParams {
    chat_id: String,
    #[serde(default)]
    project: String,
    #[serde(default)]
    folder: Option<String>,
    task: String,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    resume_session: Option<String>,
    #[serde(default)]
    plan: Vec<String>,
    /// The caller's copy of the conversation. It is merged by message id before
    /// the run starts, so the host's chat agent can answer a note even when the
    /// controller's last message has not reached sync yet.
    #[serde(default)]
    chat: Option<Chat>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentParams {
    agent_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default)]
    chat_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SteerParams {
    agent_id: String,
    text: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AnswerParams {
    agent_id: String,
    answer: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChatParams {
    chat_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionsParams {
    project: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectCreateParams {
    name: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodingCreateParams {
    #[serde(default)]
    project: String,
    /// A full path, when the controller picked a folder instead of a project.
    #[serde(default)]
    folder: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowseParams {
    /// Empty lists the places to start from: home, projects, and the drives.
    #[serde(default)]
    path: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PinParams {
    /// A full path this machine handed out in a listing.
    path: String,
    /// True to star it, false to remove the star.
    pinned: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodingSendParams {
    chat_id: String,
    text: String,
    #[serde(default)]
    message_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodingAnswerParams {
    chat_id: String,
    answer: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodingCompactParams {
    chat_id: String,
    #[serde(default)]
    instructions: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodingRenameParams {
    chat_id: String,
    title: String,
}

fn fail(code: &str, message: impl Into<String>) -> RpcFailure {
    RpcFailure {
        code: code.to_string(),
        message: message.into(),
    }
}

fn decode<T: for<'de> Deserialize<'de>>(params: Value) -> Result<T, RpcFailure> {
    serde_json::from_value(params).map_err(|error| fail("bad_params", error.to_string()))
}

pub async fn handle(
    state: &Arc<AppState>,
    _from: &str,
    method: &str,
    params: Value,
) -> Result<Value, RpcFailure> {
    match method {
        "agent.start" => start(state, decode(params)?),
        "agent.status" => status(state, decode(params)?),
        "agent.list" => list(state, decode(params)?),
        "agent.steer" => steer(state, decode(params)?),
        "agent.answer" => answer(state, decode(params)?),
        "agent.stop" => stop(state, decode(params)?),
        "agent.stopChat" => stop_chat(state, decode(params)?),
        "projects.list" => projects(state),
        "projects.create" => projects_create(state, decode(params)?),
        "folders.browse" => folders_browse(state, decode(params)?),
        "folders.pin" => folders_pin(state, decode(params)?),
        "sessions.list" => sessions(state, decode(params)?),
        "coding.create" => coding_create(state, decode(params)?),
        "coding.fetch" => coding_fetch(state, decode(params)?),
        "coding.send" => coding_send(state, decode(params)?),
        "coding.stop" => coding_stop(state, decode(params)?),
        "coding.compact" => coding_compact(state, decode(params)?),
        "coding.answer" => coding_answer(state, decode(params)?),
        "coding.rename" => coding_rename(state, decode(params)?),
        "coding.delete" => coding_delete(state, decode(params)?),
        // A browser is a thing this machine has, so these run here and nowhere
        // else: the caller is a chat on another device (or another product on
        // this one) asking what the tabs hold, or doing something to a page.
        // The answer is a slice or one command's result, never the whole page —
        // the relay carries the part that was asked for.
        "browser.tabs" => browser(state, crate::browser::Op::Tabs, &params).await,
        "browser.read" => browser(state, crate::browser::Op::Read, &params).await,
        "browser.find" => browser(state, crate::browser::Op::Find, &params).await,
        // A script, and one raw DevTools command. Both are answered by the
        // browser that owns the tab; the caller only sees what it returned.
        "browser.eval" => browser(state, crate::browser::Op::Eval, &params).await,
        "browser.cdp" => browser(state, crate::browser::Op::Cdp, &params).await,
        // The strip itself: a new tab, one closed, one selected, one sent
        // somewhere. They are answered by the browser that draws the strip.
        "browser.open" => browser(state, crate::browser::Op::OpenTab, &params).await,
        "browser.close" => browser(state, crate::browser::Op::CloseTab, &params).await,
        "browser.focus" => browser(state, crate::browser::Op::FocusTab, &params).await,
        "browser.navigate" => browser(state, crate::browser::Op::Navigate, &params).await,
        _ => Err(fail(
            "unknown_method",
            format!("Hook does not handle {method}."),
        )),
    }
}

/// The browser methods, answered from this machine's queue. Params are the
/// tool's own: `tab`, `offset`, `limit`, `query`, `regex`, `code`, `method`,
/// `params`, `timeout_ms`.
async fn browser(
    state: &Arc<AppState>,
    op: crate::browser::Op,
    params: &Value,
) -> Result<Value, RpcFailure> {
    crate::browser::perform(state, op, params)
        .await
        .map_err(|message| fail("browser_unavailable", message))
}

fn start(state: &Arc<AppState>, params: StartParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    if chat_id.is_empty() {
        return Err(fail("bad_params", "A start needs a chat id."));
    }
    if let Some(chat) = params.chat {
        if chat.meta.id != chat_id {
            return Err(fail(
                "bad_params",
                "The chat snapshot names a different conversation.",
            ));
        }
        if chat.meta.is_local_only() {
            return Err(fail(
                "direct_on_machine",
                "A direct coding chat is created on the machine that runs it.",
            ));
        }
        merge_chat(state, chat).map_err(|error| fail("chat_not_saved", error))?;
    }

    let task = params.task.trim();
    if task.is_empty() {
        return Err(fail("bad_params", "The coding agent needs a task."));
    }
    let plan: Vec<String> = params
        .plan
        .into_iter()
        .map(|step| step.trim().to_string())
        .filter(|step| !step.is_empty())
        .take(crate::agent::MAX_PLAN_STEPS)
        .collect();

    let info = match params.folder.as_deref().map(str::trim).filter(|p| !p.is_empty()) {
        Some(folder) => state.agents.start_direct(
            chat_id,
            folder,
            task,
            &[],
            params.title.as_deref(),
            params.resume_session.as_deref(),
        ),
        None => {
            let project = params.project.trim();
            if project.is_empty() {
                return Err(fail(
                    "bad_params",
                    "Name a project, or a folder on this machine.",
                ));
            }
            state.agents.start(
                chat_id,
                project,
                task,
                params.title.as_deref(),
                params.resume_session.as_deref(),
                &plan,
            )
        }
    }
    .map_err(|error| {
        let code = if error.contains("slots are busy") {
            "busy"
        } else if error.contains("paid plan") {
            "remote_not_included"
        } else {
            "start_failed"
        };
        fail(code, error)
    })?;

    mark_remote(state, chat_id);
    publish_overview(state, chat_id);
    serde_json::to_value(info).map_err(|error| fail("serialize", error.to_string()))
}

fn status(state: &Arc<AppState>, params: AgentParams) -> Result<Value, RpcFailure> {
    let info = state
        .agents
        .get(params.agent_id.trim())
        .ok_or_else(|| fail("unknown_agent", "No such coding agent on this machine."))?;
    serde_json::to_value(info).map_err(|error| fail("serialize", error.to_string()))
}

fn list(state: &Arc<AppState>, params: ListParams) -> Result<Value, RpcFailure> {
    let agents: Vec<Value> = state
        .agents
        .list()
        .into_iter()
        .filter(|agent| {
            params
                .chat_id
                .as_deref()
                .map(|chat| agent.chat_id == chat)
                .unwrap_or(true)
        })
        .filter_map(|agent| serde_json::to_value(agent).ok())
        .collect();
    Ok(json!({ "agents": agents }))
}

fn steer(state: &Arc<AppState>, params: SteerParams) -> Result<Value, RpcFailure> {
    let info = state
        .agents
        .steer(params.agent_id.trim(), &params.text, &[])
        .map_err(|error| fail("steer_failed", error))?;
    publish_overview(state, &info.chat_id);
    serde_json::to_value(info).map_err(|error| fail("serialize", error.to_string()))
}

fn answer(state: &Arc<AppState>, params: AnswerParams) -> Result<Value, RpcFailure> {
    let info = state
        .agents
        .answer(params.agent_id.trim(), &params.answer)
        .map_err(|error| fail("answer_failed", error))?;
    publish_overview(state, &info.chat_id);
    serde_json::to_value(info).map_err(|error| fail("serialize", error.to_string()))
}

fn stop(state: &Arc<AppState>, params: AgentParams) -> Result<Value, RpcFailure> {
    let info = state
        .agents
        .stop(params.agent_id.trim())
        .map_err(|error| fail("stop_failed", error))?;
    publish_overview(state, &info.chat_id);
    serde_json::to_value(info).map_err(|error| fail("serialize", error.to_string()))
}

fn stop_chat(state: &Arc<AppState>, params: ChatParams) -> Result<Value, RpcFailure> {
    let stopped = state.agents.stop_chat(params.chat_id.trim());
    publish_overview(state, params.chat_id.trim());
    Ok(json!({ "stopped": stopped }))
}

fn projects(state: &Arc<AppState>) -> Result<Value, RpcFailure> {
    let projects = state
        .projects
        .list(&state.settings.projects_dir())
        .map_err(|error| fail("projects_failed", error))?;
    let items: Vec<Value> = projects
        .iter()
        .map(|project| {
            json!({
                "project": project.name,
                "description": project.description,
                "git": project.is_git,
            })
        })
        .collect();
    Ok(json!({ "projects": items }))
}

fn projects_create(
    state: &Arc<AppState>,
    params: ProjectCreateParams,
) -> Result<Value, RpcFailure> {
    let project = state
        .projects
        .create(&state.settings.projects_dir(), &params.name, &params.description)
        .map_err(|error| fail("project_create_failed", error))?;
    state.sync.wake();
    Ok(json!({
        "project": project.name,
        "description": project.description,
        "git": project.is_git,
    }))
}

fn sessions(state: &Arc<AppState>, params: SessionsParams) -> Result<Value, RpcFailure> {
    let project = params.project.trim();
    if project.is_empty() {
        return Err(fail("bad_params", "Name a project."));
    }
    let path = project_folder(state, project)?;
    let sessions: Vec<Value> = state
        .agents
        .sessions(&path.to_string_lossy())
        .into_iter()
        .map(|session| {
            json!({
                "session_id": session.id,
                "title": session.title,
                "preview": session.preview,
            })
        })
        .collect();
    Ok(json!({ "project": project, "sessions": sessions }))
}

// ── direct coding chats ────────────────────────────────────────────────
//
// A direct chat is created on the host and never leaves it. The controller
// learns only that it exists (the stub in sync) and asks this machine for the
// transcript over the relay. These handlers are the host half of that.

/// Resolve a project a controller named. A controller may only pick a project
/// inside this machine's projects folder; it may not send an absolute path.
fn project_folder(state: &Arc<AppState>, reference: &str) -> Result<PathBuf, RpcFailure> {
    if reference.is_empty()
        || Path::new(reference).is_absolute()
        || reference.contains('/')
        || reference.contains('\\')
        || reference.contains(':')
        || reference == ".."
    {
        return Err(fail(
            "bad_params",
            "Name a project, not a path on this machine.",
        ));
    }
    let root = state
        .settings
        .projects_dir()
        .canonicalize()
        .map_err(|error| fail("projects_failed", error.to_string()))?;
    let path = state
        .projects
        .resolve(&root, reference)
        .map_err(|error| fail("unknown_project", error))?;
    let canonical = path
        .canonicalize()
        .map_err(|error| fail("unknown_project", error.to_string()))?;
    if !canonical.starts_with(&root) || !canonical.is_dir() {
        return Err(fail(
            "unknown_project",
            "That project is not inside this machine's projects folder.",
        ));
    }
    Ok(canonical)
}

// ── folders ────────────────────────────────────────────────────────────
//
// A controller may start a direct chat in a folder that is not one of the
// account's projects — the same freedom the local picker has. It cannot guess
// a path from another machine, so it walks this one level at a time. The
// answer is directory names and paths only: never a file's contents.

/// How many folders one level returns before it stops and says so.
const MAX_FOLDERS: usize = 400;

/// A full path on this machine. A bare name is refused: it would mean a
/// different folder on every device the account signs in on.
fn folder_path(raw: &str) -> Result<PathBuf, RpcFailure> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err(fail("bad_params", "Name a folder on this machine."));
    }
    if raw.len() > 4096 {
        return Err(fail("bad_params", "That path is too long."));
    }
    if !Path::new(raw).is_absolute() {
        return Err(fail("bad_params", "Send the folder's full path."));
    }
    let path = PathBuf::from(raw).canonicalize().map_err(|_| {
        fail(
            "unknown_folder",
            format!("\"{raw}\" is not a folder on this machine."),
        )
    })?;
    if !path.is_dir() {
        return Err(fail(
            "unknown_folder",
            format!("\"{raw}\" is not a folder on this machine."),
        ));
    }
    Ok(PathBuf::from(crate::store::strip_verbatim(path)))
}

fn folders_browse(state: &Arc<AppState>, params: BrowseParams) -> Result<Value, RpcFailure> {
    let starred = state.settings.pinned_folders();
    let pinned: HashSet<String> = starred.iter().cloned().collect();
    match params
        .path
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
    {
        Some(path) => folder_listing(path, &pinned),
        None => Ok(json!({
            "path": null,
            "parent": null,
            "entries": starting_points(
                &starred,
                home_dir(),
                state.settings.projects_dir(),
            ),
            "truncated": false,
        })),
    }
}

/// Star or unstar a folder on this machine. A star is a shortcut in the
/// controller's picker, so the answer is the machine's whole list: the caller
/// can redraw without asking for the root level again.
fn folders_pin(state: &Arc<AppState>, params: PinParams) -> Result<Value, RpcFailure> {
    let list = if params.pinned {
        // Only a folder this machine can see is worth a shortcut.
        let path = folder_path(&params.path)?;
        state
            .settings
            .set_pinned_folder(&path.to_string_lossy(), true)
    } else {
        // Unstarring does not need the folder to exist: a drive that is not
        // mounted still has to be removable from the list.
        state.settings.set_pinned_folder(&params.path, false)
    }
    .map_err(|error| fail("pin_failed", error))?;
    Ok(json!({ "pinned": list }))
}

/// Where browsing starts: the folders starred on this machine first, then home,
/// the projects folder and the drives. A place that is already starred is
/// listed once, in the pinned half, so the same folder never appears twice.
fn starting_points(starred: &[String], home: Option<PathBuf>, projects: PathBuf) -> Vec<Value> {
    let pinned: HashSet<String> = starred.iter().cloned().collect();
    let places = places(home, projects);
    let mut entries: Vec<Value> = Vec::new();
    for path in starred {
        let folder = PathBuf::from(path);
        // A starred folder can sit on a drive that is not mounted right now.
        // It stays starred and simply waits until it is back.
        if !folder.is_dir() {
            continue;
        }
        // A starred place keeps the name the picker already gave it, so Home
        // does not reappear as the folder it happens to live in.
        let name = places
            .iter()
            .find(|place| {
                place["path"]
                    .as_str()
                    .map(|known| crate::settings::same_path(known, path))
                    .unwrap_or(false)
            })
            .and_then(|place| place["name"].as_str().map(str::to_string))
            .or_else(|| {
                folder
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
            })
            .unwrap_or_else(|| path.clone());
        entries.push(json!({ "name": name, "path": path, "pinned": true }));
    }
    for place in places {
        let already = place["path"]
            .as_str()
            .map(|path| is_pinned(&pinned, path))
            .unwrap_or(false);
        if !already {
            entries.push(place);
        }
    }
    entries
}

fn is_pinned(pinned: &HashSet<String>, path: &str) -> bool {
    pinned
        .iter()
        .any(|entry| crate::settings::same_path(entry, path))
}

/// One level of a folder: its subfolders, the way back up, and the path itself
/// so the controller never has to build one. Each entry says whether this
/// machine has it starred, which is what the picker's star shows.
fn folder_listing(raw: &str, pinned: &HashSet<String>) -> Result<Value, RpcFailure> {
    let path = folder_path(raw)?;
    let mut entries: Vec<Value> = Vec::new();
    let mut truncated = false;
    let read = std::fs::read_dir(&path)
        .map_err(|error| fail("folder_unreadable", format!("Could not read it: {error}")))?;
    for entry in read.flatten() {
        let child = entry.path();
        // Follows a link: a folder that opens in Explorer is a folder the
        // agent can start in.
        if !child.is_dir() {
            continue;
        }
        // Folders only, so a level full of files still lists every folder in
        // it: the cap counts what the answer carries, not what was scanned.
        if entries.len() >= MAX_FOLDERS {
            truncated = true;
            break;
        }
        let child = crate::store::strip_verbatim(&child).to_string_lossy().to_string();
        entries.push(json!({
            "name": entry.file_name().to_string_lossy(),
            "path": child,
            "pinned": is_pinned(pinned, &child),
        }));
    }
    entries.sort_by_key(|entry| {
        entry["name"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
    });
    let parent = path
        .parent()
        .map(|parent| crate::store::strip_verbatim(parent).to_string_lossy().to_string());
    Ok(json!({
        "path": crate::store::strip_verbatim(&path).to_string_lossy(),
        "parent": parent,
        "entries": entries,
        "truncated": truncated,
    }))
}

/// Where browsing starts. A controller that has never seen this machine begins
/// at its home, its projects folder and its drives, then walks down from there.
fn places(home: Option<PathBuf>, projects: PathBuf) -> Vec<Value> {
    let mut places = Vec::new();
    if let Some(home) = home {
        places.push(place("Home", &home));
    }
    if projects.is_dir() {
        places.push(place("Projects", &projects));
    }
    #[cfg(windows)]
    places.extend(drives(std::time::Duration::from_millis(1200)));
    places
}

fn place(name: &str, path: &Path) -> Value {
    json!({
        "name": name,
        "path": crate::store::strip_verbatim(path).to_string_lossy(),
        "pinned": false,
    })
}

fn home_dir() -> Option<PathBuf> {
    let key = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(key)
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

/// The drive letters that answer, probed on their own thread: a mapped drive
/// that is disconnected can block for seconds, and the window should not wait
/// for it. A missing letter answers instantly, so this is only slow when the
/// machine really does have a drive that went away.
#[cfg(windows)]
fn drives(budget: std::time::Duration) -> Vec<Value> {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let (tx, rx) = mpsc::channel::<Value>();
    std::thread::spawn(move || {
        for letter in b'A'..=b'Z' {
            let name = format!("{}:", letter as char);
            let root = PathBuf::from(format!("{name}\\"));
            if root.is_dir() && tx.send(place(&name, &root)).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + budget;
    let mut found = Vec::new();
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left == Duration::ZERO {
            break;
        }
        match rx.recv_timeout(left) {
            Ok(drive) => found.push(drive),
            Err(_) => break,
        }
    }
    found
}

fn host_chat(state: &Arc<AppState>, chat: &Chat) -> Result<(), RpcFailure> {
    if !chat.meta.is_coding() {
        return Err(fail("not_coding", "That is not a coding-agent chat."));
    }
    if chat.meta.remote {
        return Err(fail(
            "not_owner",
            "This machine only has a cached copy of that chat.",
        ));
    }
    if let Some(device) = chat.meta.device_id.as_deref() {
        if device != state.agents.device_id() {
            return Err(fail(
                "not_owner",
                "That conversation belongs to another machine.",
            ));
        }
    }
    Ok(())
}

fn coding_create(state: &Arc<AppState>, params: CodingCreateParams) -> Result<Value, RpcFailure> {
    // A controller either picks one of the account's projects, or walks this
    // machine's folders with `folders.browse` and names the path it reached.
    let path = match params
        .folder
        .as_deref()
        .map(str::trim)
        .filter(|folder| !folder.is_empty())
    {
        Some(folder) => folder_path(folder)?,
        None => {
            let project = params.project.trim();
            if project.is_empty() {
                return Err(fail(
                    "bad_params",
                    "Name a project or a folder on this machine.",
                ));
            }
            project_folder(state, project)?
        }
    };
    let meta = crate::coding::create_on_host(state, &path.to_string_lossy())
        .map_err(|error| fail("create_failed", error))?;
    serde_json::to_value(meta).map_err(|error| fail("serialize", error.to_string()))
}

fn coding_fetch(state: &Arc<AppState>, params: ChatParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    // From now on the live records are mirrored to this chat's subscribers.
    mark_remote(state, chat_id);
    let value = serde_json::to_value(&chat).map_err(|error| fail("serialize", error.to_string()))?;
    Ok(json!({ "chat": value }))
}

fn coding_send(state: &Arc<AppState>, params: CodingSendParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let text = params.text.trim();
    if text.is_empty() {
        return Err(fail("bad_params", "The coding agent needs a message."));
    }
    let message_id = params
        .message_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.len() <= 80)
        .map(str::to_string);
    let mut chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    mark_remote(state, chat_id);
    // A controller's message is text: a picture stays on the machine the user
    // is sitting at (see `send_message`'s refusal for a cached coding chat).
    crate::coding::send_with_id(state, &mut chat, text, &[], message_id.as_deref())
        .map_err(|error| fail("send_failed", error))?;
    state.sync.wake();
    Ok(json!({ "chatId": chat_id }))
}

fn coding_compact(state: &Arc<AppState>, params: CodingCompactParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    let instructions = params
        .instructions
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty());
    crate::coding::compact(state, &chat, instructions)
        .map_err(|error| fail("compact_failed", error))?;
    Ok(json!({ "chatId": chat_id }))
}

fn coding_stop(state: &Arc<AppState>, params: ChatParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    mark_remote(state, chat_id);
    crate::coding::stop(state, chat_id);
    Ok(json!({ "chatId": chat_id }))
}

fn coding_answer(state: &Arc<AppState>, params: CodingAnswerParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let answer = params.answer.trim();
    if answer.is_empty() {
        return Err(fail("bad_params", "The answer is empty."));
    }
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    mark_remote(state, chat_id);
    crate::coding::answer(state, chat_id, answer)
        .map_err(|error| fail("answer_failed", error))?;
    Ok(json!({ "chatId": chat_id }))
}

fn coding_rename(state: &Arc<AppState>, params: CodingRenameParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let title = params.title.trim();
    if title.is_empty() {
        return Err(fail("bad_params", "A chat needs a title."));
    }
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    let meta = state
        .store
        .rename(chat_id, title)
        .map_err(|error| fail("rename_failed", error))?;
    state.sync.wake();
    serde_json::to_value(meta).map_err(|error| fail("serialize", error.to_string()))
}

/// Delete a direct coding chat because the controller asked for it.
///
/// The folder, the engine and the session live here, so the original can only
/// be removed here; removing the controller's cache alone would be undone by
/// the next stub sync. The stub tombstone is queued by the same local delete,
/// which is what takes the chat off the other devices.
fn coding_delete(state: &Arc<AppState>, params: ChatParams) -> Result<Value, RpcFailure> {
    let chat_id = params.chat_id.trim();
    let chat = state
        .store
        .load(chat_id)
        .map_err(|_| fail("unknown_chat", "No such conversation on this machine."))?;
    host_chat(state, &chat)?;
    crate::session::delete_local_chat(state, chat_id)
        .map_err(|error| fail("delete_failed", error))?;
    Ok(json!({ "chatId": chat_id, "deleted": true }))
}

/// Merge a controller's copy of a conversation into this machine's store.
///
/// Messages are unioned by id, the same rule the server uses. The caller may be
/// a phone whose last message has not reached sync yet; the host needs it now,
/// because the run's progress notes will be answered by the chat agent here.
fn merge_chat(state: &Arc<AppState>, mut incoming: Chat) -> Result<(), String> {
    match state.store.load(&incoming.meta.id) {
        Ok(mut local) => {
            let known: HashSet<String> = local.messages.iter().map(|m| m.id.clone()).collect();
            let mut added = false;
            for message in incoming.messages.drain(..) {
                if !known.contains(&message.id) {
                    local.messages.push(message);
                    added = true;
                }
            }
            if incoming.meta.updated_at > local.meta.updated_at {
                local.meta.title = incoming.meta.title;
                local.meta.preview = incoming.meta.preview;
                local.meta.updated_at = incoming.meta.updated_at;
                added = true;
            }
            if added {
                state.store.save(&mut local)?;
            }
        }
        Err(_) => {
            state.store.save(&mut incoming)?;
        }
    }
    Ok(())
}

/// Remember that this chat is being watched from another device, so its live
/// turn and agent events are mirrored to the relay.
pub fn mark_remote(state: &AppState, chat_id: &str) {
    if let Ok(mut chats) = state.remote_chats.lock() {
        chats.insert(chat_id.to_string());
    }
}

pub fn is_remote(state: &AppState, chat_id: &str) -> bool {
    state
        .remote_chats
        .lock()
        .map(|chats| chats.contains(chat_id))
        .unwrap_or(false)
}

pub fn publish_overview(state: &AppState, chat_id: &str) {
    let Ok(payload) = serde_json::to_value(state.agents.overview()) else {
        return;
    };
    let _ = state.relay.publish(
        chat_id,
        json!({ "type": "agents", "overview": payload }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hook-folders-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("alpha").join("nested")).unwrap();
        std::fs::create_dir_all(dir.join("beta")).unwrap();
        std::fs::write(dir.join("notes.txt"), "x").unwrap();
        dir
    }

    #[test]
    fn a_folder_must_be_a_full_path() {
        assert_eq!(folder_path("alpha").unwrap_err().code, "bad_params");
        assert_eq!(folder_path("  ").unwrap_err().code, "bad_params");
        assert_eq!(folder_path("..").unwrap_err().code, "bad_params");
    }

    #[test]
    fn a_file_is_not_a_folder() {
        let dir = scratch();
        let file = dir.join("notes.txt");
        assert_eq!(
            folder_path(&file.to_string_lossy()).unwrap_err().code,
            "unknown_folder"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_picked_folder_is_not_verbatim() {
        let dir = scratch();
        let resolved = folder_path(&dir.to_string_lossy()).unwrap();
        assert!(!resolved.to_string_lossy().starts_with(r"\?\"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_listing_holds_folders_only_and_in_order() {
        let dir = scratch();
        // A star is stored the way the pin RPC stores it: the folder it resolves
        // to, which is the path a listing hands out. Building it from `dir`
        // directly would be the un-canonical path, and on Linux the temp dir can
        // be a link (`/tmp` on the CI runner), which made this test fail there.
        let pinned: HashSet<String> = [folder_path(&dir.join("beta").to_string_lossy())
            .unwrap()
            .to_string_lossy()
            .to_string()]
        .into();
        let listing = folder_listing(&dir.to_string_lossy(), &pinned).unwrap();
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        // The star travels with the entry, so the picker can draw it.
        assert_eq!(listing["entries"][0]["pinned"], false);
        assert_eq!(listing["entries"][1]["pinned"], true);
        assert_eq!(
            listing["entries"][0]["path"].as_str().unwrap(),
            folder_path(&dir.join("alpha").to_string_lossy())
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(
            listing["parent"].as_str().unwrap(),
            folder_path(&std::env::temp_dir().to_string_lossy())
                .unwrap()
                .to_string_lossy()
        );
        assert_eq!(listing["truncated"], false);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn browsing_starts_at_the_places_that_exist() {
        let dir = scratch();
        let listed = places(Some(dir.clone()), dir.join("missing"));
        let names: Vec<&str> = listed
            .iter()
            .map(|place| place["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.first(), Some(&"Home"));
        assert!(!names.contains(&"Projects"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_starred_folder_is_a_shortcut_at_the_top_and_a_starred_place_is_listed_once() {
        let dir = scratch();
        let shortcut = folder_path(&dir.join("alpha").to_string_lossy())
            .unwrap()
            .to_string_lossy()
            .to_string();
        let home = folder_path(&dir.to_string_lossy()).unwrap();
        let starred = vec![
            shortcut.clone(),
            home.to_string_lossy().to_string(),
            // A folder on a drive that is not there right now stays starred
            // but is not offered.
            dir.join("unmounted").to_string_lossy().to_string(),
        ];
        let missing = dir.join("unmounted").to_string_lossy().to_string();
        let entries = starting_points(&starred, Some(home.clone()), dir.join("missing"));
        assert_eq!(entries[0]["pinned"], true, "the shortcut comes first");
        assert_eq!(entries[0]["name"], "alpha");
        assert_eq!(entries[0]["path"], shortcut);
        assert_eq!(entries[1]["pinned"], true, "the starred home is next");
        assert_eq!(entries[1]["name"], "Home");
        let home_path = entries[1]["path"].as_str().unwrap().to_string();
        assert_eq!(
            entries
                .iter()
                .filter(|entry| entry["path"].as_str() == Some(home_path.as_str()))
                .count(),
            1,
            "a starred place is listed in the pinned half only"
        );
        assert!(
            !entries
                .iter()
                .any(|entry| entry["path"].as_str() == Some(missing.as_str())),
            "a missing folder is not offered"
        );
        std::fs::remove_dir_all(&dir).ok();
    }
}
