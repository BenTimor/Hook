use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::config::CodingConfig;
use crate::projects::ProjectsStore;
use crate::settings::SettingsStore;
use crate::store::{now_ms, truncate};

/// How long a settled agent stays warm so the chat agent can continue the same
/// process cheaply. After this the child is closed; the session stays resumable.
const IDLE_KEEP_ALIVE: Duration = Duration::from_secs(300);
/// How long a coding agent may wait for an answer before we cancel its dialog.
const QUESTION_TIMEOUT: Duration = Duration::from_secs(900);
/// Grace period for an aborted run before the process tree is killed.
const KILL_GRACE: Duration = Duration::from_secs(4);

pub const STATE_STARTING: &str = "starting";
pub const STATE_RUNNING: &str = "running";
pub const STATE_IDLE: &str = "idle";
pub const STATE_NEEDS_INPUT: &str = "needs_input";
pub const STATE_DONE: &str = "done";
pub const STATE_FAILED: &str = "failed";
pub const STATE_STOPPED: &str = "stopped";
pub const STATE_INTERRUPTED: &str = "interrupted";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentQuestion {
    pub id: String,
    pub method: String,
    pub title: String,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub options: Vec<String>,
    #[serde(default)]
    pub placeholder: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub chat_id: String,
    pub project: String,
    pub project_path: String,
    pub title: String,
    pub task: String,
    pub session_id: String,
    pub state: String,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    pub steps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_step: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub question: Option<AgentQuestion>,
}

impl AgentInfo {
    pub fn is_live(&self) -> bool {
        matches!(
            self.state.as_str(),
            STATE_STARTING | STATE_RUNNING | STATE_NEEDS_INPUT | STATE_IDLE
        )
    }

    pub fn is_working(&self) -> bool {
        matches!(self.state.as_str(), STATE_STARTING | STATE_RUNNING)
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentsFile {
    #[serde(default)]
    agents: Vec<AgentInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub preview: String,
}

/// Sent to the chat layer when a coding agent needs the chat agent's attention.
#[derive(Debug, Clone)]
pub struct Wake {
    pub agent_id: String,
}

/// Everything the UI supervisor needs to hear about.
#[derive(Debug, Clone)]
pub enum Signal {
    /// A coding agent needs the chat agent to speak.
    Wake(Wake),
    /// The set of running agents changed (for the indicator).
    Changed,
}

enum AgentCmd {
    Line(serde_json::Value),
    Kill,
}

struct Entry {
    info: AgentInfo,
    tx: Option<mpsc::UnboundedSender<AgentCmd>>,
    /// PID of the spawned `cmd.exe` shim, for tree termination on quit.
    pid: Option<u32>,
}

#[derive(Default)]
struct Inner {
    agents: HashMap<String, Entry>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

pub struct AgentManager {
    inner: Arc<Mutex<Inner>>,
    data_dir: PathBuf,
    sessions_dir: PathBuf,
    coding: CodingConfig,
    settings: Arc<SettingsStore>,
    projects: Arc<ProjectsStore>,
    signal_tx: mpsc::UnboundedSender<Signal>,
}

impl AgentManager {
    pub fn new(
        data_dir: &Path,
        coding: CodingConfig,
        settings: Arc<SettingsStore>,
        projects: Arc<ProjectsStore>,
        signal_tx: mpsc::UnboundedSender<Signal>,
    ) -> Self {
        let sessions_dir = data_dir.join("agent-sessions");
        let _ = std::fs::create_dir_all(&sessions_dir);

        let mut inner = Inner::default();
        if let Ok(raw) = std::fs::read_to_string(data_dir.join("agents.json")) {
            if let Ok(file) = serde_json::from_str::<AgentsFile>(&raw) {
                for mut info in file.agents {
                    // Nothing can still be running: children die with the app.
                    if info.is_live() {
                        info.state = STATE_INTERRUPTED.to_string();
                        info.updated_at = now_ms();
                        info.error = Some("Hook closed while this agent was working.".into());
                    }
                    inner.agents.insert(
                        info.id.clone(),
                        Entry {
                            info,
                            tx: None,
                            pid: None,
                        },
                    );
                }
            }
        }

        Self {
            inner: Arc::new(Mutex::new(inner)),
            data_dir: data_dir.to_path_buf(),
            sessions_dir,
            coding,
            settings,
            projects,
            signal_tx,
        }
    }

    pub fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        lock(&self.inner).agents.get(agent_id).map(|e| e.info.clone())
    }

    pub fn list(&self) -> Vec<AgentInfo> {
        let mut out: Vec<AgentInfo> = lock(&self.inner)
            .agents
            .values()
            .map(|e| e.info.clone())
            .collect();
        out.sort_by_key(|a| a.created_at);
        out
    }

    pub fn working_count(&self) -> usize {
        lock(&self.inner)
            .agents
            .values()
            .filter(|e| e.info.is_working())
            .count()
    }

    pub fn live_count(&self) -> usize {
        lock(&self.inner)
            .agents
            .values()
            .filter(|e| e.info.is_live())
            .count()
    }

    pub fn start(
        &self,
        chat_id: &str,
        project_ref: &str,
        task: &str,
        title: Option<&str>,
        resume_session: Option<&str>,
    ) -> Result<AgentInfo, String> {
        let task = task.trim();
        if task.is_empty() {
            return Err("The coding agent needs a task.".into());
        }
        if let Some(id) = resume_session {
            if !is_safe_session_id(id) {
                return Err(format!("Invalid session id: {id}"));
            }
        }

        let root = self.settings.projects_dir();
        let project_path = self.projects.resolve(&root, project_ref)?;
        let project_name = project_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| project_ref.to_string());

        let max = self.coding.max_concurrent.max(1);
        if self.working_count() >= max {
            let busy: Vec<String> = self
                .list()
                .into_iter()
                .filter(|a| a.is_working())
                .map(|a| format!("{} ({})", a.id, a.project))
                .collect();
            return Err(format!(
                "All {max} coding slots are busy with {}. Wait for one to finish or stop one first.",
                busy.join(", ")
            ));
        }

        let pi = self.settings.pi_command().ok_or_else(|| {
            "pi was not found on this machine. Set its path in Hook's settings.".to_string()
        })?;
        let guard = crate::guard::ensure(&self.data_dir)?;

        let session_id = resume_session
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let id = format!("ag_{}", uuid::Uuid::new_v4().simple());
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| truncate(t, 60))
            .unwrap_or_else(|| truncate(task, 60));

        let args = agent_args(
            &self.sessions_dir,
            &session_id,
            &title,
            &guard,
            &self.coding,
        );

        let mut command = build_command(&pi, &args);
        command
            .current_dir(&project_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .env("PI_BASH_MAX_TIMEOUT", self.coding.bash_max_timeout.to_string())
            .env("PI_BASH_MIN_TIMEOUT", self.coding.bash_min_timeout.to_string());

        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start pi at {pi}: {e}"))?;

        let pid = child.id();
        let stdin = child.stdin.take().ok_or("pi did not open stdin")?;
        let stdout = child.stdout.take().ok_or("pi did not open stdout")?;

        let now = now_ms();
        let info = AgentInfo {
            id: id.clone(),
            chat_id: chat_id.to_string(),
            project: project_name,
            project_path: project_path.to_string_lossy().to_string(),
            title,
            task: task.to_string(),
            session_id,
            state: STATE_STARTING.to_string(),
            created_at: now,
            updated_at: now,
            finished_at: None,
            steps: 0,
            last_step: None,
            last_message: None,
            error: None,
            question: None,
        };

        let (tx, rx) = mpsc::unbounded_channel();
        {
            let mut inner = lock(&self.inner);
            inner.agents.insert(
                id.clone(),
                Entry {
                    info: info.clone(),
                    tx: Some(tx.clone()),
                    pid,
                },
            );
            persist(&self.data_dir, &inner);
        }
        let _ = self.signal_tx.send(Signal::Changed);

        // Kick off the run.
        let _ = tx.send(AgentCmd::Line(serde_json::json!({
            "id": next_id("prompt"),
            "type": "prompt",
            "message": task,
        })));

        let inner = self.inner.clone();
        let data_dir = self.data_dir.clone();
        let signal_tx = self.signal_tx.clone();
        let chat_id = chat_id.to_string();
        tokio::spawn(async move {
            drive(
                id, chat_id, inner, data_dir, signal_tx, child, stdin, stdout, rx,
            )
            .await;
        });

        Ok(info)
    }

    pub fn steer(&self, agent_id: &str, message: &str) -> Result<AgentInfo, String> {
        let message = message.trim();
        if message.is_empty() {
            return Err("Steering message is empty.".into());
        }
        let (info, tx) = {
            let inner = lock(&self.inner);
            let entry = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| format!("No agent {agent_id}"))?;
            (entry.info.clone(), entry.tx.clone())
        };
        let tx = tx.ok_or("That coding agent is no longer running.")?;
        match info.state.as_str() {
            STATE_STARTING | STATE_RUNNING | STATE_NEEDS_INPUT => {
                if let Some(question) = &info.question {
                    // A dialog blocks the run; answering is the only way forward.
                    return Err(format!(
                        "That agent is waiting for an answer to: {}",
                        question.title
                    ));
                }
                tx.send(AgentCmd::Line(serde_json::json!({
                    "type": "steer",
                    "message": message,
                })))
                .map_err(|_| "That coding agent is no longer running.".to_string())?;
            }
            STATE_IDLE => {
                tx.send(AgentCmd::Line(serde_json::json!({
                    "id": next_id("prompt"),
                    "type": "prompt",
                    "message": message,
                })))
                .map_err(|_| "That coding agent is no longer running.".to_string())?;
                self.set_state(agent_id, STATE_RUNNING, |info| {
                    info.updated_at = now_ms();
                });
            }
            _ => return Err("That coding agent has already finished.".into()),
        }
        Ok(self.get(agent_id).unwrap_or(info))
    }

    pub fn answer(&self, agent_id: &str, answer: &str) -> Result<AgentInfo, String> {
        let (question, tx) = {
            let inner = lock(&self.inner);
            let entry = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| format!("No agent {agent_id}"))?;
            (entry.info.question.clone(), entry.tx.clone())
        };
        let question = question.ok_or("That agent is not asking anything right now.")?;
        let tx = tx.ok_or("That coding agent is no longer running.")?;
        let answer = answer.trim();

        let payload = match question.method.as_str() {
            "confirm" => {
                let yes = matches!(
                    answer.to_ascii_lowercase().as_str(),
                    "yes" | "y" | "true" | "confirm" | "allow" | "approve" | "ok" | "sure"
                );
                serde_json::json!({
                    "type": "extension_ui_response",
                    "id": question.id,
                    "confirmed": yes,
                })
            }
            "select" => {
                let pick = question
                    .options
                    .iter()
                    .find(|o| o.eq_ignore_ascii_case(answer))
                    .cloned()
                    .or_else(|| {
                        question
                            .options
                            .iter()
                            .find(|o| o.to_lowercase().contains(&answer.to_lowercase()))
                            .cloned()
                    });
                match pick {
                    Some(value) => serde_json::json!({
                        "type": "extension_ui_response",
                        "id": question.id,
                        "value": value,
                    }),
                    None => serde_json::json!({
                        "type": "extension_ui_response",
                        "id": question.id,
                        "value": answer,
                    }),
                }
            }
            _ => serde_json::json!({
                "type": "extension_ui_response",
                "id": question.id,
                "value": answer,
            }),
        };

        tx.send(AgentCmd::Line(payload))
            .map_err(|_| "That coding agent is no longer running.".to_string())?;
        self.set_state(agent_id, STATE_RUNNING, |info| {
            info.question = None;
            info.updated_at = now_ms();
        });
        self.get(agent_id)
            .ok_or_else(|| "That coding agent is no longer running.".to_string())
    }

    pub fn stop(&self, agent_id: &str) -> Result<AgentInfo, String> {
        let (info, tx) = {
            let inner = lock(&self.inner);
            let entry = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| format!("No agent {agent_id}"))?;
            (entry.info.clone(), entry.tx.clone())
        };
        match tx {
            Some(tx) if info.is_live() => {
                let _ = tx.send(AgentCmd::Kill);
                self.set_state(agent_id, STATE_STOPPED, |info| {
                    info.question = None;
                    info.updated_at = now_ms();
                    info.finished_at = Some(now_ms());
                });
                Ok(self.get(agent_id).unwrap_or(info))
            }
            _ => Err("That coding agent has already finished.".into()),
        }
    }

    /// Called from the app's exit path: kill every live child process tree so
    /// nothing keeps running invisibly after Hook closes.
    pub fn kill_all_sync(&self) {
        let mut guard = lock(&self.inner);
        for entry in guard.agents.values_mut() {
            if let Some(pid) = entry.pid.take() {
                kill_tree(pid);
            }
            entry.tx = None;
            if entry.info.is_live() {
                entry.info.state = STATE_INTERRUPTED.to_string();
                entry.info.finished_at = Some(now_ms());
                entry.info.updated_at = now_ms();
                if entry.info.error.is_none() {
                    entry.info.error = Some("Hook closed while this agent was working.".into());
                }
            }
        }
        persist(&self.data_dir, &guard);
    }

    fn set_state(&self, agent_id: &str, state: &str, mutate: impl FnOnce(&mut AgentInfo)) {
        let mut inner = lock(&self.inner);
        if let Some(entry) = inner.agents.get_mut(agent_id) {
            entry.info.state = state.to_string();
            mutate(&mut entry.info);
        }
        persist(&self.data_dir, &inner);
        let _ = self.signal_tx.send(Signal::Changed);
    }

    /// Past pi sessions for a project folder, newest first.
    pub fn sessions(&self, project_path: &str) -> Vec<SessionSummary> {
        let target = normalize_path(project_path);
        let mut out = Vec::new();
        for file in walk_jsonl(&self.sessions_dir, 2) {
            let Some(summary) = read_session_summary(&file) else {
                continue;
            };
            if normalize_path(&summary.0) == target {
                out.push(summary.1);
            }
        }
        out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        out.truncate(20);
        out
    }
}

fn next_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4().simple())
}

fn persist(data_dir: &Path, inner: &Inner) {
    let file = AgentsFile {
        agents: inner.agents.values().map(|e| e.info.clone()).collect(),
    };
    let Ok(raw) = serde_json::to_string_pretty(&file) else {
        return;
    };
    let path = data_dir.join("agents.json");
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, raw).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

pub fn is_safe_session_id(id: &str) -> bool {
    let trimmed = id.trim();
    if trimmed.len() < 2 || trimmed.len() > 128 {
        return false;
    }
    let first = trimmed.chars().next().unwrap_or(' ');
    let last = trimmed.chars().last().unwrap_or(' ');
    let alnum = |c: char| c.is_ascii_alphanumeric();
    alnum(first)
        && alnum(last)
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
}

/// pi writes session files as `<root>/--<cwd with separators replaced>--/<ts>_<id>.jsonl`.
pub fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn walk_jsonl(root: &Path, depth: usize) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && depth > 0 {
            out.extend(walk_jsonl(&path, depth - 1));
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
    out
}

fn read_session_summary(path: &Path) -> Option<(String, SessionSummary)> {
    let raw = std::fs::read_to_string(path).ok()?;
    let mut cwd = String::new();
    let mut id = String::new();
    let mut updated_at = 0i64;
    let mut name = String::new();
    let mut preview = String::new();

    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        match value.get("type").and_then(|t| t.as_str()).unwrap_or("") {
            "session" => {
                cwd = value
                    .get("cwd")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                id = value
                    .get("id")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                if let Some(stamp) = value.get("timestamp").and_then(|v| v.as_str()) {
                    updated_at = parse_rfc3339_ms(stamp).unwrap_or(0);
                }
            }
            "session_info_changed" => {
                if let Some(n) = value.get("name").and_then(|v| v.as_str()) {
                    name = n.to_string();
                }
            }
            "message" => {
                let message = value.get("message");
                let role = message
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    .unwrap_or("");
                let text = message.map(text_of_message).unwrap_or_default();
                if role == "user" && preview.is_empty() && !text.trim().is_empty() {
                    preview = truncate(&text.replace('\n', " "), 120);
                }
                if let Some(stamp) = value.get("timestamp").and_then(|v| v.as_str()) {
                    if let Some(ms) = parse_rfc3339_ms(stamp) {
                        updated_at = updated_at.max(ms);
                    }
                }
            }
            _ => {}
        }
    }

    if id.is_empty() || cwd.is_empty() {
        return None;
    }
    let title = if name.trim().is_empty() {
        file_stem_title(path)
    } else {
        name
    };
    Some((
        cwd,
        SessionSummary {
            id,
            title,
            updated_at,
            preview,
        },
    ))
}

fn file_stem_title(path: &Path) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    stem.split('_').next_back().unwrap_or(&stem).chars().take(8).collect()
}

fn parse_rfc3339_ms(stamp: &str) -> Option<i64> {
    // Minimal RFC3339 parser: 2026-07-29T10:03:10.612Z
    let (date, rest) = stamp.split_once('T')?;
    let mut d = date.split('-');
    let year: i64 = d.next()?.parse().ok()?;
    let month: i64 = d.next()?.parse().ok()?;
    let day: i64 = d.next()?.parse().ok()?;
    let time = rest.trim_end_matches('Z');
    let mut t = time.split(':');
    let hour: i64 = t.next()?.parse().ok()?;
    let minute: i64 = t.next()?.parse().ok()?;
    let sec: f64 = t.next()?.parse().ok()?;
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + hour * 3_600_000 + minute * 60_000 + (sec * 1000.0) as i64)
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn text_of_message(message: &serde_json::Value) -> String {
    match message.get("content") {
        Some(serde_json::Value::String(text)) => text.clone(),
        Some(serde_json::Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// The exact pi command line used for every coding agent. Isolation is the
/// point: no host extensions, skills, prompt templates or MCP servers, and no
/// project-local pi config — only Hook's guard.
pub fn agent_args(
    sessions_dir: &Path,
    session_id: &str,
    title: &str,
    guard: &Path,
    coding: &CodingConfig,
) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "--mode".into(),
        "rpc".into(),
        "--session-dir".into(),
        sessions_dir.to_string_lossy().to_string(),
        "--session-id".into(),
        session_id.to_string(),
        "--name".into(),
        title.to_string(),
        "-ne".into(),
        "-e".into(),
        guard.to_string_lossy().to_string(),
        "-ns".into(),
        "-np".into(),
        "--no-mcp".into(),
        "-na".into(),
    ];
    if let Some(model) = coding.model() {
        args.push("--model".into());
        args.push(model.to_string());
    }
    if let Some(thinking) = coding.thinking() {
        args.push("--thinking".into());
        args.push(thinking.to_string());
    }
    args
}

/// Kill the whole process tree: the `.cmd` shim is the direct child, and the
/// real node process hangs off it.
pub fn kill_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status();
    }
}

fn build_command(pi: &str, args: &[String]) -> Command {
    if cfg!(target_os = "windows") && !pi.to_ascii_lowercase().ends_with(".exe") {
        // npm shims are .cmd batch files; CreateProcess cannot launch them directly.
        let mut command = Command::new("cmd");
        command.arg("/C").arg(pi);
        command.args(args);
        command
    } else {
        let mut command = Command::new(pi);
        command.args(args);
        command
    }
}

fn short_step(tool: &str, args: &serde_json::Value) -> String {
    let detail = args
        .get("command")
        .or_else(|| args.get("path"))
        .or_else(|| args.get("file_path"))
        .or_else(|| args.get("pattern"))
        .or_else(|| args.get("query"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let detail = truncate(&detail.replace('\n', " "), 90);
    if detail.is_empty() {
        tool.to_string()
    } else {
        format!("{tool}: {detail}")
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    agent_id: String,
    _chat_id: String,
    inner: Arc<Mutex<Inner>>,
    data_dir: PathBuf,
    signal_tx: mpsc::UnboundedSender<Signal>,
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut rx: mpsc::UnboundedReceiver<AgentCmd>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let mut idle_deadline: Option<tokio::time::Instant> = None;
    let mut question_deadline: Option<tokio::time::Instant> = None;
    let mut kill_deadline: Option<tokio::time::Instant> = None;
    let mut saw_settle = false;

    loop {
        let ticking = idle_deadline.is_some() || question_deadline.is_some() || kill_deadline.is_some();
        tokio::select! {
            line = lines.next_line() => {
                match line {
                    Ok(Some(line)) => {
                        let Ok(record) = serde_json::from_str::<serde_json::Value>(line.trim()) else { continue };
                        let wake = apply_record(&inner, &agent_id, &record);
                        persist(&data_dir, &lock(&inner));
                        match wake {
                            Some(_) => {
                                let _ = signal_tx.send(Signal::Wake(Wake { agent_id: agent_id.clone() }));
                            }
                            None => {}
                        }
                        let state = lock(&inner).agents.get(&agent_id).map(|e| e.info.state.clone()).unwrap_or_default();
                        match state.as_str() {
                            STATE_IDLE => { idle_deadline = Some(tokio::time::Instant::now() + IDLE_KEEP_ALIVE); saw_settle = true; }
                            STATE_NEEDS_INPUT => {
                                idle_deadline = None;
                                question_deadline = Some(tokio::time::Instant::now() + QUESTION_TIMEOUT);
                            }
                            _ => {
                                idle_deadline = None;
                                question_deadline = None;
                            }
                        }
                    }
                    _ => break,
                }
            }
            cmd = rx.recv() => {
                let Some(cmd) = cmd else { break };
                match cmd {
                    AgentCmd::Line(value) => {
                        let mut payload = serde_json::to_vec(&value).unwrap_or_default();
                        payload.push(b'\n');
                        if stdin.write_all(&payload).await.is_err() || stdin.flush().await.is_err() {
                            break;
                        }
                        idle_deadline = None;
                    }
                    AgentCmd::Kill => {
                        let _ = stdin.write_all(b"{\"type\":\"abort\"}\n").await;
                        let _ = stdin.flush().await;
                        kill_deadline = Some(tokio::time::Instant::now() + KILL_GRACE);
                    }
                }
            }
            _ = tokio::time::sleep(Duration::from_secs(5)), if ticking => {
                let now = tokio::time::Instant::now();
                if let Some(deadline) = kill_deadline {
                    if now >= deadline { break; }
                }
                if let Some(deadline) = question_deadline {
                    if now >= deadline {
                        let question = lock(&inner).agents.get(&agent_id).and_then(|e| e.info.question.clone());
                        question_deadline = None;
                        if let Some(q) = question {
                            let payload = format!("{{\"type\":\"extension_ui_response\",\"id\":\"{}\",\"cancelled\":true}}\n", q.id);
                            let _ = stdin.write_all(payload.as_bytes()).await;
                            let _ = stdin.flush().await;
                            mark_state(&inner, &agent_id, STATE_STOPPED, |info| {
                                info.question = None;
                                info.error = Some("Nobody answered the agent's question in time.".into());
                            });
                            persist(&data_dir, &lock(&inner));
                            let _ = signal_tx.send(Signal::Wake(Wake { agent_id: agent_id.clone() }));
                            break;
                        }
                    }
                }
                if let Some(deadline) = idle_deadline {
                    if now >= deadline && saw_settle { break; }
                }
            }
        }
    }

    let _ = stdin.shutdown().await;
    drop(stdin);
    let _ = tokio::time::timeout(Duration::from_secs(2), child.wait()).await;
    let _ = child.kill().await;

    let mut wake: Option<Wake> = None;
    {
        let mut guard = lock(&inner);
        if let Some(entry) = guard.agents.get_mut(&agent_id) {
            entry.tx = None;
            entry.pid = None;
            let previous = entry.info.state.clone();
            let terminal = matches!(
                previous.as_str(),
                STATE_DONE | STATE_FAILED | STATE_STOPPED | STATE_INTERRUPTED
            );
            if !terminal {
                if previous == STATE_IDLE {
                    // Reaped after the keep-alive window; already announced.
                    entry.info.state = STATE_DONE.to_string();
                } else {
                    entry.info.state = STATE_FAILED.to_string();
                    entry.info.finished_at = Some(now_ms());
                    entry.info.updated_at = now_ms();
                    entry.info.question = None;
                    if entry.info.error.is_none() {
                        entry.info.error = Some("The coding agent stopped unexpectedly.".into());
                    }
                    wake = Some(Wake {
                        agent_id: agent_id.clone(),
                    });
                }
            }
        }
    }
    persist(&data_dir, &lock(&inner));
    if let Some(wake) = wake {
        let _ = signal_tx.send(Signal::Wake(wake));
    }
    let _ = signal_tx.send(Signal::Changed);
}

fn mark_state(
    inner: &Arc<Mutex<Inner>>,
    agent_id: &str,
    state: &str,
    mutate: impl FnOnce(&mut AgentInfo),
) {
    let mut guard = lock(inner);
    if let Some(entry) = guard.agents.get_mut(agent_id) {
        entry.info.state = state.to_string();
        entry.info.updated_at = now_ms();
        mutate(&mut entry.info);
    }
}

/// Apply one pi RPC record. Returns Some when the chat agent should be woken.
fn apply_record(inner: &Arc<Mutex<Inner>>, agent_id: &str, record: &serde_json::Value) -> Option<()> {
    let kind = record.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let mut wake = false;

    {
        let mut guard = lock(inner);
        let Some(entry) = guard.agents.get_mut(agent_id) else {
            return None;
        };
        let info = &mut entry.info;

        match kind {
            "agent_start" | "turn_start" => {
                info.state = STATE_RUNNING.to_string();
                info.updated_at = now_ms();
            }
            "tool_execution_start" => {
                let tool = record
                    .get("toolName")
                    .and_then(|t| t.as_str())
                    .unwrap_or("tool");
                let args = record.get("args").cloned().unwrap_or(serde_json::Value::Null);
                info.steps = info.steps.saturating_add(1);
                info.last_step = Some(short_step(tool, &args));
                info.updated_at = now_ms();
            }
            "message_end" => {
                if let Some(message) = record.get("message") {
                    let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
                    if role == "assistant" {
                        let text = text_of_message(message);
                        if !text.trim().is_empty() {
                            info.last_message = Some(truncate(&text, 4000));
                            info.updated_at = now_ms();
                        }
                        if let Some(stop) = message.get("stopReason").and_then(|s| s.as_str()) {
                            if stop == "error" || stop == "aborted" {
                                if let Some(err) = message.get("errorMessage").and_then(|e| e.as_str()) {
                                    info.error = Some(truncate(err, 500));
                                }
                            }
                        }
                    }
                }
            }
            "extension_ui_request" => {
                let method = record
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                if matches!(method.as_str(), "select" | "confirm" | "input" | "editor") {
                    let question = AgentQuestion {
                        id: record
                            .get("id")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        method,
                        title: record
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or("The coding agent has a question")
                            .to_string(),
                        message: record
                            .get("message")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                        options: record
                            .get("options")
                            .and_then(|v| v.as_array())
                            .map(|items| {
                                items
                                    .iter()
                                    .filter_map(|i| i.as_str().map(str::to_string))
                                    .collect()
                            })
                            .unwrap_or_default(),
                        placeholder: record
                            .get("placeholder")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .to_string(),
                    };
                    info.state = STATE_NEEDS_INPUT.to_string();
                    info.question = Some(question);
                    info.updated_at = now_ms();
                    wake = true;
                }
            }
            "agent_settled" => {
                // Settled means nothing is pending any more, question included.
                info.question = None;
                info.state = STATE_IDLE.to_string();
                info.finished_at = Some(now_ms());
                info.updated_at = now_ms();
                wake = true;
            }
            _ => {}
        }
    }

    wake.then_some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manager() -> AgentManager {
        let base = std::env::temp_dir().join(format!("hook-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = Arc::new(SettingsStore::new(&base));
        let projects = Arc::new(ProjectsStore::new(&base));
        let (tx, _rx) = mpsc::unbounded_channel();
        AgentManager::new(&base, CodingConfig::default(), settings, projects, tx)
    }

    #[test]
    fn session_ids_are_validated() {
        assert!(is_safe_session_id("019ff544-c37b-74d9-9df5-83f6c7fa14af"));
        assert!(is_safe_session_id("my-feature_1.2"));
        assert!(!is_safe_session_id("-starts-with-dash"));
        assert!(!is_safe_session_id("ends-with-dash-"));
        assert!(!is_safe_session_id("has space"));
        assert!(!is_safe_session_id("has/slash"));
        assert!(!is_safe_session_id(""));
    }

    #[test]
    fn paths_are_normalised_for_comparison() {
        assert_eq!(
            normalize_path("C:\\Users\\me\\Documents\\Hook\\App\\"),
            "c:/users/me/documents/hook/app"
        );
    }

    #[test]
    fn rfc3339_parsing_handles_millis() {
        let ms = parse_rfc3339_ms("2026-07-29T10:03:10.612Z").unwrap();
        assert_eq!(ms, days_from_civil(2026, 7, 29) * 86_400_000 + 10 * 3_600_000 + 3 * 60_000 + 10_612);
    }

    #[test]
    fn records_drive_the_state_machine() {
        let mgr = manager();
        let mut inner = lock(&mgr.inner);
        let info = AgentInfo {
            id: "ag_1".into(),
            chat_id: "c1".into(),
            project: "p".into(),
            project_path: "C:/p".into(),
            title: "t".into(),
            task: "do it".into(),
            session_id: "s1".into(),
            state: STATE_STARTING.into(),
            created_at: 0,
            updated_at: 0,
            finished_at: None,
            steps: 0,
            last_step: None,
            last_message: None,
            error: None,
            question: None,
        };
        inner.agents.insert(
            "ag_1".into(),
            Entry {
                info,
                tx: None,
                pid: None,
            },
        );
        drop(inner);

        let running = serde_json::json!({"type":"agent_start"});
        assert!(apply_record(&mgr.inner, "ag_1", &running).is_none());
        assert_eq!(
            lock(&mgr.inner).agents["ag_1"].info.state,
            STATE_RUNNING
        );

        let tool = serde_json::json!({
            "type":"tool_execution_start","toolName":"bash","args":{"command":"cargo test"}
        });
        apply_record(&mgr.inner, "ag_1", &tool);
        {
            let guard = lock(&mgr.inner);
            let info = &guard.agents["ag_1"].info;
            assert_eq!(info.steps, 1);
            assert!(info.last_step.as_deref().unwrap_or("").contains("cargo test"));
        }

        let question = serde_json::json!({
            "type":"extension_ui_request","id":"q1","method":"select",
            "title":"Which database?","options":["Postgres","SQLite"]
        });
        assert!(apply_record(&mgr.inner, "ag_1", &question).is_some());
        {
            let guard = lock(&mgr.inner);
            let info = &guard.agents["ag_1"].info;
            assert_eq!(info.state, STATE_NEEDS_INPUT);
            assert_eq!(info.question.as_ref().unwrap().options.len(), 2);
        }

        let settled = serde_json::json!({"type":"agent_settled","aborted":false});
        apply_record(&mgr.inner, "ag_1", &settled);
        assert_eq!(lock(&mgr.inner).agents["ag_1"].info.state, STATE_IDLE);
    }


    #[tokio::test]
    async fn quitting_kills_live_agents() {
        let base = std::env::temp_dir().join(format!("hook-agent-quit-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("fake-pi.mjs"), include_str!("../tests/fixtures/fake-pi.mjs")).unwrap();
        let shim = base.join("fake-pi.cmd");
        std::fs::write(&shim, "@echo off
node \"%~dp0fake-pi.mjs\" %*
").unwrap();

        let settings = Arc::new(SettingsStore::new(&base));
        settings.set_pi_command(Some(&shim.to_string_lossy())).unwrap();
        let projects = Arc::new(ProjectsStore::new(&base));
        let root = settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        projects.create(&root, "demo", "").unwrap();

        let (tx, _rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(&base, CodingConfig::default(), settings, projects, tx);
        let info = mgr.start("chat-1", "demo", "do a thing", None, None).unwrap();
        assert!(mgr.get(&info.id).unwrap().is_live());

        mgr.kill_all_sync();

        let after = mgr.get(&info.id).unwrap();
        assert_eq!(after.state, STATE_INTERRUPTED);
        assert!(after.error.is_some());
        assert_eq!(mgr.live_count(), 0);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[tokio::test]
    async fn fake_pi_agent_runs_settles_and_wakes_the_chat() {
        use std::time::Duration as StdDuration;

        let base = std::env::temp_dir().join(format!("hook-agent-run-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();

        // A .cmd shim so the manager launches it exactly like a real npm shim.
        let script = base.join("fake-pi.mjs");
        std::fs::write(
            &script,
            include_str!("../tests/fixtures/fake-pi.mjs"),
        )
        .unwrap();
        let shim = base.join("fake-pi.cmd");
        std::fs::write(
            &shim,
            format!("@echo off
node \"%~dp0fake-pi.mjs\" %*
"),
        )
        .unwrap();

        let settings = Arc::new(SettingsStore::new(&base));
        settings
            .set_pi_command(Some(&shim.to_string_lossy()))
            .unwrap();
        let projects = Arc::new(ProjectsStore::new(&base));
        // Keep the test inside its own temp tree.
        let root = settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        projects.create(&root, "demo", "test project").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(&base, CodingConfig::default(), settings, projects, tx);

        let info = mgr
            .start("chat-1", "demo", "Add the login page", Some("login"), None)
            .expect("agent should start");
        assert_eq!(info.state, STATE_STARTING);
        assert_eq!(mgr.working_count(), 1);

        // Wait for the settle signal, then check the recorded state.
        let mut woke = false;
        let deadline = tokio::time::Instant::now() + StdDuration::from_secs(10);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(StdDuration::from_millis(300), rx.recv()).await {
                Ok(Some(Signal::Wake(wake))) => {
                    if wake.agent_id == info.id {
                        woke = true;
                        break;
                    }
                }
                Ok(Some(Signal::Changed)) | Ok(None) => {}
                Err(_) => {}
            }
        }
        assert!(woke, "the settle should have woken the chat");
        assert_eq!(mgr.working_count(), 0);

        let settled = mgr.get(&info.id).unwrap();
        assert_eq!(settled.state, STATE_IDLE);
        assert_eq!(settled.steps, 1);
        assert!(settled
            .last_message
            .as_deref()
            .unwrap_or_default()
            .contains("three files"));
        assert!(settled
            .last_step
            .as_deref()
            .unwrap_or_default()
            .contains("echo hello"));

        // Stopping a live agent records it as stopped rather than failed.
        mgr.stop(&info.id).unwrap();
        let stopped = mgr.get(&info.id).unwrap();
        assert_eq!(stopped.state, STATE_STOPPED);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn interrupted_agents_are_marked_on_restart() {
        let base = std::env::temp_dir().join(format!("hook-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let raw = serde_json::json!({
            "agents": [{
                "id": "ag_x", "chatId": "c1", "project": "p", "projectPath": "C:/p",
                "title": "t", "task": "x", "sessionId": "s", "state": "running",
                "createdAt": 1, "updatedAt": 1, "steps": 0
            }]
        });
        std::fs::write(base.join("agents.json"), raw.to_string()).unwrap();

        let settings = Arc::new(SettingsStore::new(&base));
        let projects = Arc::new(ProjectsStore::new(&base));
        let (tx, _rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(&base, CodingConfig::default(), settings, projects, tx);
        let info = mgr.get("ag_x").unwrap();
        assert_eq!(info.state, STATE_INTERRUPTED);
        assert!(info.error.is_some());
    }
}
