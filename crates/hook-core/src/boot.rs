//! Starting the backend, with or without a window.
//!
//! A product's `setup()` used to be the only way in, which meant the backend
//! could not exist in a process without Tauri. It can: the stores, the account,
//! the sync engine, the coding-agent supervisor, the relay, the preview server
//! and the browser channel are all just work. What differs between a Hook window
//! and the browser's host is the *window*, and that is what `lib.rs` keeps.
//!
//! So there is one `start`: it takes where the data lives, what the product is,
//! and where its events go, and returns the state everything else is driven
//! through. `lib.rs::setup` calls it and then builds a window; `hook-host` calls
//! it and then waits for a signal. Neither can drift from the other, because
//! there is nothing to drift from.
//!
//! Startup order matters in a few places and is commented where it does:
//! `version::set` first (so anything that logs names the product's version), the
//! relay and the channel before anything can call into them, and `coding::recover`
//! / `compact::recover` before the first turn.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, OnceLock};

use tokio::sync::mpsc;

use crate::agent::{AgentManager, Signal};
use crate::events::{EmitExt, EventSink};
use crate::state::AppState;
use crate::{Capabilities, Product};

/// What a process has to name before the backend can answer.
pub struct StartOptions {
    /// This product's own folder: its chats, its settings, its agent home. The
    /// caller resolves it (`lib.rs::resolve_data_dir` for a window,
    /// `crate::product_data_dir` for the host).
    pub data_dir: PathBuf,
    /// Where bundled resources live — the `pi` engine and MinGit. `None` for a
    /// product that ships none, and for a binary run out of a build tree.
    pub resource_dir: Option<PathBuf>,
    pub product: Product,
    pub capabilities: Capabilities,
    /// Where this process says what happened. A window draws them; the host
    /// drops them and serves the same facts over the channel instead.
    pub events: Arc<dyn EventSink>,
    /// This build's version, reported to the account service and shown by the
    /// update check. It belongs to the product, never to this crate
    /// (`version.rs`).
    pub version: &'static str,
}

/// Build the backend for `options` and start its background work.
///
/// Returns the state the caller keeps; nothing here needs a window, and nothing
/// here is allowed to look for one.
pub fn start(options: StartOptions) -> Result<Arc<AppState>, Box<dyn std::error::Error>> {
    // First, so anything that logs or reports "this build" during startup names
    // the product's version rather than hook-core's.
    crate::version::set(options.version);
    let data_dir = options.data_dir;
    let product = options.product;
    let capabilities = options.capabilities;
    let events = options.events;
    std::fs::create_dir_all(&data_dir)?;
    install_panic_log(&data_dir);

    let store = Arc::new(crate::store::Store::new(data_dir.clone()).map_err(std::io::Error::other)?);
    let settings = Arc::new(crate::settings::SettingsStore::new(&data_dir));
    let projects = Arc::new(crate::projects::ProjectsStore::new(&data_dir));
    let cfg = Arc::new(crate::config::get().map_err(std::io::Error::other)?.clone());
    // Memory lives beside the account file, not beside the chats: both products
    // read the same store, and a different account reads a different file.
    let memory = Arc::new(crate::memory::MemoryStore::new(&data_dir, cfg.memory.clone()));
    let auth = Arc::new(crate::auth::AuthStore::new(
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
        crate::rt::spawn(async move {
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
    let vision = Arc::new(AtomicBool::new(false));
    // Both of these only exist so a coding agent can be started: the engine is
    // the `pi` bundle, and git is what a project pushes with. A product without
    // one (the phone, the browser's host) skips the lookup entirely, so it never
    // reports a missing engine it was never going to use.
    let resource_dir = options.resource_dir.as_deref();
    let engine = if capabilities.coding_agents {
        crate::runtime::resolve(resource_dir, &data_dir)
    } else {
        // No engine is bundled with this build; saying so is more honest than
        // looking for one and reporting it missing.
        Err("This product has no coding engine.".to_string())
    };
    let git_runtime = if capabilities.coding_agents {
        crate::git::resolve(resource_dir, &data_dir)
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
    let bridge = Arc::new(crate::bridge::ToolBridge::new());
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
    let relay_emit: crate::relay::Emitter = {
        let events = events.clone();
        Arc::new(move |event, payload| events.emit(event, payload))
    };
    let relay = Arc::new(crate::relay::RelayClient::new(relay_emit));

    let preview_emit: crate::preview::Emitter = {
        let events = events.clone();
        let relay = relay.clone();
        Arc::new(move |event| {
            events.emit("hook://preview", &event);
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

    let sync_emit: crate::sync::Emitter = {
        let events = events.clone();
        Arc::new(move |event, payload| events.emit(event, payload))
    };
    let sync = Arc::new(crate::sync::SyncEngine::new(
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
    // the `hook://sync` event the engine emits. The state does not exist yet —
    // the engine is built before it — so the signal is answered through a cell
    // that is filled the moment it does.
    let state_cell: Arc<OnceLock<Arc<AppState>>> = Arc::new(OnceLock::new());
    sync.on_settings_changed({
        let state_cell = state_cell.clone();
        Arc::new(move || {
            if let Some(state) = state_cell.get() {
                let state = state.clone();
                crate::rt::spawn(async move {
                    crate::provider::refresh_capabilities(&state).await;
                });
            }
        })
    });

    let workspace = Arc::new(crate::workspace::WorkspaceClient::new(&cfg, auth.clone()));

    memory.bind(auth.subject().as_deref());
    let state = Arc::new(AppState {
        events,
        store,
        settings,
        projects,
        memory,
        agents,
        preview: Arc::new(crate::preview::PreviewManager::new(preview_emit)),
        streams: Arc::new(Mutex::new(HashMap::new())),
        turns: crate::turn::TurnState::default(),
        coding: crate::coding::CodingState::default(),
        cfg: cfg.clone(),
        auth: auth.clone(),
        sync: sync.clone(),
        channel: Arc::new(crate::channel::Channel::new()),
        relay: relay.clone(),
        remote_chats: Arc::new(Mutex::new(HashSet::new())),
        mirror: Default::default(),
        vision: vision.clone(),
        vision_off: Arc::new(Default::default()),
        context_role_off: Arc::new(Default::default()),
        imports: Arc::new(crate::import::Importer::new()),
        workspace,
        context: Arc::new(Mutex::new(None)),
        product,
        capabilities,
    });
    let _ = state_cell.set(state.clone());

    // Hook Browser reads this: a loopback channel beside the account file, with
    // the same store and the same turn the window uses. Off with HOOK_CHANNEL=0.
    state.channel.serve(
        Arc::new(crate::channel::LiveBackend {
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
    crate::coding::recover(&state.store);
    // The same for a summary that was being written when the window closed: its
    // marker never carried text and must not hold the chat out of sync.
    crate::compact::recover(&state.store);
    sync.spawn();

    // One request tells us what the model can see. If the card says images, the
    // chat may send them and the engine is told so before any agent starts.
    // Re-run after sign-in and on window reload.
    {
        let state = state.clone();
        crate::rt::spawn(async move {
            crate::provider::refresh_capabilities(&state).await;
        });
    }

    // One supervisor drains every agent signal: keeps the UI indicator honest
    // and wakes the owning chat when an agent needs attention.
    let supervisor = state.clone();
    crate::rt::spawn(async move {
        while let Some(signal) = signal_rx.recv().await {
            match signal {
                Signal::Changed => emit_agents(&supervisor),
                Signal::Wake(wake) => {
                    emit_agents(&supervisor);
                    supervisor.sync.wake();
                    if let Some(info) = supervisor.agents.get(&wake.agent_id) {
                        crate::turn::on_agent_event(supervisor.clone(), info);
                    }
                }
                Signal::Preview(report) => {
                    if let Some(info) = supervisor.agents.get(&report.agent_id) {
                        let root = PathBuf::from(&info.project_path);
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
                    crate::coding::on_record(&supervisor, &chat_id, &agent_id, &record);
                }
            }
        }
    });

    // One tick a second: collect progress notes and hand due batches to the
    // chats. Coding agents write to a mailbox; this is what turns that into
    // chat messages (at most once per update interval).
    let ticker = state.clone();
    let interval = std::time::Duration::from_secs(cfg.coding.update_interval_seconds.clamp(10, 3600));
    crate::rt::spawn(async move {
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

    Ok(state)
}

fn emit_agents(state: &AppState) {
    // One payload feeds both the title-bar pill and the per-chat task board.
    let overview = state.agents.overview();
    state.events.emit("hook://agents", &overview);
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
        let text = format!("{stamp} [{name}] {location}: {info}\n");
        eprintln!("hook: panic {text}");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = file.write_all(text.as_bytes());
        }
    }));
}
