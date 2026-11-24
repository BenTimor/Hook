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
mod analytics;
mod auth;
mod bridge;
mod channel;
mod coding;
mod commands;
mod config;
mod devices;
mod git;
mod guard;
mod import;
mod memory;
mod projects;
mod preview;
mod provider;
mod relay;
mod remote;
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

use std::collections::{HashMap, HashSet};
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
    /// Launch and steer `pi` coding agents inside project folders on this
    /// machine. Only Hook and the headless daemon host.
    pub coding_agents: bool,
    /// Drive coding agents on the account's other machines. A phone and Hook
    /// Workspace have this without `coding_agents`: they are controllers, not
    /// hosts.
    pub remote_agents: bool,
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
            remote_agents: true,
            workspace_tools: true,
            projects: true,
        }
    }

    /// Hook Workspace: the chat agent, the account's Workspace data and the
    /// other machines. It is not a host: Hook on the same computer runs the
    /// agents, and Workspace forwards a "this computer" start to it.
    pub const fn workspace() -> Self {
        Self {
            preview_pages: false,
            preview_workspace: false,
            coding_agents: false,
            remote_agents: true,
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
            remote_agents: true,
            workspace_tools: true,
            projects: false,
        }
    }
}

fn emit_agents(state: &AppState) {
    // One payload feeds both the title-bar pill and the per-chat task board.
    let overview = state.agents.overview();
    let _ = state.app.emit("hook://agents", &overview);
    // A controller watching a chat on this machine gets the same board. The
    // overview is per account, but the relay fans out by chat.
    if let Ok(payload) = serde_json::to_value(&overview) {
        if let Ok(chats) = state.remote_chats.lock() {
            for chat_id in chats.iter() {
                let _ = state.relay.publish(
                    chat_id,
                    serde_json::json!({ "type": "agents", "overview": payload }),
                );
            }
        }
    }
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
            commands::set_custom_provider,
            commands::clear_custom_provider,
            commands::custom_models,
            commands::set_cloud_sync,
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
            commands::create_remote_coding_chat,
            commands::fetch_remote_chat,
            commands::remote_projects,
            commands::remote_create_project,
            commands::devices_list,
            commands::subscribe_chat,
            commands::unsubscribe_chat,
            commands::device_rename,
            commands::device_set_remote,
            commands::device_remove,
            commands::stop_remote_agent,
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

/// Hook is the machine host, so closing its window must not stop the work: the
/// window hides to the tray and the agent processes keep running. Quit lives in
/// the tray menu, and `on_exit` still kills every child.
#[cfg(feature = "tray")]
fn install_tray(app: &mut tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open = MenuItem::with_id(app, "open", "Open Hook", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Hook", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let Some(icon) = app.default_window_icon().cloned() else {
        return Ok(());
    };
    TrayIconBuilder::with_id("hook")
        .icon(icon)
        .tooltip("Hook — agents keep working while this window is closed")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
            "quit" => {
                on_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.unminimize();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)?;

    if let Some(window) = app.get_webview_window("main") {
        let handle = app.handle().clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                if let Some(window) = handle.get_webview_window("main") {
                    let _ = window.hide();
                }
            }
        });
    }
    Ok(())
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
            // Repositories are account data: a free account never syncs, and a
            // paid account with the switch off does not either. No sync, no git
            // credential to mint.
            if auth.is_free() || auth.cloud_sync() == Some(false) {
                return;
            }
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

    // The live account surface: presence, remote commands and chat fan-out.
    // The relay is a transport only; `remote.rs` decides what a command means.
    let relay_emit: relay::Emitter = {
        let app = app.handle().clone();
        Arc::new(move |event, payload| {
            let _ = app.emit(event, payload);
        })
    };
    let relay = Arc::new(relay::RelayClient::new(relay_emit));

    let preview_emit: preview::Emitter = {
        let app = app.handle().clone();
        let relay = relay.clone();
        Arc::new(move |event| {
            let _ = app.emit("hook://preview", &event);
            // The same panel event goes to a controller watching this chat.
            // The URL is the host's loopback address; the viewer replaces it
            // with a ticket URL minted by the account service.
            let Ok(mut payload) = serde_json::to_value(&event) else {
                return;
            };
            if payload.get("active").and_then(serde_json::Value::as_bool) == Some(false) {
                if let Some(chat_id) = payload.get("chatId").and_then(serde_json::Value::as_str) {
                    let _ = relay.publish(
                        chat_id,
                        serde_json::json!({ "type": "previewClosed", "chatId": chat_id }),
                    );
                }
                return;
            }
            let Some(chat_id) = payload
                .get("chatId")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
            else {
                return;
            };
            if let Some(object) = payload.as_object_mut() {
                object.insert(
                    "deviceId".into(),
                    serde_json::Value::String(relay.device_id()),
                );
                object.insert(
                    "deviceName".into(),
                    serde_json::Value::String(relay.view().self_name),
                );
            }
            let _ = relay.publish(
                &chat_id,
                serde_json::json!({ "type": "preview", "preview": payload }),
            );
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
    // An endpoint saved on another device just became the one this app talks to.
    // The model card has to be asked again; the window hears about it through
    // the `hook://sync` event the engine emits.
    sync.on_settings_changed({
        let app = app.handle().clone();
        Arc::new(move || {
            if let Some(state) = app.try_state::<Arc<AppState>>() {
                let state = state.inner().clone();
                tauri::async_runtime::spawn(async move {
                    commands::refresh_capabilities(&state).await;
                });
            }
        })
    });

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
        channel: Arc::new(channel::Channel::new()),
        relay: relay.clone(),
        remote_chats: Arc::new(Mutex::new(HashSet::new())),
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

    // Hook Browser reads this: a loopback channel beside the account file, with
    // the same store and the same turn the window uses. Off with HOOK_CHANNEL=0.
    state.channel.serve(
        Arc::new(channel::LiveBackend {
            state: state.clone(),
        }),
        &data_dir,
    );
    // A coding chat written before machines existed belongs to this computer;
    // give it the id the account knows so its stub can travel. A controller
    // (Workspace, the phone) never owns a direct chat, even if an old sync left
    // one behind.
    if capabilities.coding_agents {
        state
            .store
            .own_coding(&auth.device_id(), &state.agents.device_name());
    }
    // Now that the state it acts for exists, the tool bridge can take calls.
    bridge.serve(state.clone());
    // One connection per running product: a host for Hook, a controller for the
    // phone and Workspace. It waits for a session and reconnects on its own.
    relay.serve(state.clone());
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

    // `--headless` is the host without a face: the window is never shown and no
    // tray icon is installed, so a script or a shortcut can start the process
    // that serves the browser's channel and keeps agents running, and nothing
    // appears on the desktop. It is the interim sidecar: the same account, the
    // same turn, and the same channel the browser already talks to, in a process
    // that is not the window someone is using.
    let headless = std::env::args().any(|argument| argument == "--headless");
    if headless {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.hide();
        }
        eprintln!(
            "hook: headless host, channel {}",
            state.channel.describe()
        );
        return Ok(());
    }

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }

    // Only the chat product hosts machines today. Workspace and the phone have
    // no agents to keep alive, so closing their window is still closing them.
    #[cfg(feature = "tray")]
    if product == Product::Chat {
        if let Err(error) = install_tray(app) {
            eprintln!("hook: could not install the tray icon: {error}");
        }
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
