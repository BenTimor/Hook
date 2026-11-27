//! The desktop shell for Hook's chat product.
//!
//! Everything below the window lives in `hook-core`, so both Hook products run
//! the same backend: the account, the synced chats, the coding-agent supervisor
//! and the assistant turn. A product chooses what its chat agent may do through
//! `Capabilities` — Hook Workspace, for example, has no preview panel.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    hook_core::builder(
        hook_core::Product::Chat,
        hook_core::Capabilities::chat(),
        env!("CARGO_PKG_VERSION"),
    )
        .build(tauri::generate_context!())
        .expect("error while building Hook")
        .run(|app, event| {
            // Closing the window hides it to the tray, and on macOS the Dock
            // icon is then the natural way back. `applicationShouldHandleReopen`
            // reaches us as this event; without it a hidden window would stay
            // hidden even though the user clicked the Dock.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen {
                has_visible_windows,
                ..
            } = &event
            {
                if !has_visible_windows {
                    use tauri::Manager;
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }

            // Coding agents are children of this process: make sure none of them
            // survive the window closing.
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                hook_core::on_exit(app);
            }
        });
}
