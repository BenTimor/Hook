use serde_json::{json, Value};

use crate::agent::AgentManager;
use crate::projects::ProjectsStore;
use crate::settings::SettingsStore;
use crate::store::truncate;

/// Tool surface offered to the chat model. The chat agent never touches files
/// directly: it organises projects and delegates all code work to a coding
/// agent, then reports back in prose.
pub fn definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "list_projects",
                "description": "List every project on this machine with its description and whether it is a git repo. Call this before deciding where a task belongs.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "create_project",
                "description": "Create a new, empty project folder in the projects directory and give it a description. Only use this when the work needs a brand new home.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "name": { "type": "string", "description": "Folder name, e.g. 'invoice-parser'. Letters, digits, spaces, dots, dashes and underscores." },
                        "description": { "type": "string", "description": "One or two sentences: what this project is and what belongs in it." }
                    },
                    "required": ["name", "description"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "update_project_description",
                "description": "Rewrite a project's description so you can find it again later. Keep it short and factual: what the project is, its stack, and what is worth knowing.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": { "type": "string", "description": "Project folder name." },
                        "description": { "type": "string", "description": "The new description, one or two sentences." }
                    },
                    "required": ["project", "description"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "start_coding_agent",
                "description": "Launch a coding agent in a project folder. It runs pi with full permissions inside that folder and can read, edit and run code. Write a complete brief: what to achieve, constraints, and how to verify. Returns immediately - you are notified when it settles or asks a question.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "project": { "type": "string", "description": "Project folder name." },
                        "task": { "type": "string", "description": "Self-contained instructions for the coding agent." },
                        "title": { "type": "string", "description": "Optional short label, e.g. 'Fix login redirect'." },
                        "resume_session_id": { "type": "string", "description": "Continue an earlier session from list_coding_sessions instead of starting fresh." }
                    },
                    "required": ["project", "task"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_agents",
                "description": "List coding agents started from this chat, with state and progress.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "agent_status",
                "description": "Detailed status of one coding agent: state, steps, last step, latest message, any question it is waiting on.",
                "parameters": {
                    "type": "object",
                    "properties": { "agent_id": { "type": "string" } },
                    "required": ["agent_id"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "steer_agent",
                "description": "Send mid-run guidance to a running coding agent. It is delivered after its current tool calls finish. Also works on an idle agent to start a follow-up task in the same session.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": { "type": "string" },
                        "message": { "type": "string", "description": "What to change or do next." }
                    },
                    "required": ["agent_id", "message"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "answer_agent",
                "description": "Answer a question a coding agent is blocked on. For confirm questions answer yes or no; for select questions answer with one of the offered options.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "agent_id": { "type": "string" },
                        "answer": { "type": "string" }
                    },
                    "required": ["agent_id", "answer"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "stop_agent",
                "description": "Stop a coding agent immediately. Use when it is going the wrong way, or the user asks to stop.",
                "parameters": {
                    "type": "object",
                    "properties": { "agent_id": { "type": "string" } },
                    "required": ["agent_id"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "list_coding_sessions",
                "description": "Recent coding sessions in a project, newest first, with ids and previews. Use one of these ids with start_coding_agent to continue earlier work.",
                "parameters": {
                    "type": "object",
                    "properties": { "project": { "type": "string", "description": "Project folder name." } },
                    "required": ["project"],
                    "additionalProperties": false
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "no_update",
                "description": "Say nothing to the user for this progress batch. Use this when the note contains nothing worth interrupting them for: routine steps, 'still working', no new picture, no milestone.",
                "parameters": { "type": "object", "properties": {}, "additionalProperties": false }
            }
        }
    ])
}

pub struct ToolEnv<'a> {
    pub agents: &'a AgentManager,
    pub projects: &'a ProjectsStore,
    pub settings: &'a SettingsStore,
    pub chat_id: &'a str,
}

/// Runs one tool call and returns the JSON text handed back to the model.
pub fn execute(env: &ToolEnv<'_>, name: &str, args: &Value) -> String {
    match run(env, name, args) {
        Ok(value) => value.to_string(),
        Err(message) => json!({ "error": message }).to_string(),
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing \"{key}\"."))
}

fn run(env: &ToolEnv<'_>, name: &str, args: &Value) -> Result<Value, String> {
    let root = env.settings.projects_dir();

    match name {
        "list_projects" => {
            let projects = env.projects.list(&root)?;
            let items: Vec<Value> = projects
                .iter()
                .map(|p| {
                    json!({
                        "project": p.name,
                        "description": if p.description.is_empty() { "(no description yet)" } else { p.description.as_str() },
                        "git": p.is_git,
                    })
                })
                .collect();
            Ok(json!({
                "projects": items,
                "hint": if items.is_empty() { "No projects yet. Create one with create_project." } else { "" },
            }))
        }
        "create_project" => {
            let name = arg_str(args, "name")?;
            let description = arg_str(args, "description")?;
            let project = env.projects.create(&root, name, description)?;
            Ok(json!({
                "created": project.name,
                "description": project.description,
            }))
        }
        "update_project_description" => {
            let project = arg_str(args, "project")?;
            let description = arg_str(args, "description")?;
            let updated = env.projects.describe(&root, project, description)?;
            Ok(json!({ "project": updated.name, "description": updated.description }))
        }
        "start_coding_agent" => {
            let project = arg_str(args, "project")?;
            let task = arg_str(args, "task")?;
            let title = args.get("title").and_then(|v| v.as_str());
            let resume = args.get("resume_session_id").and_then(|v| v.as_str());
            let info = env
                .agents
                .start(env.chat_id, project, task, title, resume)?;
            Ok(json!({
                "agent_id": info.id,
                "project": info.project,
                "state": info.state,
                "resumed_session": resume.is_some(),
                "note": "Running in the background. You may end your turn; you will be woken when it settles, fails, or asks a question.",
            }))
        }
        "list_agents" => {
            let agents: Vec<Value> = env
                .agents
                .list()
                .into_iter()
                .filter(|a| a.chat_id == env.chat_id)
                .map(|a| {
                    json!({
                        "agent_id": a.id,
                        "project": a.project,
                        "title": a.title,
                        "state": a.state,
                        "steps": a.steps,
                        "last_step": a.last_step,
                    })
                })
                .collect();
            Ok(json!({ "agents": agents }))
        }
        "agent_status" => {
            let id = arg_str(args, "agent_id")?;
            let info = env
                .agents
                .get(id)
                .ok_or_else(|| format!("No agent {id}"))?;
            if info.chat_id != env.chat_id {
                return Err(format!("No agent {id} in this chat."));
            }
            Ok(json!({
                "agent_id": info.id,
                "project": info.project,
                "title": info.title,
                "task": info.task,
                "state": info.state,
                "steps": info.steps,
                "last_step": info.last_step,
                "last_message": info.last_message.as_deref().map(|m| truncate(m, 2500)),
                "question": info.question.as_ref().map(|q| json!({
                    "method": q.method,
                    "title": q.title,
                    "message": q.message,
                    "options": q.options,
                })),
                "error": info.error,
                "session_id": info.session_id,
            }))
        }
        "steer_agent" => {
            let id = arg_str(args, "agent_id")?;
            let message = arg_str(args, "message")?;
            let info = env.agents.steer(id, message)?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "answer_agent" => {
            let id = arg_str(args, "agent_id")?;
            let answer = arg_str(args, "answer")?;
            let info = env.agents.answer(id, answer)?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "stop_agent" => {
            let id = arg_str(args, "agent_id")?;
            let info = env.agents.stop(id)?;
            Ok(json!({ "agent_id": info.id, "state": info.state }))
        }
        "list_coding_sessions" => {
            let project = arg_str(args, "project")?;
            let path = env.projects.resolve(&root, project)?;
            let sessions: Vec<Value> = env
                .agents
                .sessions(&path.to_string_lossy())
                .into_iter()
                .map(|s| {
                    json!({
                        "session_id": s.id,
                        "title": s.title,
                        "preview": s.preview,
                    })
                })
                .collect();
            Ok(json!({ "project": project, "sessions": sessions }))
        }
        // Intercepted by the turn loop before it gets here; the arm exists so
        // an unexpected call still behaves.
        "no_update" => Ok(json!({ "sent": false })),
        other => Err(format!("Unknown tool: {other}")),
    }
}

/// A compact note appended to the chat history when a coding agent needs
/// attention. Hidden from the user; the chat agent turns it into prose.
/// The progress notes a coding agent sent since the last batch, oldest first.
pub fn progress_block(updates: &[crate::agent::Update]) -> String {
    let mut block = String::from("progress:\n");
    let mut pictures = 0usize;
    for update in updates {
        if update.note.is_empty() {
            continue;
        }
        for line in update.note.lines().take(6) {
            let line = line.trim();
            if !line.is_empty() {
                block.push_str("- ");
                block.push_str(&truncate(line, 300));
                block.push('\n');
            }
        }
        pictures += update.images.len();
    }
    if pictures > 0 {
        block.push_str(&format!(
            "pictures: {pictures} attached to this update; they are shown to the user with your reply.\n"
        ));
    }
    block
}

pub fn agent_event_note(info: &crate::agent::AgentInfo) -> String {
    let mut note = String::from("[coding agent update]\n");
    note.push_str(&format!("agent_id: {}\n", info.id));
    note.push_str(&format!("project: {}\n", info.project));
    note.push_str(&format!("state: {}\n", info.state));
    note.push_str(&format!("task: {}\n", truncate(&info.task, 400)));
    note.push_str(&format!("steps: {}\n", info.steps));
    if let Some(step) = &info.last_step {
        note.push_str(&format!("last_step: {step}\n"));
    }
    if let Some(question) = &info.question {
        note.push_str(&format!("question: {}\n", truncate(&question.title, 400)));
        if !question.message.is_empty() {
            note.push_str(&format!("question_detail: {}\n", truncate(&question.message, 600)));
        }
        if !question.options.is_empty() {
            note.push_str(&format!("options: {}\n", question.options.join(" | ")));
        }
        note.push_str("next: answer with answer_agent, or ask the user first.\n");
    }
    if let Some(error) = &info.error {
        note.push_str(&format!("error: {}\n", truncate(error, 600)));
    }
    if let Some(message) = &info.last_message {
        note.push_str("last_message:\n");
        note.push_str(&truncate(message, 2000));
        note.push('\n');
    }
    note.push_str(
        "Write a short update for the user about what happened. Do not mention agent ids, sessions or tooling.\n",
    );
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_cover_every_implemented_tool() {
        let defs = definitions();
        let names: Vec<&str> = defs
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|d| d.pointer("/function/name").and_then(|n| n.as_str()))
            .collect();
        for expected in [
            "list_projects",
            "create_project",
            "update_project_description",
            "start_coding_agent",
            "list_agents",
            "agent_status",
            "steer_agent",
            "answer_agent",
            "stop_agent",
            "list_coding_sessions",
        ] {
            assert!(names.contains(&expected), "{expected} missing");
        }
    }

    #[test]
    fn unknown_tools_report_an_error_instead_of_panicking() {
        let base = std::env::temp_dir().join(format!("hook-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = SettingsStore::new(&base);
        let projects = ProjectsStore::new(&base);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agents = AgentManager::new(
            &base,
            std::sync::Arc::new(crate::config::get().expect("config").clone()),
            Ok(crate::runtime::PiRuntime {
                program: std::path::PathBuf::from("pi"),
                cli: None,
                agent_home: base.join("agent-home"),
            }),
            std::sync::Arc::new(SettingsStore::new(&base)),
            std::sync::Arc::new(ProjectsStore::new(&base)),
            tx,
        );
        let env = ToolEnv {
            agents: &agents,
            projects: &projects,
            settings: &settings,
            chat_id: "c1",
        };
        let out = execute(&env, "nope", &json!({}));
        assert!(out.contains("Unknown tool"));
    }

    #[test]
    fn missing_arguments_are_reported() {
        let base = std::env::temp_dir().join(format!("hook-tools-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = SettingsStore::new(&base);
        let projects = ProjectsStore::new(&base);
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let agents = AgentManager::new(
            &base,
            std::sync::Arc::new(crate::config::get().expect("config").clone()),
            Ok(crate::runtime::PiRuntime {
                program: std::path::PathBuf::from("pi"),
                cli: None,
                agent_home: base.join("agent-home"),
            }),
            std::sync::Arc::new(SettingsStore::new(&base)),
            std::sync::Arc::new(ProjectsStore::new(&base)),
            tx,
        );
        let env = ToolEnv {
            agents: &agents,
            projects: &projects,
            settings: &settings,
            chat_id: "c1",
        };
        let out = execute(&env, "create_project", &json!({}));
        assert!(out.contains("Missing"));
    }
}
