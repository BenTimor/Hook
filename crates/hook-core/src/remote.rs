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

use crate::commands::AppState;
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
    project: String,
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
        "sessions.list" => sessions(state, decode(params)?),
        "coding.create" => coding_create(state, decode(params)?),
        "coding.fetch" => coding_fetch(state, decode(params)?),
        "coding.send" => coding_send(state, decode(params)?),
        "coding.stop" => coding_stop(state, decode(params)?),
        "coding.answer" => coding_answer(state, decode(params)?),
        "coding.rename" => coding_rename(state, decode(params)?),
        _ => Err(fail(
            "unknown_method",
            format!("Hook does not handle {method}."),
        )),
    }
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
        .steer(params.agent_id.trim(), &params.text)
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
    let project = params.project.trim();
    if project.is_empty() {
        return Err(fail("bad_params", "Name a project on this machine."));
    }
    let path = project_folder(state, project)?;
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
    crate::coding::send_with_id(state, &mut chat, text, message_id.as_deref())
        .map_err(|error| fail("send_failed", error))?;
    state.sync.wake();
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
