use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::mpsc;

use crate::auth::AuthStore;
use crate::config::CodingConfig;
use crate::git::{self, GitRuntime};
use crate::projects::ProjectsStore;
use crate::config::HarnessConfig;
use crate::runtime::PiRuntime;
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

/// Checklist states the user sees at the bottom of the chat.
pub const STEP_PENDING: &str = "pending";
pub const STEP_ACTIVE: &str = "active";
pub const STEP_DONE: &str = "done";

/// A run may grow its checklist, but not without bound.
pub const MAX_PLAN_STEPS: usize = 12;
const MAX_STEP_TITLE: usize = 90;

/// One item of the plan the user watches while the coding agent works. The
/// chat agent writes the wording (plain, non-technical); the coding agent only
/// moves each step between `pending`, `active` and `done`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanStep {
    pub title: String,
    #[serde(default = "pending_step")]
    pub status: String,
    /// When this step was first seen in progress, in epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<i64>,
    /// When this step crossed into done, in epoch ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
}

fn pending_step() -> String {
    STEP_PENDING.to_string()
}

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
    /// The user-facing checklist for this run, in display order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub plan: Vec<PlanStep>,
    /// The run is driven by the user's own conversation rather than by the
    /// chat agent. Nobody has to be woken for it, and it never appears in the
    /// sidebar's coding-agent tree (it is already a chat).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub direct: bool,
    /// The machine this process runs on. Every run names its machine, even
    /// when it is the only one, so a conversation read elsewhere still says
    /// where the work happened.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_name: String,
}

impl AgentInfo {
    pub fn is_live(&self) -> bool {
        matches!(
            self.state.as_str(),
            STATE_STARTING | STATE_RUNNING | STATE_NEEDS_INPUT | STATE_IDLE
        )
    }

    /// Working or blocked on a question: still the user's current task, as
    /// opposed to an idle process kept warm for a cheap follow-up.
    pub fn is_active(&self) -> bool {
        matches!(
            self.state.as_str(),
            STATE_STARTING | STATE_RUNNING | STATE_NEEDS_INPUT
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

/// What the UI needs to draw the working panel. Deliberately smaller than
/// `AgentInfo`: the brief and the run's last message stay between Hook and the
/// chat agent.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentSummary {
    pub id: String,
    pub chat_id: String,
    pub title: String,
    pub project: String,
    pub state: String,
    pub steps: u32,
    pub plan: Vec<PlanStep>,
    pub created_at: i64,
    pub updated_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub waiting: bool,
    /// The user talks to this agent directly in its own chat.
    pub direct: bool,
    /// The question this run is blocked on, when it is waiting for a person.
    /// Only a directly-driven agent shows it: the chat agent relays its own.
    pub question: Option<AgentQuestion>,
    /// The machine that owns this run.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub device_name: String,
}

/// The whole picture for the title-bar indicator and the per-chat task board.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    pub working: usize,
    pub live: usize,
    pub agents: Vec<AgentSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub preview: String,
}

/// One entry in a coding agent's transcript, as the advanced inspector draws
/// it. The conversation and the inspector share the renderer, so the shape is
/// deliberately small: what was thought, what was said, what was run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptItem {
    pub id: String,
    /// `user`, `text`, `thinking` or `tool`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Tool name for `kind: "tool"`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The tool's arguments, already parsed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<serde_json::Value>,
    /// What the tool returned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub is_error: bool,
    /// `running`, `done` or `error`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscript {
    pub id: String,
    pub title: String,
    pub project: String,
    pub state: String,
    /// The run still has a live process (it may be idle but kept warm for a
    /// follow-up). The inspector uses the state to decide whether to poll.
    pub live: bool,
    pub items: Vec<TranscriptItem>,
    /// Older entries were dropped to keep the payload bounded.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub truncated: bool,
}

/// Bounded on purpose: a long run can produce thousands of chunks and a tool
/// can print megabytes. The inspector is for reading, not archiving.
const MAX_TRANSCRIPT_ITEMS: usize = 600;
const MAX_TRANSCRIPT_TEXT: usize = 12_000;
const MAX_TRANSCRIPT_OUTPUT: usize = 16_000;

/// The assistant message currently streaming, plus tool calls that have not
/// reached the session file yet. Kept in memory only: the file on disk is the
/// source of truth once a message ends.
#[derive(Debug, Clone, Default)]
struct LiveTranscript {
    thinking: String,
    text: String,
    tools: Vec<TranscriptItem>,
}

/// One progress note a coding agent sent, with any pictures it attached.
#[derive(Debug, Clone)]
pub struct Update {
    pub note: String,
    pub images: Vec<std::path::PathBuf>,
}

/// One page a coding agent asked Hook to show in the preview panel.
#[derive(Debug, Clone)]
pub struct PreviewReport {
    pub agent_id: String,
    pub file: String,
    pub title: String,
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
    /// A coding agent pointed the preview panel at a page.
    Preview(PreviewReport),
    /// One pi RPC record from a directly-driven agent, for its own chat. The
    /// chat app turns these into messages; the chat agent never sees them.
    Record {
        chat_id: String,
        agent_id: String,
        record: serde_json::Value,
    },
}

enum AgentCmd {
    Line(serde_json::Value),
    Kill,
}

struct Entry {
    info: AgentInfo,
    tx: Option<mpsc::UnboundedSender<AgentCmd>>,
    /// PID of the spawned process, for tree termination on quit.
    pid: Option<u32>,
    /// Progress notes waiting to be batched for the chat agent.
    pending: Vec<Update>,
    /// Settled / failed / asked something: deliver on the next tick.
    wake_pending: bool,
    /// When the last batch went to the chat, for the update interval.
    last_flush_at: i64,
    /// True once the chat has actually received a note from this run. A settle
    /// that finds this false must not be swallowed: nobody has heard anything.
    delivered: bool,
    /// The last assistant turn was cut off at the output limit.
    truncated: bool,
    /// Thinking and tools the advanced inspector can already see, before pi
    /// has flushed the completed message into the session file.
    live: LiveTranscript,
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
    cfg: Arc<HarnessConfig>,
    /// Whether the model card says images are supported. Read when writing
    /// `models.json`, so the engine advertises what the model can actually do.
    vision: Arc<std::sync::atomic::AtomicBool>,
    engine: Result<PiRuntime, String>,
    settings: Arc<SettingsStore>,
    projects: Arc<ProjectsStore>,
    signal_tx: mpsc::UnboundedSender<Signal>,
    /// Who is signed in, so every coding agent gets the current proxy token.
    /// `new` installs a local-preview (always signed in) store; production
    /// replaces it with the real one via `with_auth`.
    auth: Arc<AuthStore>,
    /// The bundled git, when present. Agents get it on PATH together with a
    /// managed global config that carries the git-scoped token.
    git: Option<GitRuntime>,
    /// The loopback endpoint that executes the chat agent's tools for a
    /// directly-driven coding agent (memory, projects, Workspace). Absent in
    /// tests and in builds that never serve it.
    bridge: Option<Arc<crate::bridge::ToolBridge>>,
    /// What this product's coding agents may do. Only a directly-driven agent
    /// reads it, to decide which of the chat agent's tools it gets.
    capabilities: crate::Capabilities,
    /// The account's memory, so a direct agent starts with what Hook already
    /// remembers about the user. Optional: a test manager has none.
    memory: Option<Arc<crate::memory::MemoryStore>>,
    /// This machine's id and the name the account knows it by. The name can be
    /// changed from another device, so it is updated when the relay's `ready`
    /// frame arrives.
    device_id: String,
    device_name: Mutex<String>,
}

impl AgentManager {
    pub fn new(
        data_dir: &Path,
        cfg: Arc<HarnessConfig>,
        vision: Arc<std::sync::atomic::AtomicBool>,
        engine: Result<PiRuntime, String>,
        settings: Arc<SettingsStore>,
        projects: Arc<ProjectsStore>,
        signal_tx: mpsc::UnboundedSender<Signal>,
    ) -> Self {
        let coding = cfg.coding.clone();
        let sessions_dir = data_dir.join("agent-sessions");
        let _ = std::fs::create_dir_all(&sessions_dir);

        let mut inner = Inner::default();
        if let Ok(raw) = std::fs::read_to_string(data_dir.join("agents.json")) {
            if let Ok(file) = serde_json::from_str::<AgentsFile>(&raw) {
                for mut info in file.agents {
                    // Nothing can still be running: children die with the app.
                    if info.is_live() {
                        info.state = STATE_INTERRUPTED.to_string();
                        info.finished_at = Some(now_ms());
                        info.updated_at = now_ms();
                        info.error = Some("Hook closed while this agent was working.".into());
                    }
                    inner.agents.insert(
                        info.id.clone(),
                        Entry {
                            info,
                            tx: None,
                            pid: None,
                            pending: Vec::new(),
                            wake_pending: false,
                            last_flush_at: now_ms(),
                            delivered: false,
                            truncated: false,
                            live: LiveTranscript::default(),
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
            cfg,
            vision,
            engine,
            settings,
            projects,
            signal_tx,
            auth: Arc::new(AuthStore::new(data_dir, "https://hookcode.io", false, "")),
            git: None,
            bridge: None,
            capabilities: crate::Capabilities::chat(),
            memory: None,
            device_id: String::new(),
            device_name: Mutex::new(crate::devices::default_name()),
        }
    }

    /// Use the real account store instead of the local-preview placeholder.
    pub fn with_auth(mut self, auth: Arc<AuthStore>) -> Self {
        self.device_id = auth.device_id().to_string();
        self.auth = auth;
        self
    }

    /// The account renamed this machine (or the first `ready` frame told us the
    /// name it already had). Runs that are already recorded carry the old name;
    /// new ones use this.
    pub fn set_device_name(&self, name: &str) {
        let name = name.trim();
        if name.is_empty() {
            return;
        }
        *lock(&self.device_name) = name.to_string();
        let mut inner = lock(&self.inner);
        for entry in inner.agents.values_mut() {
            entry.info.device_name = name.to_string();
        }
    }

    pub fn device_name(&self) -> String {
        lock(&self.device_name).clone()
    }

    /// The account's id for this machine, shared by every product it runs.
    pub fn device_id(&self) -> String {
        self.device_id.clone()
    }

    /// Provide the bundled git (or a developer fallback).
    pub fn with_git(mut self, git: Option<GitRuntime>) -> Self {
        self.git = git;
        self
    }

    /// Where a directly-driven agent's tool calls are executed. Without it the
    /// agent still runs; it just gets the coding agent's own tools.
    pub fn with_bridge(mut self, bridge: Arc<crate::bridge::ToolBridge>) -> Self {
        self.bridge = Some(bridge);
        self
    }

    /// Which of the chat agent's tools a direct agent may be offered.
    pub fn with_capabilities(mut self, capabilities: crate::Capabilities) -> Self {
        self.capabilities = capabilities;
        self
    }

    /// The shared memory store, so a direct agent's prompt carries what Hook
    /// already knows about the user.
    pub fn with_memory(mut self, memory: Arc<crate::memory::MemoryStore>) -> Self {
        self.memory = Some(memory);
        self
    }

    /// Folder the guard writes `u-*.json` progress files into.
    pub fn updates_dir(&self, agent_id: &str) -> PathBuf {
        self.data_dir.join("updates").join(agent_id)
    }

    /// Collect whatever the agents have written since the last tick: progress
    /// notes, pictures, checklist updates and preview pointers from the guard.
    pub fn harvest(&self) {
        let ids: Vec<String> = lock(&self.inner)
            .agents
            .values()
            .filter(|e| e.tx.is_some() || !e.pending.is_empty())
            .map(|e| e.info.id.clone())
            .collect();

        for id in ids {
            let dir = self.updates_dir(&id);
            let Ok(entries) = std::fs::read_dir(&dir) else {
                continue;
            };
            let mut files: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.file_name()
                        .map(|n| {
                            let name = n.to_string_lossy();
                            name.starts_with("u-") || name.starts_with("p-") || name.starts_with("v-")
                        })
                        .unwrap_or(false)
                        && p.extension().and_then(|e| e.to_str()) == Some("json")
                })
                .collect();
            if files.is_empty() {
                continue;
            }
            files.sort();

            let mut harvested: Vec<Update> = Vec::new();
            // The plan the guard wrote last, with the moment it wrote it.
            let mut newest_plan: Option<(Vec<PlanStep>, i64)> = None;
            // The page the guard pointed the preview panel at, newest wins.
            let mut newest_preview: Option<PreviewReport> = None;
            for file in files {
                let name = file
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_default();
                let is_plan = name.starts_with("p-");
                let is_preview = name.starts_with("v-");
                let parsed = std::fs::read_to_string(&file)
                    .ok()
                    .and_then(|raw| serde_json::from_str::<serde_json::Value>(&raw).ok());

                if is_preview {
                    if let Some(value) = parsed {
                        let shown = value
                            .get("file")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        let title = value
                            .get("title")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                            .trim()
                            .to_string();
                        if !shown.is_empty() {
                            newest_preview = Some(PreviewReport {
                                agent_id: id.clone(),
                                file: shown,
                                title,
                            });
                        }
                    }
                    let _ = std::fs::remove_file(&file);
                    continue;
                }

                if is_plan {
                    // Files are written in timestamp order, so the last one in
                    // the sorted list is the state the agent means now.
                    if let Some(value) = parsed {
                        let at = value
                            .get("at")
                            .and_then(|v| v.as_i64())
                            .unwrap_or_else(now_ms);
                        if let Some(plan) = plan_from_value(&value) {
                            newest_plan = Some((plan, at));
                        }
                    }
                    let _ = std::fs::remove_file(&file);
                    continue;
                }

                if let Some(value) = parsed {
                    let note = value
                        .get("note")
                        .and_then(|n| n.as_str())
                        .unwrap_or_default()
                        .trim()
                        .to_string();
                    let images: Vec<PathBuf> = value
                        .get("images")
                        .and_then(|i| i.as_array())
                        .map(|items| {
                            items
                                .iter()
                                .filter_map(|i| i.as_str())
                                .map(|path| dir.join("files").join(path))
                                .filter(|path| path.is_file())
                                .collect()
                        })
                        .unwrap_or_default();
                    if !note.is_empty() || !images.is_empty() {
                        harvested.push(Update { note, images });
                    }
                }
                let _ = std::fs::remove_file(&file);
            }

            if harvested.is_empty() && newest_plan.is_none() && newest_preview.is_none() {
                continue;
            }

            let plan_changed = {
                let mut inner = lock(&self.inner);
                let mut changed = false;
                if let Some(entry) = inner.agents.get_mut(&id) {
                    entry.pending.extend(harvested);
                    if let Some((plan, at)) = newest_plan {
                        // Every update rewrites the whole checklist, so the
                        // clocks have to be carried over by hand.
                        let plan = merge_plan_times(&entry.info.plan, plan, at);
                        if entry.info.plan != plan {
                            entry.info.plan = plan;
                            entry.info.updated_at = now_ms();
                            changed = true;
                        }
                    }
                }
                if changed {
                    persist(&self.data_dir, &inner);
                }
                changed
            };

            // A checklist update is for the eye, not for the chat agent: it
            // must not wake the model, only refresh the task board.
            if plan_changed {
                let _ = self.signal_tx.send(Signal::Changed);
            }
            if let Some(report) = newest_preview {
                let _ = self.signal_tx.send(Signal::Preview(report));
            }
        }
    }

    /// Hand progress to the chat: every `interval`, or right away when the
    /// agent stopped working or needs an answer.
    pub fn flush_due(&self, interval: std::time::Duration) {
        let now = now_ms();
        let interval_ms = interval.as_millis() as i64;
        let due: Vec<String> = {
            let inner = lock(&self.inner);
            inner
                .agents
                .values()
                .filter(|entry| {
                    // A directly-driven agent has no chat agent to wake: its
                    // conversation is written by the records themselves.
                    if entry.info.direct {
                        return false;
                    }
                    if entry.wake_pending {
                        return true;
                    }
                    !entry.pending.is_empty()
                        && (!entry.info.is_live() || now - entry.last_flush_at >= interval_ms)
                })
                .map(|entry| entry.info.id.clone())
                .collect()
        };

        for id in due {
            {
                let mut inner = lock(&self.inner);
                let Some(entry) = inner.agents.get_mut(&id) else {
                    continue;
                };
                entry.wake_pending = false;
                entry.last_flush_at = now;
            }
            let _ = self
                .signal_tx
                .send(Signal::Wake(Wake { agent_id: id.clone() }));
        }
    }

    /// Whether this run already reported something to its chat. Used to tell a
    /// duplicate "finished" wake from the first news the user gets.
    pub fn delivered_progress(&self, agent_id: &str) -> bool {
        lock(&self.inner)
            .agents
            .get(agent_id)
            .map(|entry| entry.delivered)
            .unwrap_or(false)
    }

    /// Drain the notes queued for one agent (called when a wake is delivered).
    pub fn take_updates(&self, agent_id: &str) -> Vec<Update> {
        let mut inner = lock(&self.inner);
        inner
            .agents
            .get_mut(agent_id)
            .map(|entry| {
                let updates = std::mem::take(&mut entry.pending);
                if !updates.is_empty() {
                    entry.delivered = true;
                }
                updates
            })
            .unwrap_or_default()
    }

    pub fn get(&self, agent_id: &str) -> Option<AgentInfo> {
        lock(&self.inner).agents.get(agent_id).map(|e| e.info.clone())
    }

    /// The run the user is talking to in one conversation, newest first. A
    /// coding-agent chat has one direct agent at a time; older ones are history.
    pub fn for_chat(&self, chat_id: &str) -> Option<AgentInfo> {
        lock(&self.inner)
            .agents
            .values()
            .filter(|entry| entry.info.chat_id == chat_id && entry.info.direct)
            .max_by_key(|entry| entry.info.created_at)
            .map(|entry| entry.info.clone())
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

    /// Counts for the title-bar pill plus the summaries the task board draws.
    pub fn overview(&self) -> Overview {
        let inner = lock(&self.inner);
        let mut agents: Vec<AgentSummary> = inner
            .agents
            .values()
            .map(|entry| {
                let info = &entry.info;
                AgentSummary {
                    id: info.id.clone(),
                    chat_id: info.chat_id.clone(),
                    title: info.title.clone(),
                    project: info.project.clone(),
                    state: info.state.clone(),
                    steps: info.steps,
                    plan: info.plan.clone(),
                    created_at: info.created_at,
                    updated_at: info.updated_at,
                    finished_at: info.finished_at,
                    error: info.error.clone(),
                    waiting: info.question.is_some() || info.state == STATE_NEEDS_INPUT,
                    direct: info.direct,
                    question: info.question.clone(),
                    device_id: info.device_id.clone(),
                    device_name: info.device_name.clone(),
                }
            })
            .collect();
        agents.sort_by_key(|a| a.created_at);
        // `agents.json` keeps every run for resumability. The board only ever
        // needs the recent tail, so an old install does not ship its whole
        // history to the UI on every heartbeat.
        if agents.len() > 60 {
            agents.drain(..agents.len() - 60);
        }
        Overview {
            working: inner.agents.values().filter(|e| e.info.is_working()).count(),
            live: inner.agents.values().filter(|e| e.info.is_live()).count(),
            agents,
        }
    }

    /// Launch a coding agent inside one of the user's projects, on behalf of
    /// the chat agent.
    pub fn start(
        &self,
        chat_id: &str,
        project_ref: &str,
        task: &str,
        title: Option<&str>,
        resume_session: Option<&str>,
        plan_titles: &[String],
    ) -> Result<AgentInfo, String> {
        let root = self.settings.projects_dir();
        let project_path = self.projects.resolve(&root, project_ref)?;
        let project_name = project_path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| project_ref.to_string());
        // The account id is what names the project's repository. Listing first
        // also assigns ids to folders that predate sync.
        let _ = self.projects.list(&root);
        let project_id = self.projects.id_for_path(&project_path).unwrap_or_default();
        self.spawn(
            chat_id,
            project_path,
            project_name,
            project_id,
            task,
            title,
            resume_session,
            plan_titles,
            false,
            None,
        )
    }

    /// Launch a coding agent in a folder the user picked themselves. This is
    /// the direct conversation: no chat agent writes the brief or the checklist,
    /// the user is talking to `pi`.
    pub fn start_direct(
        &self,
        chat_id: &str,
        folder: &str,
        task: &str,
        title: Option<&str>,
        resume_session: Option<&str>,
    ) -> Result<AgentInfo, String> {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err("A coding agent needs a folder to work in.".into());
        }
        let path = PathBuf::from(folder);
        if !path.is_absolute() {
            return Err("The coding agent's folder must be a full path.".into());
        }
        let path = path
            .canonicalize()
            .map_err(|_| format!("The folder \"{folder}\" is not available on this computer."))?;
        if !path.is_dir() {
            return Err(format!("\"{folder}\" is not a folder."));
        }
        let path = crate::store::strip_verbatim(path);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Coding agent".to_string());
        // A folder inside the projects root is still a project: it keeps its
        // account repository and the sync tools. Anything else runs as it is.
        let project_id = self.projects.id_for_path(&path).unwrap_or_default();
        self.spawn(
            chat_id,
            path,
            name,
            project_id,
            task,
            title,
            resume_session,
            &[],
            true,
            None,
        )
    }

    /// Start the direct agent for a chat just to compact its session: no prompt,
    /// only pi's `compact` command. Nothing to say means a resume of an existing
    /// session — the chat has to have one, or there is nothing to compact.
    pub fn start_compact(
        &self,
        chat_id: &str,
        folder: &str,
        title: Option<&str>,
        session: Option<&str>,
        instructions: Option<&str>,
    ) -> Result<AgentInfo, String> {
        let folder = folder.trim();
        if folder.is_empty() {
            return Err("A coding agent needs a folder to work in.".into());
        }
        let path = PathBuf::from(folder)
            .canonicalize()
            .map_err(|_| format!("The folder \"{folder}\" is not available on this computer."))?;
        if !path.is_dir() {
            return Err(format!("\"{folder}\" is not a folder."));
        }
        let path = crate::store::strip_verbatim(path);
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "Coding agent".to_string());
        let project_id = self.projects.id_for_path(&path).unwrap_or_default();
        self.spawn(
            chat_id,
            path,
            name,
            project_id,
            "",
            title,
            session,
            &[],
            true,
            Some(serde_json::json!({
                "id": next_id("compact"),
                "type": "compact",
                "customInstructions": instructions,
            })),
        )
    }

    /// Ask a live direct agent to compact its session. pi aborts whatever it is
    /// running first, so this is only offered while the agent is settled.
    pub fn compact(
        &self,
        agent_id: &str,
        instructions: Option<&str>,
    ) -> Result<AgentInfo, String> {
        let (info, tx) = {
            let inner = lock(&self.inner);
            let entry = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| format!("No agent {agent_id}"))?;
            (entry.info.clone(), entry.tx.clone())
        };
        let tx = tx.ok_or("That coding agent is no longer running.")?;
        if info.is_working() {
            return Err("Let the agent finish before compacting the conversation.".into());
        }
        if info.question.is_some() {
            return Err("That agent is waiting for an answer. Answer it first.".into());
        }
        tx.send(AgentCmd::Line(serde_json::json!({
            "id": next_id("compact"),
            "type": "compact",
            "customInstructions": instructions,
        })))
        .map_err(|_| "That coding agent is no longer running.".to_string())?;
        self.set_state(agent_id, STATE_RUNNING, |info| {
            info.updated_at = now_ms();
            info.last_step = Some("Compacting the conversation".into());
        });
        Ok(self.get(agent_id).unwrap_or(info))
    }

    #[allow(clippy::too_many_arguments)]
    fn spawn(
        &self,
        chat_id: &str,
        project_path: PathBuf,
        project_name: String,
        project_id: String,
        task: &str,
        title: Option<&str>,
        resume_session: Option<&str>,
        plan_titles: &[String],
        direct: bool,
        kick: Option<serde_json::Value>,
    ) -> Result<AgentInfo, String> {
        let task = task.trim();
        if task.is_empty() && kick.is_none() {
            return Err(if direct {
                "Say something for the coding agent to do.".into()
            } else {
                "The coding agent needs a task.".into()
            });
        }
        if let Some(id) = resume_session {
            if !is_safe_session_id(id) {
                return Err(format!("Invalid session id: {id}"));
            }
        }

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

        let engine = self.engine.clone().map_err(|e| e)?;
        // A free account has no coding agents unless it brought its own model
        // endpoint. Checked before anything is spawned, so a stale window cannot
        // start one either.
        if self.auth.is_free() && self.settings.custom_provider().is_none() {
            return Err(
                "Coding agents are part of a paid plan. Add your own model provider in Settings to use one."
                    .into(),
            );
        }
        // A folder still works without this, but its account repository is cloud
        // data like a conversation: free accounts and an off switch mean no git
        // remote, no sync tools and no credential.
        let git_allowed = !self.auth.is_free() && self.auth.cloud_sync() != Some(false);
        let project_id = if git_allowed { project_id } else { String::new() };
        let account_token = self
            .auth
            .token()
            .ok_or("Sign in to Hook to start a coding agent.")?;
        // Which endpoint this run talks to. With a personal provider the engine
        // gets that URL, model and key instead of Hook's proxy.
        let target = crate::provider::ProviderTarget::resolve(
            &self.cfg,
            self.settings.custom_provider().as_ref(),
            Some(account_token.clone()),
        )?;
        let guard = crate::guard::ensure(&self.data_dir)?;

        let session_id = resume_session
            .map(str::to_string)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let id = format!("ag_{}", uuid::Uuid::new_v4().simple());

        // One shared config directory, but per-process `$HOOK_CHAT_ID` /
        // `$HOOK_AGENT_ID` headers and token. The file content is identical
        // for every agent and written atomically, so concurrent starts cannot
        // see a half-written models.json.
        // Written on every start so a rebuilt app always drives the engine
        // with the provider compiled into it.
        crate::runtime::write_agent_home(
            &engine,
            &target.cfg,
            self.vision.load(std::sync::atomic::Ordering::Relaxed),
            target.byok,
        )?;
        let title = title
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .map(|t| truncate(t, 60))
            .unwrap_or_else(|| truncate(task, 60));
        // The chat agent's plain-language steps seed the checklist the user
        // watches. The coding agent fills in the status as it goes.
        let plan = merge_plan_times(&[], plan_from_titles(plan_titles), now_ms());

        let args = agent_args(
            &self.sessions_dir,
            &session_id,
            &title,
            &guard,
            &crate::runtime::model_ref(&target.cfg),
            // The coding agent gets its own thinking level, not the chat model's.
            // A chat turn is one answer; a run is dozens of small turns, and a
            // high level on every one of them makes a five-minute job take
            // twenty, with the user's checklist frozen while the model thinks.
            // Unset means pi's own default (medium): `[coding] thinking` is the
            // one knob that decides this. A personal endpoint clears it.
            target.cfg.coding.thinking(),
        );

        // Where the agent's guard writes progress notes for Hook to collect.
        let updates_dir = crate::store::strip_verbatim(&self.updates_dir(&id));
        let _ = std::fs::create_dir_all(&updates_dir);
        // The guard reads this to tell the coding agent which checklist the
        // user is looking at, so it keeps the chat agent's wording.
        let _ = std::fs::write(
            updates_dir.join("plan.json"),
            serde_json::json!({ "steps": &plan }).to_string(),
        );

        // A directly-driven agent gets the chat agent's tools (memory,
        // projects, Workspace) over Hook's loopback bridge. The guard finds the
        // endpoint and the tool list in the same mailbox.
        if direct {
            if let Some(bridge) = &self.bridge {
                // What the agent may do is decided here, where the config, the
                // product and the memory switch already are; the bridge only
                // writes it down and runs the calls.
                let memory = self.cfg.memory.enabled && self.settings.memory_enabled();
                let tools =
                    crate::tools::direct_bridge_definitions(&self.cfg, self.capabilities, memory);
                let remembered = if memory {
                    self.memory.as_ref().map(|store| store.marker_frame())
                } else {
                    None
                };
                bridge.prepare(chat_id, &updates_dir, tools, remembered);
            }
        }

        // Keep the engine's stderr: when it dies before doing anything, this
        // file is the only thing that explains why.
        let log_dir = self.data_dir.join("logs");
        let _ = std::fs::create_dir_all(&log_dir);
        let log_path = log_dir.join(format!("engine-{id}.log"));
        let stderr = std::fs::File::create(&log_path)
            .map(std::process::Stdio::from)
            .unwrap_or_else(|_| std::process::Stdio::null());

        // The managed git config carries the account's git-scoped token. It is
        // rewritten every start so a refreshed token is picked up, and the
        // token never lands in a project or a remote URL.
        let git_config = self
            .data_dir
            .join("agent-home")
            .join("gitconfig");
        if let Some(git) = &self.git {
            let git_token = if git_allowed {
                self.auth.git_token()
            } else {
                None
            };
            if let Err(error) = crate::git::write_agent_config(
                &self.data_dir.join("agent-home"),
                &self.cfg.auth.base_url,
                git_token.as_deref(),
            ) {
                eprintln!("hook: git config unavailable: {error}");
            }
            if !project_id.is_empty() {
                if let Err(error) = git::prepare_project(
                    git,
                    &git_config,
                    &project_path,
                    &self.cfg.auth.base_url,
                    &project_id,
                ) {
                    eprintln!("hook: could not prepare the project repository: {error}");
                }
            }
        }

        let mut command = build_command(&engine, &args);
        command
            .current_dir(&project_path)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(stderr)
            // The engine's own config directory: Hook's provider, nobody else's.
            .env("PI_CODING_AGENT_DIR", &engine.agent_home)
            // models.json references these instead of containing the token, so
            // concurrent agents can each report their own chat and run ids. The
            // provider token is whichever credential the resolved target uses
            // (the account's, or the user's own key); the account token stays in
            // `HOOK_API_TOKEN` because the guard's web search needs it.
            .env("HOOK_PROVIDER_TOKEN", &target.token)
            .env("HOOK_API_TOKEN", &account_token)
            .env("HOOK_CHAT_ID", chat_id)
            .env("HOOK_AGENT_ID", &id)
            // The app's own WebView2 flags are none of the agent's business:
            // a debug port in its environment is an invitation to drive the
            // window it runs inside.
            .env_remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
            .env("HOOK_UPDATES_DIR", &updates_dir)
            .env("HOOK_DIRECT", if direct { "1" } else { "0" })
            // Whether this folder is one of the account's projects, so the
            // guard only advertises the git tools where they can work.
            .env("HOOK_SYNC", if project_id.is_empty() { "0" } else { "1" })
            .env("PI_BASH_MAX_TIMEOUT", self.coding.bash_max_timeout.to_string())
            .env("PI_BASH_MIN_TIMEOUT", self.coding.bash_min_timeout.to_string());
        if let Some(git) = &self.git {
            // `git` resolves to Hook's own copy, and GIT_CONFIG_GLOBAL points
            // at the managed file so a project cannot inherit the user's git
            // identity, remotes or credential helper.
            for (key, value) in git::env(git, &git_config) {
                command.env(key, value);
            }
        }
        if self.cfg.auth.required {
            // The guard's web_search tool calls Hook's account service, which
            // owns the provider key. Standalone/mock builds do not get it.
            command.env("HOOK_API_BASE", self.cfg.auth.base_url.trim_end_matches('/'));
        }

        let mut child = command.spawn().map_err(|e| {
            format!("Could not start the coding engine ({}): {e}", engine.describe())
        })?;

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
            plan,
            direct,
            device_id: self.device_id.clone(),
            device_name: self.device_name(),
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
                    pending: Vec::new(),
                    wake_pending: false,
                    last_flush_at: now_ms(),
                    delivered: false,
                    truncated: false,
                    live: LiveTranscript::default(),
                },
            );
            persist(&self.data_dir, &inner);
        }
        let _ = self.signal_tx.send(Signal::Changed);

        // Kick off the run. A compaction is the one start that has nothing to
        // say: it replays the session and asks pi to summarize it.
        let line = kick.unwrap_or_else(|| {
            serde_json::json!({
                "id": next_id("prompt"),
                "type": "prompt",
                "message": task,
            })
        });
        let _ = tx.send(AgentCmd::Line(line));

        let inner = self.inner.clone();
        let data_dir = self.data_dir.clone();
        let signal_tx = self.signal_tx.clone();
        let settings = self.settings.clone();
        let bridge = if direct { self.bridge.clone() } else { None };
        let chat_id = chat_id.to_string();
        // The app runtime, not `tokio::spawn`: a coding agent can be started
        // from a synchronous IPC command (the user's own message in a
        // coding-agent chat), where this thread has no Tokio context and
        // `tokio::spawn` panics with "there is no reactor running".
        tauri::async_runtime::spawn(async move {
            drive(
                id, chat_id, inner, data_dir, signal_tx, settings, child, stdin, stdout, rx, direct,
                bridge,
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
                    // The step it was on did not finish; leave it open so the
                    // board does not claim work that was thrown away.
                    for step in info.plan.iter_mut() {
                        if step.status == STEP_ACTIVE {
                            step.status = STEP_PENDING.to_string();
                            step.started_at = None;
                            step.finished_at = None;
                        }
                    }
                    info.question = None;
                    info.updated_at = now_ms();
                    info.finished_at = Some(now_ms());
                });
                // Stopping is the user's decision, not a milestone to report:
                // drop a queued wake and unread notes so no model turn follows.
                {
                    let mut inner = lock(&self.inner);
                    if let Some(entry) = inner.agents.get_mut(agent_id) {
                        entry.wake_pending = false;
                        entry.pending.clear();
                    }
                }
                Ok(self.get(agent_id).unwrap_or(info))
            }
            _ => Err("That coding agent has already finished.".into()),
        }
    }

    /// Stop every live agent that belongs to one chat. This is what the Stop
    /// button in the task board calls: no model round-trip, no confirmation.
    pub fn stop_chat(&self, chat_id: &str) -> usize {
        let ids: Vec<String> = lock(&self.inner)
            .agents
            .values()
            .filter(|entry| entry.info.chat_id == chat_id && entry.info.is_live())
            .map(|entry| entry.info.id.clone())
            .collect();
        let mut stopped = 0;
        for id in ids {
            if self.stop(&id).is_ok() {
                stopped += 1;
            }
        }
        stopped
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

    /// The full transcript of one run: what it thought, said and ran. Read
    /// from the pi session file, plus the live buffer for the message or tool
    /// that has not been flushed yet. Advanced mode is the only caller.
    pub fn transcript(&self, agent_id: &str) -> Result<AgentTranscript, String> {
        let (info, live) = {
            let inner = lock(&self.inner);
            let entry = inner
                .agents
                .get(agent_id)
                .ok_or_else(|| format!("No agent {agent_id}"))?;
            (entry.info.clone(), entry.live.clone())
        };

        let mut items = Vec::new();
        let mut truncated = false;
        if let Some(file) = newest_session_file(&self.sessions_dir, &info.session_id) {
            if let Ok(raw) = std::fs::read_to_string(&file) {
                let parsed = parse_transcript(&raw);
                items = parsed.0;
                truncated = parsed.1;
            }
        }

        // Merge the live tail. Thinking and narration come before the tools
        // they led to.
        if !live.thinking.trim().is_empty() {
            items.push(TranscriptItem {
                id: format!("{}-live-thinking", info.id),
                kind: "thinking".into(),
                text: Some(truncate(&live.thinking, MAX_TRANSCRIPT_TEXT)),
                name: None,
                args: None,
                output: None,
                is_error: false,
                status: None,
            });
        }
        if !live.text.trim().is_empty() {
            items.push(TranscriptItem {
                id: format!("{}-live-text", info.id),
                kind: "text".into(),
                text: Some(truncate(&live.text, MAX_TRANSCRIPT_TEXT)),
                name: None,
                args: None,
                output: None,
                is_error: false,
                status: None,
            });
        }
        // Completed tools that the file already has are updated rather than
        // duplicated, so the output does not blink out between
        // `tool_execution_end` and the toolResult being written.
        let mut disk_tool = HashMap::new();
        for (index, item) in items.iter().enumerate() {
            if item.kind == "tool" {
                disk_tool.insert(item.id.clone(), index);
            }
        }
        for tool in live.tools {
            match disk_tool.get(&tool.id) {
                Some(&index) => {
                    if tool.output.is_some() {
                        items[index].output = tool.output;
                        items[index].is_error = tool.is_error;
                        items[index].status = tool.status;
                    }
                }
                None => items.push(tool),
            }
        }
        if items.len() > MAX_TRANSCRIPT_ITEMS {
            items.drain(..items.len() - MAX_TRANSCRIPT_ITEMS);
            truncated = true;
        }

        let live = info.is_live();
        Ok(AgentTranscript {
            id: info.id,
            title: info.title,
            project: info.project,
            state: info.state,
            live,
            items,
            truncated,
        })
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

/// The newest session file for a run. A resumed session may have written
/// several files with the same id over time; the latest one is the live story.
fn newest_session_file(root: &Path, session_id: &str) -> Option<PathBuf> {
    let suffix = format!("_{session_id}.jsonl");
    walk_jsonl(root, 2)
        .into_iter()
        .filter(|file| {
            file.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.ends_with(&suffix))
                .unwrap_or(false)
        })
        .max_by_key(|file| {
            std::fs::metadata(file)
                .and_then(|meta| meta.modified())
                .unwrap_or(std::time::UNIX_EPOCH)
        })
}

/// Read the messages out of a pi session file. System messages (the prompt and
/// the tool loadout) are not part of what the user came to inspect; everything
/// else — the brief, thinking, narration, tool calls and their results — is.
fn parse_transcript(raw: &str) -> (Vec<TranscriptItem>, bool) {
    let mut items: Vec<TranscriptItem> = Vec::new();
    let mut calls: HashMap<String, usize> = HashMap::new();

    for line in raw.lines() {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("message") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
        let base = value.get("id").and_then(|v| v.as_str()).unwrap_or("m");

        match role {
            "user" => {
                let text = text_of_message(message);
                if text.trim().is_empty() {
                    continue;
                }
                items.push(TranscriptItem {
                    id: base.to_string(),
                    kind: "user".into(),
                    text: Some(truncate(&text, MAX_TRANSCRIPT_TEXT)),
                    name: None,
                    args: None,
                    output: None,
                    is_error: false,
                    status: None,
                });
            }
            "assistant" => {
                let Some(blocks) = message.get("content").and_then(|c| c.as_array()) else {
                    continue;
                };
                for (index, block) in blocks.iter().enumerate() {
                    let block_type = block.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let id = format!("{base}-{index}");
                    match block_type {
                        "thinking" => {
                            let text = block
                                .get("thinking")
                                .and_then(|t| t.as_str())
                                .unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            items.push(TranscriptItem {
                                id,
                                kind: "thinking".into(),
                                text: Some(truncate(text, MAX_TRANSCRIPT_TEXT)),
                                name: None,
                                args: None,
                                output: None,
                                is_error: false,
                                status: None,
                            });
                        }
                        "text" => {
                            let text = block
                                .get("text")
                                .and_then(|t| t.as_str())
                                .unwrap_or_default();
                            if text.trim().is_empty() {
                                continue;
                            }
                            items.push(TranscriptItem {
                                id,
                                kind: "text".into(),
                                text: Some(truncate(text, MAX_TRANSCRIPT_TEXT)),
                                name: None,
                                args: None,
                                output: None,
                                is_error: false,
                                status: None,
                            });
                        }
                        "toolCall" => {
                            let call_id = block
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or(&id)
                                .to_string();
                            calls.insert(call_id.clone(), items.len());
                            items.push(TranscriptItem {
                                id: call_id,
                                kind: "tool".into(),
                                text: None,
                                name: block
                                    .get("name")
                                    .and_then(|v| v.as_str())
                                    .map(str::to_string),
                                args: block.get("arguments").cloned(),
                                output: None,
                                is_error: false,
                                status: Some("running".into()),
                            });
                        }
                        _ => {}
                    }
                }
            }
            "toolResult" => {
                let call_id = message
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                let output = truncate(&text_of_message(message), MAX_TRANSCRIPT_OUTPUT);
                let error = message
                    .get("isError")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false);
                match calls.get(call_id) {
                    Some(&index) => {
                        items[index].output = Some(output);
                        items[index].is_error = error;
                        items[index].status = Some(if error { "error" } else { "done" }.into());
                    }
                    None => items.push(TranscriptItem {
                        id: call_id.to_string(),
                        kind: "tool".into(),
                        text: None,
                        name: message
                            .get("toolName")
                            .and_then(|v| v.as_str())
                            .map(str::to_string),
                        args: None,
                        output: Some(output),
                        is_error: error,
                        status: Some(if error { "error" } else { "done" }.into()),
                    }),
                }
            }
            _ => {}
        }
    }

    let mut truncated = false;
    if items.len() > MAX_TRANSCRIPT_ITEMS {
        items.drain(..items.len() - MAX_TRANSCRIPT_ITEMS);
        truncated = true;
    }
    (items, truncated)
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
    model: &str,
    thinking: Option<&str>,
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
    if !model.trim().is_empty() {
        args.push("--model".into());
        args.push(model.to_string());
    }
    if let Some(thinking) = thinking {
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
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .creation_flags(crate::CREATE_NO_WINDOW)
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

fn build_command(engine: &PiRuntime, args: &[String]) -> Command {
    let program = engine.program.to_string_lossy().to_string();
    let mut command = if engine.cli.is_none()
        && cfg!(target_os = "windows")
        && !program.to_ascii_lowercase().ends_with(".exe")
    {
        // A developer's PATH `pi` is an npm .cmd shim; CreateProcess cannot
        // launch batch files directly. (The bundled runtime never needs this.)
        let mut command = Command::new("cmd");
        command.arg("/C").arg(&program);
        command
    } else {
        Command::new(&engine.program)
    };
    #[cfg(windows)]
    command.creation_flags(crate::CREATE_NO_WINDOW);
    command.args(engine.prefix_args());
    command.args(args);
    command
}

/// Queue a wake; the 1 s ticker delivers it together with any pending progress.
fn mark_wake(inner: &Arc<Mutex<Inner>>, agent_id: &str) {
    if let Some(entry) = lock(inner).agents.get_mut(agent_id) {
        entry.wake_pending = true;
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

/// Build the checklist the chat agent asked for. The first step is the one the
/// run is about to start, so the board shows motion immediately.
pub fn plan_from_titles(titles: &[String]) -> Vec<PlanStep> {
    titles
        .iter()
        .map(|title| title.trim())
        .filter(|title| !title.is_empty())
        .take(MAX_PLAN_STEPS)
        .enumerate()
        .map(|(index, title)| PlanStep {
            title: truncate(title, MAX_STEP_TITLE),
            status: if index == 0 {
                STEP_ACTIVE.to_string()
            } else {
                STEP_PENDING.to_string()
            },
            started_at: None,
            finished_at: None,
        })
        .collect()
}

/// Carry each step's clock across the plan rewrites the guard writes.
///
/// An update replaces the whole checklist, so steps are matched by title (or by
/// position when titles line up): a step keeps the moment it was first seen in
/// progress and the moment it finished. Only work Hook actually watched gets a
/// duration; a step crossed off without ever being seen active stays without
/// one rather than pretending it took no time.
fn merge_plan_times(previous: &[PlanStep], mut next: Vec<PlanStep>, at: i64) -> Vec<PlanStep> {
    for (index, step) in next.iter_mut().enumerate() {
        let before = previous
            .get(index)
            .filter(|old| old.title == step.title)
            .or_else(|| previous.iter().find(|old| old.title == step.title));
        if let Some(before) = before {
            step.started_at = before.started_at;
            step.finished_at = before.finished_at;
        }
        match step.status.as_str() {
            STEP_DONE => {
                if step.started_at.is_some() {
                    step.finished_at.get_or_insert(at);
                }
            }
            STEP_ACTIVE => {
                step.started_at.get_or_insert(at);
                // A reopened step is running again, not still finished.
                step.finished_at = None;
            }
            _ => {
                step.started_at = None;
                step.finished_at = None;
            }
        }
    }
    next
}

/// Read a plan written by the guard's `update_plan` tool. Empty plans are
/// refused: a tool call that produced nothing must not blank the board.
fn plan_from_value(value: &serde_json::Value) -> Option<Vec<PlanStep>> {
    let raw = value.get("steps")?.as_array()?;
    let mut steps: Vec<PlanStep> = Vec::new();
    for item in raw.iter().take(MAX_PLAN_STEPS) {
        let Some(title) = item.get("title").and_then(|t| t.as_str()) else {
            continue;
        };
        let title = title.trim();
        if title.is_empty() {
            continue;
        }
        let status = match item.get("status").and_then(|s| s.as_str()) {
            Some(STEP_ACTIVE) => STEP_ACTIVE,
            Some(STEP_DONE) => STEP_DONE,
            _ => STEP_PENDING,
        };
        steps.push(PlanStep {
            title: truncate(title, MAX_STEP_TITLE),
            status: status.to_string(),
            started_at: None,
            finished_at: None,
        });
    }
    if steps.is_empty() {
        None
    } else {
        Some(steps)
    }
}

#[allow(clippy::too_many_arguments)]
async fn drive(
    agent_id: String,
    chat_id: String,
    inner: Arc<Mutex<Inner>>,
    data_dir: PathBuf,
    signal_tx: mpsc::UnboundedSender<Signal>,
    settings: Arc<SettingsStore>,
    mut child: Child,
    mut stdin: tokio::process::ChildStdin,
    stdout: tokio::process::ChildStdout,
    mut rx: mpsc::UnboundedReceiver<AgentCmd>,
    direct: bool,
    bridge: Option<Arc<crate::bridge::ToolBridge>>,
) {
    let mut lines = BufReader::new(stdout).lines();
    let engine_pid = child.id();
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
                        // `message_update` and `tool_execution_update` are the two
                        // records a streaming turn produces by the hundred, one per
                        // delta, and Hook reads neither. Skipping them before parsing is
                        // cheap: pi always writes `type` first, and anything that does
                        // not match the prefix takes the normal path.
                        let trimmed = line.trim();
                        if let Some(rest) = trimmed.strip_prefix("{\"type\":\"") {
                            if rest.starts_with("tool_execution_update\"") {
                                continue;
                            }
                            if rest.starts_with("message_update\"") {
                                // The advanced inspector shows thinking as it
                                // streams, so those records are worth parsing.
                                // A direct chat has no other view: its thinking
                                // is drawn in the conversation itself, so it
                                // needs them whatever the switch says.
                                if !settings.advanced_mode() && !direct {
                                    continue;
                                }
                            }
                        }
                        let Ok(record) = serde_json::from_str::<serde_json::Value>(trimmed) else { continue };
                        let outcome = apply_record(&inner, &agent_id, &record);
                        // The user's own conversation is drawn from these
                        // records, so a direct agent's turn is assembled here
                        // as well as in agents.json.
                        if direct {
                            let _ = signal_tx.send(Signal::Record {
                                chat_id: chat_id.clone(),
                                agent_id: agent_id.clone(),
                                record: record.clone(),
                            });
                        }
                        // Only rewrite agents.json when the record changed something that
                        // is actually stored: a token delta is not news.
                        if outcome.changed {
                            persist(&data_dir, &lock(&inner));
                        }
                        if outcome.wake {
                            mark_wake(&inner, &agent_id);
                            let _ = signal_tx.send(Signal::Changed);
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
                            mark_wake(&inner, &agent_id);
                            let _ = signal_tx.send(Signal::Changed);
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
    // The Stop button means the whole tree, not just the process we spawned:
    // a `.cmd` shim on a developer machine leaves the real node process behind.
    if let Some(pid) = engine_pid {
        kill_tree(pid);
    }

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
                    if !direct {
                        wake = Some(Wake {
                            agent_id: agent_id.clone(),
                        });
                    }
                }
            }
        }
    }
    persist(&data_dir, &lock(&inner));
    if wake.is_some() {
        mark_wake(&inner, &agent_id);
        let _ = signal_tx.send(Signal::Changed);
    }
    if direct {
        // The chat is a conversation, not a task board: it has to learn that
        // the process is gone even when pi died before it could settle.
        if let Some(bridge) = &bridge {
            bridge.release(&chat_id);
        }
        let _ = signal_tx.send(Signal::Record {
            chat_id: chat_id.clone(),
            agent_id: agent_id.clone(),
            record: serde_json::json!({ "type": "agent_exit" }),
        });
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

/// What one pi RPC record did to the agent.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct RecordOutcome {
    /// Something stored or drawn changed, so the caller has to persist.
    changed: bool,
    /// The chat agent should be woken.
    wake: bool,
}

/// Apply one pi RPC record.
fn apply_record(inner: &Arc<Mutex<Inner>>, agent_id: &str, record: &serde_json::Value) -> RecordOutcome {
    let kind = record.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let mut changed = false;
    let mut wake = false;

    {
        let mut guard = lock(inner);
        let Some(entry) = guard.agents.get_mut(agent_id) else {
            return RecordOutcome::default();
        };
        let info = &mut entry.info;

        match kind {
            "agent_start" | "turn_start" => {
                // A run the user stopped must not look alive again when the
                // engine's abort handshake produces more records.
                if info.state != STATE_STOPPED {
                    info.state = STATE_RUNNING.to_string();
                    info.updated_at = now_ms();
                    changed = true;
                }
            }
            "compaction_start" => {
                if info.state != STATE_STOPPED {
                    info.state = STATE_RUNNING.to_string();
                }
                info.last_step = Some("Compacting the conversation".into());
                info.updated_at = now_ms();
                changed = true;
            }
            "compaction_end" => {
                // A manual compaction is the whole job: pi emits no settle
                // record for it, so the agent is idle again once it is done.
                // A threshold or overflow compaction happens mid-run.
                let manual = record.get("reason").and_then(|r| r.as_str()) == Some("manual");
                if manual && info.state == STATE_RUNNING {
                    info.state = STATE_IDLE.to_string();
                }
                info.last_step = None;
                info.updated_at = now_ms();
                changed = true;
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
                entry.live.tools.retain(|item| {
                    item.id
                        != record
                            .get("toolCallId")
                            .and_then(|v| v.as_str())
                            .unwrap_or_default()
                });
                entry.live.tools.push(TranscriptItem {
                    id: record
                        .get("toolCallId")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    kind: "tool".into(),
                    text: None,
                    name: Some(tool.to_string()),
                    args: Some(args),
                    output: None,
                    is_error: false,
                    status: Some("running".into()),
                });
                changed = true;
            }
            "tool_execution_end" => {
                // The session file learns about the result when pi writes the
                // toolResult message; the live copy covers the gap, and the
                // transcript merge prefers whichever has the output.
                let id = record
                    .get("toolCallId")
                    .and_then(|v| v.as_str())
                    .unwrap_or_default();
                if let Some(item) = entry.live.tools.iter_mut().find(|item| item.id == id) {
                    let error = record
                        .get("isError")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    item.output = record
                        .get("result")
                        .map(|result| truncate(&text_of_message(result), MAX_TRANSCRIPT_OUTPUT));
                    item.is_error = error;
                    item.status = Some(if error { "error" } else { "done" }.into());
                }
            }
            "message_start" => {
                // A new assistant message is starting; the previous one (if it
                // had not ended cleanly) is no longer streaming.
                if record
                    .get("message")
                    .and_then(|m| m.get("role"))
                    .and_then(|r| r.as_str())
                    == Some("assistant")
                {
                    entry.live.thinking.clear();
                    entry.live.text.clear();
                }
            }
            "message_update" => {
                if let Some(event) = record.get("assistantMessageEvent") {
                    let kind = event.get("type").and_then(|t| t.as_str()).unwrap_or("");
                    let delta = event.get("delta").and_then(|d| d.as_str());
                    match kind {
                        "thinking_delta" => {
                            if let Some(delta) = delta {
                                entry.live.thinking.push_str(delta);
                            }
                        }
                        // `thinking_end` and `text_end` carry the authoritative
                        // block; replace the assembled deltas with it.
                        "thinking_end" => {
                            if let Some(text) = event.get("content").and_then(|c| c.as_str()) {
                                entry.live.thinking = text.to_string();
                            }
                        }
                        "text_delta" => {
                            if let Some(delta) = delta {
                                entry.live.text.push_str(delta);
                            }
                        }
                        "text_end" => {
                            if let Some(text) = event.get("content").and_then(|c| c.as_str()) {
                                entry.live.text = text.to_string();
                            }
                        }
                        _ => {}
                    }
                }
            }
            "message_end" => {
                if let Some(message) = record.get("message") {
                    let role = message.get("role").and_then(|r| r.as_str()).unwrap_or("");
                    if role == "assistant" {
                        // The message is in the session file now; the live
                        // buffer would only duplicate it.
                        entry.live.thinking.clear();
                        entry.live.text.clear();
                        let text = text_of_message(message);
                        if !text.trim().is_empty() {
                            info.last_message = Some(truncate(&text, 4000));
                            info.updated_at = now_ms();
                            changed = true;
                        }
                        if let Some(stop) = message.get("stopReason").and_then(|s| s.as_str()) {
                            if stop == "length" {
                                // The model ran out of room mid-thought: it
                                // stopped without writing or calling a tool.
                                entry.truncated = true;
                                changed = true;
                            }
                            if stop == "error" || stop == "aborted" {
                                if let Some(err) = message.get("errorMessage").and_then(|e| e.as_str()) {
                                    info.error = Some(truncate(err, 500));
                                    changed = true;
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
                    changed = true;
                    // The user is watching this conversation, not a chat agent.
                    wake = !info.direct;
                }
            }
            "agent_settled" => {
                changed = true;
                // Everything is in the session file by the time pi settles.
                entry.live = LiveTranscript::default();
                if info.state == STATE_STOPPED {
                    // The abort we asked for landed. Keep the reason it stopped
                    // and the checklist exactly as the stop left it.
                    info.question = None;
                    if info.finished_at.is_none() {
                        info.finished_at = Some(now_ms());
                    }
                    info.updated_at = now_ms();
                } else {
                    // Settled means nothing is pending any more, question included.
                    info.question = None;
                    info.state = STATE_IDLE.to_string();
                    info.finished_at = Some(now_ms());
                    info.updated_at = now_ms();
                    let truncated = entry.truncated;
                    if truncated {
                        // Report it: otherwise the run looks like it simply stopped
                        // without doing anything. A direct chat sees the engine's
                        // own words, so nothing has to be queued for it.
                        entry.truncated = false;
                        if !info.direct {
                            entry.pending.push(Update {
                                note: "The run ran out of room while thinking and stopped before finishing anything. Nothing is broken - the work can be picked up from where it stopped.".into(),
                                images: Vec::new(),
                            });
                        }
                    } else if !record
                        .get("aborted")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                    {
                        // The run ended cleanly: nothing on the checklist is
                        // still being worked on, so cross off what is left.
                        let at = now_ms();
                        for step in info.plan.iter_mut() {
                            step.status = STEP_DONE.to_string();
                            // A step nobody saw running has no honest duration.
                            if step.started_at.is_some() {
                                step.finished_at.get_or_insert(at);
                            }
                        }
                    }
                    wake = true;
                }
            }
            _ => {}
        }
    }

    RecordOutcome { changed, wake }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_engine(base: &Path) -> Result<PiRuntime, String> {
        Ok(PiRuntime {
            program: base.join("fake-pi.cmd"),
            cli: None,
            agent_home: base.join("agent-home"),
        })
    }

    fn manager() -> AgentManager {
        let base = std::env::temp_dir().join(format!("hook-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = Arc::new(SettingsStore::new(&base));
        let projects = Arc::new(ProjectsStore::new(&base));
        let (tx, _rx) = mpsc::unbounded_channel();
        AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        )
    }

    fn manager_channel() -> (AgentManager, mpsc::UnboundedReceiver<Signal>) {
        let base = std::env::temp_dir().join(format!("hook-agents-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        let settings = Arc::new(SettingsStore::new(&base));
        let projects = Arc::new(ProjectsStore::new(&base));
        let (tx, rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        );
        (mgr, rx)
    }

    fn test_config() -> crate::config::HarnessConfig {
        toml::from_str(
            r#"
[provider]
base_url = "https://example.invalid"
api_key = "test"
[model]
name = "test-model"
"#,
        )
        .unwrap()
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
    fn transcript_keeps_thinking_tools_and_results() {
        let raw = r#"
{"type":"session","version":3,"id":"s1","cwd":"/project"}
{"type":"message","id":"a1","message":{"role":"user","content":[{"type":"text","text":"Build the page"}]}}
{"type":"message","id":"a2","message":{"role":"assistant","content":[{"type":"thinking","thinking":"First read the project."},{"type":"text","text":"Let me look around."},{"type":"toolCall","id":"call_1","name":"read","arguments":{"path":"src/App.tsx"}}]}}
{"type":"message","id":"a3","message":{"role":"toolResult","toolCallId":"call_1","toolName":"read","content":[{"type":"text","text":"export default function App() {}"}],"isError":false}}
{"type":"message","id":"a4","message":{"role":"assistant","content":[{"type":"text","text":"Done."}],"stopReason":"stop"}}
"#;
        let (items, truncated) = parse_transcript(raw);
        assert!(!truncated);
        assert_eq!(items.len(), 5);
        assert_eq!(items[0].kind, "user");
        assert_eq!(items[0].text.as_deref(), Some("Build the page"));
        assert_eq!(items[1].kind, "thinking");
        assert_eq!(items[1].text.as_deref(), Some("First read the project."));
        assert_eq!(items[2].kind, "text");
        assert_eq!(items[3].kind, "tool");
        assert_eq!(items[3].name.as_deref(), Some("read"));
        assert_eq!(items[3].args.as_ref().unwrap()["path"], "src/App.tsx");
        assert_eq!(items[3].status.as_deref(), Some("done"));
        assert_eq!(
            items[3].output.as_deref(),
            Some("export default function App() {}")
        );
        assert_eq!(items[4].kind, "text");
        assert_eq!(items[4].text.as_deref(), Some("Done."));
    }

    #[test]
    fn live_thinking_and_tools_reach_the_transcript_before_the_file() {
        let mgr = manager();
        lock(&mgr.inner)
            .agents
            .insert("ag_1".into(), plan_entry(Vec::new()));

        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({"type":"message_start","message":{"role":"assistant"}}),
        );
        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({
                "type":"message_update",
                "assistantMessageEvent":{"type":"thinking_delta","delta":"Reading the layout."}
            }),
        );
        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({
                "type":"tool_execution_start",
                "toolCallId":"call_1",
                "toolName":"read",
                "args":{"path":"a.txt"}
            }),
        );
        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({
                "type":"tool_execution_end",
                "toolCallId":"call_1",
                "toolName":"read",
                "result":{"content":[{"type":"text","text":"hello"}]},
                "isError":false
            }),
        );

        let transcript = mgr.transcript("ag_1").unwrap();
        assert_eq!(transcript.items.len(), 2);
        assert_eq!(transcript.items[0].kind, "thinking");
        assert_eq!(transcript.items[0].text.as_deref(), Some("Reading the layout."));
        assert_eq!(transcript.items[1].kind, "tool");
        assert_eq!(transcript.items[1].output.as_deref(), Some("hello"));
        assert_eq!(transcript.items[1].status.as_deref(), Some("done"));
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
            plan: Vec::new(),
            direct: false,
            device_id: String::new(),
            device_name: String::new(),
        };
        inner.agents.insert(
            "ag_1".into(),
            Entry {
                info,
                tx: None,
                pid: None,
                pending: Vec::new(),
                wake_pending: false,
                last_flush_at: now_ms(),
                delivered: false,
                truncated: false,
                live: LiveTranscript::default(),
            },
        );
        drop(inner);

        let running = serde_json::json!({"type":"agent_start"});
        let outcome = apply_record(&mgr.inner, "ag_1", &running);
        assert!(!outcome.wake);
        assert!(outcome.changed, "a state change must be persisted");
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
        let outcome = apply_record(&mgr.inner, "ag_1", &question);
        assert!(outcome.wake && outcome.changed);
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

    #[test]
    fn a_token_stream_never_rewrites_the_store() {
        // A thinking model streams hundreds of these records per turn. They
        // change nothing Hook stores, and rewriting agents.json for each one is
        // how a long think used to peg a core and leave the app feeling stuck.
        let mgr = manager();
        lock(&mgr.inner)
            .agents
            .insert("ag_1".into(), plan_entry(plan_from_titles(&["Setting things up".into()])));

        for kind in ["message_start", "message_update", "tool_execution_update", "turn_end"] {
            let record = serde_json::json!({
                "type": kind,
                "message": {"role": "assistant", "content": [{"type": "thinking", "thinking": "..."}]}
            });
            let outcome = apply_record(&mgr.inner, "ag_1", &record);
            assert!(!outcome.changed, "{kind} must not trigger a persist");
            assert!(!outcome.wake, "{kind} must not wake the chat agent");
        }

        // The finished message is what actually matters.
        let done = serde_json::json!({
            "type":"message_end",
            "message": {"role":"assistant", "content":[{"type":"text","text":"built it"}]}
        });
        let outcome = apply_record(&mgr.inner, "ag_1", &done);
        assert!(outcome.changed);
        assert!(!outcome.wake);
        assert_eq!(
            lock(&mgr.inner).agents["ag_1"].info.last_message.as_deref(),
            Some("built it")
        );
    }


    #[test]
    fn a_truncated_turn_is_reported_not_left_looking_idle() {
        // A thinking model that spends its whole output budget reasoning ends
        // the turn with stopReason "length" and nothing done. Without a note it
        // looks like the agent quietly gave up.
        let mgr = manager();
        {
            let mut inner = lock(&mgr.inner);
            inner.agents.insert(
                "ag_1".into(),
                Entry {
                    info: AgentInfo {
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
                        plan: Vec::new(),
                        direct: false,
                        device_id: String::new(),
                        device_name: String::new(),
                    },
                    tx: None,
                    pid: None,
                    pending: Vec::new(),
                    wake_pending: false,
                    last_flush_at: now_ms(),
                    delivered: false,
                    truncated: false,
                    live: LiveTranscript::default(),
                },
            );
        }

        let cut = serde_json::json!({
            "type": "message_end",
            "message": { "role": "assistant", "content": [{ "type": "thinking", "thinking": "hmm" }], "stopReason": "length" }
        });
        apply_record(&mgr.inner, "ag_1", &cut);

        let settled = serde_json::json!({"type":"agent_settled","aborted":false});
        assert!(apply_record(&mgr.inner, "ag_1", &settled).wake);

        let notes = mgr.take_updates("ag_1");
        assert_eq!(notes.len(), 1);
        assert!(notes[0].note.contains("ran out of room"));
    }

    #[tokio::test]
    async fn progress_notes_are_batched_not_forwarded_one_by_one() {
        use std::time::Duration as StdDuration;

        let base = std::env::temp_dir().join(format!("hook-agent-batch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&base).unwrap();
        std::fs::write(base.join("fake-pi.mjs"), include_str!("../tests/fixtures/fake-pi.mjs")).unwrap();
        std::fs::write(
            base.join("fake-pi.cmd"),
            "@echo off
node \"%~dp0fake-pi.mjs\" %*
",
        )
        .unwrap();

        let settings = Arc::new(SettingsStore::new(&base));
        let projects = Arc::new(ProjectsStore::new(&base));
        let root = settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        projects.create(&root, "demo", "").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        );
        let info = mgr
            .start(
                "chat-1",
                "demo",
                "build it",
                None,
                None,
                &["Setting things up".into(), "Designing the front page".into()],
            )
            .unwrap();
        assert_eq!(info.plan.len(), 2);
        assert_eq!(info.plan[0].status, STEP_ACTIVE);
        // The guard gets the same checklist on disk, so its system prompt can
        // tell the coding agent to keep the wording the user already sees.
        let seed = std::fs::read_to_string(mgr.updates_dir(&info.id).join("plan.json")).unwrap();
        assert!(seed.contains("Setting things up"));
        assert!(seed.contains(STEP_ACTIVE));

        // The agent writes two notes and a picture into its mailbox.
        let dir = mgr.updates_dir(&info.id);
        std::fs::create_dir_all(dir.join("files")).unwrap();
        std::fs::write(dir.join("files").join("shot.png"), b"png").unwrap();
        std::fs::write(
            dir.join("u-1.json"),
            serde_json::json!({"note": "first", "images": ["shot.png"]}).to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.join("u-2.json"),
            serde_json::json!({"note": "second", "images": []}).to_string(),
        )
        .unwrap();

        assert!(!mgr.delivered_progress(&info.id), "a fresh run has reported nothing");
        assert!(mgr.take_updates(&info.id).is_empty(), "nothing is queued yet");
        assert!(
            !mgr.delivered_progress(&info.id),
            "draining an empty mailbox must not count as having told the user"
        );

        // Not due yet: nothing is delivered mid-interval.
        mgr.harvest();
        mgr.flush_due(StdDuration::from_secs(60));
        assert_eq!(mgr.take_updates(&info.id).len(), 2, "harvest collects both notes");

        // Re-queue them and let the interval expire.
        std::fs::write(
            dir.join("u-3.json"),
            serde_json::json!({"note": "third", "images": []}).to_string(),
        )
        .unwrap();
        mgr.harvest();
        mgr.flush_due(StdDuration::ZERO);

        let mut woke = false;
        let deadline = tokio::time::Instant::now() + StdDuration::from_secs(5);
        while tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(StdDuration::from_millis(200), rx.recv()).await {
                Ok(Some(Signal::Wake(wake))) if wake.agent_id == info.id => {
                    woke = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(woke, "a due batch should wake the chat");
        let delivered = mgr.take_updates(&info.id);
        assert_eq!(delivered.len(), 1);
        assert_eq!(delivered[0].note, "third");
        assert!(delivered[0].images.is_empty());
        assert!(
            mgr.delivered_progress(&info.id),
            "a batch actually handed over is what a settle compares against"
        );

        // The drained mailbox files are gone, so nothing is delivered twice.
        mgr.harvest();
        assert!(mgr.take_updates(&info.id).is_empty());

        // A preview pointer travels the same mailbox and reaches the supervisor.
        std::fs::write(
            dir.join("v-2.json"),
            serde_json::json!({"file": "preview.html", "title": "Insights"}).to_string(),
        )
        .unwrap();
        mgr.harvest();
        let mut preview = None;
        while let Ok(signal) = rx.try_recv() {
            if let Signal::Preview(report) = signal {
                preview = Some(report);
            }
        }
        let report = preview.expect("harvest should announce the preview");
        assert_eq!(report.agent_id, info.id);
        assert_eq!(report.file, "preview.html");
        assert_eq!(report.title, "Insights");
        assert!(!dir.join("v-2.json").exists(), "the pointer is consumed once");

        mgr.stop(&info.id).ok();
        let _ = std::fs::remove_dir_all(&base);
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
        let projects = Arc::new(ProjectsStore::new(&base));
        let root = settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        projects.create(&root, "demo", "").unwrap();

        let (tx, _rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        );
        let info = mgr.start("chat-1", "demo", "do a thing", None, None, &[]).unwrap();
        assert!(mgr.get(&info.id).unwrap().is_live());

        mgr.kill_all_sync();

        let after = mgr.get(&info.id).unwrap();
        assert_eq!(after.state, STATE_INTERRUPTED);
        assert!(after.error.is_some());
        assert_eq!(mgr.overview().live, 0);

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
        let projects = Arc::new(ProjectsStore::new(&base));
        // Keep the test inside its own temp tree.
        let root = settings
            .set_projects_dir(&base.join("projects").to_string_lossy())
            .unwrap();
        projects.create(&root, "demo", "test project").unwrap();

        let (tx, mut rx) = mpsc::unbounded_channel();
        let mgr = AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        );

        let info = mgr
            .start(
                "chat-1",
                "demo",
                "Add the login page",
                Some("login"),
                None,
                &["Setting things up".into(), "Building the login page".into()],
            )
            .expect("agent should start");
        assert_eq!(info.state, STATE_STARTING);
        assert_eq!(info.plan.len(), 2);
        assert_eq!(mgr.working_count(), 1);

        // Wait for the settle signal, then check the recorded state. In the
        // app a 1 s ticker does the harvesting; here the test plays that role.
        // The deadline is generous because this spawns cmd.exe + node, which on a
        // loaded CI runner can take seconds to get going (10 s was flaky).
        let mut woke = false;
        let deadline = tokio::time::Instant::now() + StdDuration::from_secs(45);
        while tokio::time::Instant::now() < deadline {
            mgr.harvest();
            mgr.flush_due(StdDuration::ZERO);
            match tokio::time::timeout(StdDuration::from_millis(300), rx.recv()).await {
                Ok(Some(Signal::Wake(wake))) => {
                    if wake.agent_id == info.id {
                        woke = true;
                        break;
                    }
                }
                Ok(Some(Signal::Changed)) | Ok(Some(Signal::Preview(_))) | Ok(None) => {}
                Ok(Some(Signal::Record { .. })) => {}
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
        assert!(
            settled.plan.iter().all(|step| step.status == STEP_DONE),
            "a clean settle crosses off whatever the agent left open"
        );

        // Stopping a live agent records it as stopped rather than failed.
        mgr.stop(&info.id).unwrap();
        let stopped = mgr.get(&info.id).unwrap();
        assert_eq!(stopped.state, STATE_STOPPED);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn the_chat_agents_plan_becomes_a_checklist() {
        let steps = plan_from_titles(&[
            "  Setting things up ".into(),
            "   ".into(),
            "Designing the front page".into(),
        ]);
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].title, "Setting things up");
        assert_eq!(steps[0].status, STEP_ACTIVE);
        assert_eq!(steps[1].status, STEP_PENDING);

        // The guard's plan is normalized: blank steps vanish, unknown statuses
        // become pending, and an empty plan never erases the board.
        let from_guard = plan_from_value(&serde_json::json!({
            "steps": [
                {"title": "Setting things up", "status": "done"},
                {"title": "   ", "status": "done"},
                {"title": "Designing the front page", "status": "weird"}
            ]
        }))
        .unwrap();
        assert_eq!(from_guard.len(), 2);
        assert_eq!(from_guard[0].status, STEP_DONE);
        assert_eq!(from_guard[1].status, STEP_PENDING);
        assert!(plan_from_value(&serde_json::json!({"steps": []})).is_none());
    }

    #[test]
    fn every_checklist_step_keeps_its_own_clock() {
        let seed = merge_plan_times(
            &[],
            plan_from_titles(&["Setting things up".into(), "Designing the page".into()]),
            1_000,
        );
        assert_eq!(
            seed[0].started_at,
            Some(1_000),
            "the step being worked on starts now"
        );
        assert_eq!(seed[0].finished_at, None);
        assert_eq!(seed[1].started_at, None, "a step not started has no clock");

        // The agent finishes step one and picks up step two.
        let moved = merge_plan_times(
            &seed,
            plan_from_value(&serde_json::json!({
                "steps": [
                    {"title": "Setting things up", "status": "done"},
                    {"title": "Designing the page", "status": "active"}
                ]
            }))
            .unwrap(),
            61_000,
        );
        assert_eq!(moved[0].started_at, Some(1_000));
        assert_eq!(moved[0].finished_at, Some(61_000));
        assert_eq!(moved[1].started_at, Some(61_000));
        assert_eq!(moved[1].finished_at, None);

        // Re-sending the same plan must not move an existing clock.
        let again = merge_plan_times(&moved, moved.clone(), 90_000);
        assert_eq!(again, moved);

        // A step crossed off without ever being seen active gets no duration.
        let crossed = merge_plan_times(
            &seed,
            plan_from_value(&serde_json::json!({
                "steps": [
                    {"title": "Setting things up", "status": "done"},
                    {"title": "Designing the page", "status": "done"}
                ]
            }))
            .unwrap(),
            90_000,
        );
        assert_eq!(crossed[1].started_at, None);
        assert_eq!(crossed[1].finished_at, None);
    }

    fn plan_entry(plan: Vec<PlanStep>) -> Entry {
        Entry {
            info: AgentInfo {
                id: "ag_1".into(),
                chat_id: "c1".into(),
                project: "p".into(),
                project_path: "C:/p".into(),
                title: "t".into(),
                task: "do it".into(),
                session_id: "s1".into(),
                state: STATE_RUNNING.into(),
                created_at: 1,
                updated_at: 1,
                finished_at: None,
                steps: 0,
                last_step: None,
                last_message: None,
                error: None,
                question: None,
                plan,
                direct: false,
                device_id: String::new(),
                device_name: String::new(),
            },
            tx: None,
            pid: None,
            pending: Vec::new(),
            wake_pending: false,
            last_flush_at: now_ms(),
            delivered: false,
            truncated: false,
            live: LiveTranscript::default(),
        }
    }

    #[test]
    fn a_clean_settle_crosses_off_the_rest_of_the_checklist() {
        let mgr = manager();
        let plan = plan_from_titles(&[
            "Setting things up".into(),
            "Designing the front page".into(),
        ]);
        lock(&mgr.inner).agents.insert("ag_1".into(), plan_entry(plan));

        // The agent left the first step active on purpose? No: an aborted turn
        // changes nothing, so the board never claims work that was thrown away.
        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({"type":"agent_settled","aborted":true}),
        );
        {
            let guard = lock(&mgr.inner);
            let plan = &guard.agents["ag_1"].info.plan;
            assert_eq!(plan[0].status, STEP_ACTIVE);
            assert_eq!(plan[1].status, STEP_PENDING);
        }

        // A normal settle means the run is over: everything left is done.
        apply_record(
            &mgr.inner,
            "ag_1",
            &serde_json::json!({"type":"agent_settled","aborted":false}),
        );
        let guard = lock(&mgr.inner);
        assert!(guard.agents["ag_1"]
            .info
            .plan
            .iter()
            .all(|step| step.status == STEP_DONE));
    }

    #[test]
    fn stopping_a_run_reopens_the_step_it_was_on() {
        let mgr = manager();
        let plan = plan_from_titles(&[
            "Setting things up".into(),
            "Designing the front page".into(),
            "Hooking up the real service".into(),
        ]);
        let mut entry = plan_entry(plan);
        entry.info.plan[0].status = STEP_DONE.into();
        entry.info.plan[1].status = STEP_ACTIVE.into();
        let (tx, _rx) = mpsc::unbounded_channel();
        entry.tx = Some(tx);
        lock(&mgr.inner).agents.insert("ag_1".into(), entry);

        mgr.stop("ag_1").unwrap();

        let info = mgr.get("ag_1").unwrap();
        assert_eq!(info.state, STATE_STOPPED);
        assert_eq!(info.plan[0].status, STEP_DONE);
        assert_eq!(info.plan[1].status, STEP_PENDING, "not finished, not claimed");
        assert_eq!(info.plan[2].status, STEP_PENDING);
        assert_eq!(mgr.overview().live, 0);
    }

    #[tokio::test]
    async fn a_checklist_update_refreshes_the_board_without_waking_the_chat() {
        use std::time::Duration as StdDuration;

        let (mgr, mut rx) = manager_channel();
        let plan = plan_from_titles(&[
            "Setting things up".into(),
            "Designing the front page".into(),
        ]);
        let mut entry = plan_entry(plan);
        let (agent_tx, _agent_rx) = mpsc::unbounded_channel();
        entry.tx = Some(agent_tx);
        lock(&mgr.inner).agents.insert("ag_1".into(), entry);

        let dir = mgr.updates_dir("ag_1");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("p-1.json"),
            serde_json::json!({"steps": [
                {"title": "Setting things up", "status": "done"},
                {"title": "Designing the front page", "status": "active"}
            ]})
            .to_string(),
        )
        .unwrap();

        mgr.harvest();

        let info = mgr.get("ag_1").unwrap();
        assert_eq!(info.plan[0].status, STEP_DONE);
        assert_eq!(info.plan[1].status, STEP_ACTIVE);
        assert!(!dir.join("p-1.json").exists(), "harvested files are consumed");

        let first = tokio::time::timeout(StdDuration::from_millis(500), rx.recv()).await;
        assert!(
            matches!(first, Ok(Some(Signal::Changed))),
            "a plan change refreshes the UI"
        );
        let second = tokio::time::timeout(StdDuration::from_millis(200), rx.recv()).await;
        assert!(
            second.is_err(),
            "a plan change is for the eye only; it must never wake the chat agent"
        );
    }

    #[test]
    fn the_overview_lists_the_plan_for_the_task_board() {
        let mgr = manager();
        let plan = plan_from_titles(&["Setting things up".into()]);
        let mut entry = plan_entry(plan);
        entry.info.chat_id = "c9".into();
        lock(&mgr.inner).agents.insert("ag_1".into(), entry);

        let overview = mgr.overview();
        assert_eq!(overview.working, 1);
        assert_eq!(overview.live, 1);
        assert_eq!(overview.agents.len(), 1);
        assert_eq!(overview.agents[0].chat_id, "c9");
        assert_eq!(overview.agents[0].plan.len(), 1);
        assert_eq!(overview.agents[0].plan[0].title, "Setting things up");
        assert!(!overview.agents[0].waiting);

        // The UI reads these exact keys; a rename here would silently blank the
        // task board, so pin the wire shape.
        let wire = serde_json::to_value(&overview).unwrap();
        assert_eq!(wire["live"], 1);
        assert_eq!(wire["agents"][0]["chatId"], "c9");
        assert_eq!(wire["agents"][0]["plan"][0]["title"], "Setting things up");
        assert_eq!(wire["agents"][0]["plan"][0]["status"], STEP_ACTIVE);
        assert_eq!(wire["agents"][0]["createdAt"], 1);
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
        let mgr = AgentManager::new(
            &base,
            Arc::new(test_config()),
            Arc::new(std::sync::atomic::AtomicBool::new(false)),
            test_engine(&base),
            settings,
            projects,
            tx,
        );
        let info = mgr.get("ag_x").unwrap();
        assert_eq!(info.state, STATE_INTERRUPTED);
        assert!(info.error.is_some());
    }
}
