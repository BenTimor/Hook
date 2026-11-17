//! The Hook Workspace desktop shell.
//!
//! It links the same `hook-core` as the chat app: the account, the synced
//! chats, the coding agents and the assistant turn are the same code. The
//! difference is the window (its own `tauri.conf.json`), the UI, and the fact
//! that this product has no preview panel — `Capabilities::workspace()` tells
//! the chat agent so.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    hook_core::builder(
        hook_core::Product::Workspace,
        hook_core::Capabilities::workspace(),
    )
    .build(tauri::generate_context!())
    .expect("error while building Hook Workspace")
    .run(|app, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            hook_core::on_exit(app);
        }
    });
}
