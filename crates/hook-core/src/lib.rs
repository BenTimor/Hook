//! The backend every Hook desktop product links.
//!
//! A product is a Tauri window plus a UI. The account, the chat store and its
//! sync engine, the coding-agent supervisor, the preview server, the assistant
//! turn and the whole IPC surface live here, compiled once, so "the chat works
//! the same in Workspace" is a property of the build rather than of two
//! implementations that must be kept in step.
//!
//! `Capabilities` is how a product says what its chat agent may do. It is
//! deliberately small: a capability changes the prompt and the toolset, never
//! the data model.

mod agent;
mod auth;
mod bridge;
mod coding;
mod commands;
mod config;
mod git;
mod guard;
mod import;
mod memory;
mod projects;
mod preview;
mod provider;
mod reports;
mod runtime;
mod settings;
mod store;
mod sync;
mod tools;
mod turn;
mod update;
mod version;
mod workspace;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::agent::{AgentManager, Signal};
use crate::commands::AppState;

// The release app has no console for background helpers to inherit.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

// Re-exported for the integration tests so they use the exact same guard text
// and command line as the runtime.
pub use crate::agent::agent_args;
pub fn guard_source() -> &'static str {
    crate::guard::GUARD_SOURCE
}

/// Which product this backend is serving.
///
/// The data folder comes from the Tauri identifier, not from here; this enum is
/// about behaviour that differs user-visibly (what the chat agent is told, and
/// later which product-specific tools it gets).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Product {
    Chat,
    Workspace,
    /// Hook on a phone. The same conversation, no folder on this device.
    Mobile,
}

/// What this product's chat agent may do, and therefore what the prompt and the
/// toolset advertise.
///
/// Every field is a *place the answer can appear* or a *thing this device can
/// reach*, not a feature of the product. A capability trims the prompt and the
/// toolset; it must never change the data model. Getting this wrong is how a
/// phone ends up told to brief a coding agent it has no way to start, or to put
/// a page in a panel that is not there.
#[derive(Clone, Copy, Debug)]
pub struct Capabilities {
    /// A panel that can show an HTML page served from a coding agent's project.
    /// It needs files on this machine, so it is off wherever there are none.
    pub preview_pages: bool,
    /// The same panel, showing a Hook Workspace document, task or board. It is
    /// only data from the account, which is why a phone can have this half.
    pub preview_workspace: bool,
    /// Launch and steer `pi` coding agents inside project folders.
    pub coding_agents: bool,
    /// Read and write Hook Workspace projects, boards, tasks and documents.
    pub workspace_tools: bool,
    /// Project folders on this machine: list, create, describe, remember in.
    /// Without a projects directory these tools can only fail, so a device with
    /// no folder of its own must not advertise them.
    pub projects: bool,
}

impl Capabilities {
    /// The full chat product: everything on.
    pub const fn chat() -> Self {
        Self {
            preview_pages: true,
            preview_workspace: true,
            coding_agents: true,
            workspace_tools: true,
            projects: true,
        }
    }

    /// Hook Workspace: the same chat and coding agents, no preview panel.
    pub const fn workspace() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: false,
            coding_agents: true,
            workspace_tools: true,
            projects: true,
        }
    }

    /// Hook on a phone: the conversation and the account's Workspace data, no
    /// folder, no engine, no page served from disk. The preview surface exists
    /// and shows boards, tasks and documents, because those arrive over the API.
    pub const fn mobile() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: true,
            coding_agents: false,
            workspace_tools: true,
            projects: false,
        }
    }
}

fn emit_agents(state: &AppState) {
    // One payload feeds both the title-bar pill and the per-chat task board.
    let _ = state.app.emit("hook://agents", state.agents.overview());
}

/// Build the Tauri app: plugins, state, background loops and the IPC surface.
///
/// The caller supplies `generate_context!()`, the window configuration and its
/// own version, because all three belong to the product: `generate_context!()`
/// and the window come from its `tauri.conf.json`, and `version` — normally
/// `env!("CARGO_PKG_VERSION")` in the product crate — is what this build reports
/// as itself. It is a required argument so no product can silently fall back to
/// hook-core's version, which is not a release number (see `version.rs`).
pub fn builder(
    product: Product,
    capabilities: Capabilities,
    version: &'static str,
) -> tauri::Builder<tauri::Wry> {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| setup(app, product, capabilities, version))
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::list_chats,
            commands::get_chat,
            commands::rename_chat,
            commands::set_pinned,
            commands::delete_chat,
            commands::restore_chat,
            commands::search_chats,
            commands::send_message,
            commands::regenerate,
            commands::edit_message,
            commands::stop_stream,
            commands::get_settings,
            commands::set_projects_dir,
            commands::set_advanced_mode,
            commands::read_image,
            commands::open_image,
            commands::save_image_as,
            commands::open_path,
            commands::app_info,
            commands::auth_status,
            commands::auth_login,
            commands::auth_cancel_login,
            commands::auth_google_config,
            commands::auth_google,
            commands::auth_refresh,
            commands::auth_logout,
            commands::open_url,
            commands::agents_overview,
            commands::agent_transcript,
            commands::stop_chat_agents,
            commands::answer_coding_agent,
            commands::create_coding_chat,
            commands::set_coding_chat_folder,
            commands::preview_state,
            commands::sync_status,
            commands::set_chat_context,
            commands::ws_request,
            commands::sync_now,
            commands::import_scan,
            commands::import_apply,
            commands::check_update,
            commands::install_update,
            commands::open_store_update,
            commands::report_message,
            commands::report_content,
            commands::memory_list,
            commands::memory_save,
            commands::memory_update,
            commands::memory_delete,
            commands::memory_clear,
            commands::memory_set_enabled,
        ])
}

/// A panic inside a spawned task is otherwise invisible: the window keeps
/// waiting for an event that will never arrive, and the only trace is a line in
/// a terminal someone has to be watching. Keep the last ones on disk.
fn install_panic_log(data_dir: &std::path::Path) {
    use std::io::Write;

    let path = data_dir.join("panic.log");
    std::panic::set_hook(Box::new(move |info| {
        let thread = std::thread::current();
        let name = thread.name().unwrap_or("unnamed");
        let location = info
            .location()
            .map(|at| format!("{}:{}", at.file(), at.line()))
            .unwrap_or_else(|| "unknown".to_string());
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let text = format!("{stamp} [{name}] {location}: {info}
");
        eprintln!("hook: panic {text}");
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = file.write_all(text.as_bytes());
        }
    }));
}

fn setup(
    app: &mut tauri::App,
    product: Product,
    capabilities: Capabilities,
    version: &'static str,
) -> Result<(), Box<dyn std::error::Error>> {
    // First, so anything that logs or reports "this build" during startup
    // names the product's version rather than hook-core's.
    version::set(version);
    let data_dir = app.path().app_data_dir()?;
    std::fs::create_dir_all(&data_dir)?;
    install_panic_log(&data_dir);

    let store = Arc::new(store::Store::new(data_dir.clone()).map_err(std::io::Error::other)?);
    let settings = Arc::new(settings::SettingsStore::new(&data_dir));
    let projects = Arc::new(projects::ProjectsStore::new(&data_dir));
    let cfg = Arc::new(config::get().map_err(std::io::Error::other)?.clone());
    // Memory lives beside the account file, not beside the chats: both products
    // read the same store, and a different account reads a different file.
    let memory = Arc::new(memory::MemoryStore::new(&data_dir, cfg.memory.clone()));
    let auth = Arc::new(auth::AuthStore::new(
        &data_dir,
        &cfg.auth.base_url,
        cfg.auth.required,
        &cfg.provider.api_key,
    ));
    // Mint the git-only token at launch so the first coding agent does not have
    // to wait for a sync cycle. A product without a coding agent never needs it,
    // and a phone should not hold a credential it cannot use.
    if capabilities.coding_agents {
        let auth = auth.clone();
        tauri::async_runtime::spawn(async move {
            let _ = auth.ensure_git_token().await;
        });
    }
    // Written before each run instead of once here: a coding agent's model
    // config carries its own run id and the current token. Capabilities come
    // from the model card, not from the build: the endpoint says what the model
    // can do, and a provider that cannot answer simply reports nothing.
    let vision = Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Both of these only exist so a coding agent can be started: the engine is
    // the `pi` bundle, and git is what a project pushes with. A product without
    // one (the phone) skips the lookup entirely, so it never reports a missing
    // engine it was never going to use.
    let engine = if capabilities.coding_agents {
        runtime::resolve(app.path().resource_dir().ok().as_deref(), &data_dir)
    } else {
        // No engine is bundled with this build; saying so is more honest than
        // looking for one and reporting it missing.
        Err("This product has no coding engine.".to_string())
    };
    let git_runtime = if capabilities.coding_agents {
        git::resolve(app.path().resource_dir().ok().as_deref(), &data_dir)
    } else {
        None
    };
    if capabilities.coding_agents {
        match &git_runtime {
            Some(git) => eprintln!("hook: git at {}", git.program.display()),
            None => eprintln!("hook: git is missing; project sync is unavailable"),
        }
    }

    let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
    // The loopback endpoint that gives a directly-driven coding agent the chat
    // agent's tools. Served once the app state exists, below.
    let bridge = Arc::new(bridge::ToolBridge::new());
    let agents = Arc::new(
        AgentManager::new(
            &data_dir,
            cfg.clone(),
            vision.clone(),
            engine,
            settings.clone(),
            projects.clone(),
            signal_tx,
        )
        .with_auth(auth.clone())
        .with_git(git_runtime.clone())
        .with_bridge(bridge.clone())
        .with_capabilities(capabilities)
        .with_memory(memory.clone()),
    );

    let preview_emit: preview::Emitter = {        let app = app.handle().clone();
        Arc::new(move |event| {
            let _ = app.emit("hook://preview", event);
        })
    };

    let sync_emit: sync::Emitter = {
        let app = app.handle().clone();
        Arc::new(move |event, payload| {
            let _ = app.emit(event, payload);
        })
    };
    let sync = Arc::new(sync::SyncEngine::new(
        sync_emit,
        &data_dir,
        auth.clone(),
        store.clone(),
        projects.clone(),
        settings.clone(),
        memory.clone(),
        git_runtime,
    ));

    let workspace = Arc::new(workspace::WorkspaceClient::new(&cfg, auth.clone()));

    memory.bind(auth.subject().as_deref());
    let state = Arc::new(AppState {
        app: app.handle().clone(),
        store,
        settings,
        projects,
        memory,
        agents,
        preview: Arc::new(preview::PreviewManager::new(preview_emit)),
        streams: Arc::new(Mutex::new(HashMap::new())),
        turns: turn::TurnState::default(),
        coding: crate::coding::CodingState::default(),
        cfg: cfg.clone(),
        auth: auth.clone(),
        sync: sync.clone(),
        vision: vision.clone(),
        vision_off: Arc::new(Default::default()),
        context_role_off: Arc::new(Default::default()),
        imports: Arc::new(import::Importer::new()),
        workspace,
        context: Arc::new(Mutex::new(None)),
        product,
        capabilities,
    });
    app.manage(state.clone());
    // Now that the state it acts for exists, the tool bridge can take calls.
    bridge.serve(state.clone());
    // A coding-agent chat whose engine died with the last window would keep a
    // "streaming" reply forever; turn it into the error it always was.
    coding::recover(&state.store);
    sync.spawn();

    // One request tells us what the model can see. If the card says images, the
    // chat may send them and the engine is told so before any agent starts.
    // Re-run after sign-in and on window reload.
    {
        let state = state.clone();
        tauri::async_runtime::spawn(async move {
            commands::refresh_capabilities(&state).await;
        });
    }

    // One supervisor drains every agent signal: keeps the UI indicator honest
    // and wakes the owning chat when an agent needs attention.
    let supervisor = state.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(signal) = signal_rx.recv().await {
            match signal {
                Signal::Changed => emit_agents(&supervisor),
                Signal::Wake(wake) => {
                    emit_agents(&supervisor);
                    supervisor.sync.wake();
                    if let Some(info) = supervisor.agents.get(&wake.agent_id) {
                        turn::on_agent_event(supervisor.clone(), info);
                    }
                }
                Signal::Preview(report) => {
                    if let Some(info) = supervisor.agents.get(&report.agent_id) {
                        let root = std::path::PathBuf::from(&info.project_path);
                        if let Err(error) = supervisor.preview.show(
                            &info.chat_id,
                            &info.id,
                            &info.project,
                            &root,
                            &report.file,
                            &report.title,
                        ) {
                            eprintln!("hook: preview rejected: {error}");
                        }
                    }
                }
                Signal::Record {
                    chat_id,
                    agent_id,
                    record,
                } => {
                    // A directly-driven agent's conversation is assembled from
                    // its own records; the chat agent never sees them.
                    coding::on_record(&supervisor, &chat_id, &agent_id, &record);
                }
            }
        }
    });

    // One tick a second: collect progress notes and hand due batches to the
    // chats. Coding agents write to a mailbox; this is what turns that into
    // chat messages (at most once per update interval).
    let ticker = state.clone();
    let interval = std::time::Duration::from_secs(cfg.coding.update_interval_seconds.clamp(10, 3600));
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
        loop {
            tick.tick().await;
            ticker.agents.harvest();
            ticker.agents.flush_due(interval);
            // The preview belongs to one coding-agent run. Once that run settles
            // the panel stays open and usable, but the page stops refreshing
            // itself; the user reloads it by hand.
            if let Some(agent_id) = ticker.preview.agent_id() {
                let live = ticker
                    .agents
                    .get(&agent_id)
                    .map(|info| info.is_active())
                    .unwrap_or(false);
                if !live {
                    ticker.preview.settle();
                }
            }
        }
    });

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    Ok(())
}

/// Kill everything that would otherwise outlive the window.
pub fn on_exit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<Arc<AppState>>() {
        state.agents.kill_all_sync();
        state.preview.stop();
    }
}
