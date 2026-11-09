mod agent;
mod commands;
mod config;
mod guard;
mod projects;
mod provider;
mod runtime;
mod settings;
mod store;
mod tools;
mod turn;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager};
use tokio::sync::mpsc;

use crate::agent::{AgentManager, Signal};
use crate::commands::AppState;

// Re-exported for the integration tests so they use the exact same guard text
// and command line as the runtime.
pub use crate::agent::agent_args;
pub fn guard_source() -> &'static str {
    crate::guard::GUARD_SOURCE
}

fn emit_agents(state: &AppState) {
    let _ = state.app.emit(
        "hook://agents",
        serde_json::json!({
            "working": state.agents.working_count(),
            "live": state.agents.live_count(),
        }),
    );
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            let store = Arc::new(store::Store::new(data_dir.clone()).map_err(std::io::Error::other)?);
            let settings = Arc::new(settings::SettingsStore::new(&data_dir));
            let projects = Arc::new(projects::ProjectsStore::new(&data_dir));
            let cfg = Arc::new(
                config::get()
                    .map_err(|e| std::io::Error::other(e))?
                    .clone(),
            );
            // Written at startup as well as before each run, so the engine's
            // config on disk always matches this build.
            let engine = runtime::resolve(app.path().resource_dir().ok().as_deref(), &data_dir)
                .map(|engine| {
                    if let Err(error) = runtime::write_agent_home(&engine, &cfg) {
                        eprintln!("hook: {error}");
                    }
                    engine
                });

            let (signal_tx, mut signal_rx) = mpsc::unbounded_channel();
            let agents = Arc::new(AgentManager::new(
                &data_dir,
                cfg.clone(),
                engine,
                settings.clone(),
                projects.clone(),
                signal_tx,
            ));

            let state = Arc::new(AppState {
                app: app.handle().clone(),
                store,
                settings,
                projects,
                agents,
                streams: Arc::new(Mutex::new(HashMap::new())),
                turns: turn::TurnState::default(),
                vision_off: Arc::new(Default::default()),
            });
            app.manage(state.clone());

            // One supervisor drains every agent signal: keeps the UI indicator
            // honest and wakes the owning chat when an agent needs attention.
            let supervisor = state.clone();
            tauri::async_runtime::spawn(async move {
                while let Some(signal) = signal_rx.recv().await {
                    match signal {
                        Signal::Changed => emit_agents(&supervisor),
                        Signal::Wake(wake) => {
                            emit_agents(&supervisor);
                            if let Some(info) = supervisor.agents.get(&wake.agent_id) {
                                turn::on_agent_event(supervisor.clone(), info);
                            }
                        }
                    }
                }
            });

            // One tick a second: collect progress notes and hand due batches to
            // the chats. Coding agents write to a mailbox; this is what turns
            // that into chat messages (at most once per update interval).
            let ticker = state.clone();
            let interval = std::time::Duration::from_secs(
                cfg.coding.update_interval_seconds.clamp(10, 3600),
            );
            tauri::async_runtime::spawn(async move {
                let mut tick = tokio::time::interval(std::time::Duration::from_secs(1));
                loop {
                    tick.tick().await;
                    ticker.agents.harvest();
                    ticker.agents.flush_due(interval);
                }
            });

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            Ok(())
        })
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
            commands::read_image,
            commands::open_image,
            commands::save_image_as,
            commands::open_path,
            commands::agents_overview,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Hook")
        .run(|app, event| {
            // Coding agents are children of this process: make sure none of them
            // survive the window closing.
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(state) = app.try_state::<Arc<AppState>>() {
                    state.agents.kill_all_sync();
                }
            }
        });
}
