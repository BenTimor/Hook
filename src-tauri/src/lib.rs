mod commands;
mod config;
mod provider;
mod store;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Arc::new(store::Store::new(data_dir).map_err(std::io::Error::other)?);

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }

            app.manage(commands::AppState {
                store,
                streams: Arc::new(Mutex::new(HashMap::new())),
            });

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
        ])
        .run(tauri::generate_context!())
        .expect("error while running Hook");
}
