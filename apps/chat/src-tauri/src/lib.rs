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
