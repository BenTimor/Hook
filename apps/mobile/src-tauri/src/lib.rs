//! The phone shell for Hook.
//!
//! Everything below the window lives in `hook-core`, and this product passes
//! `Capabilities::mobile()`: the conversation, memory, web search and the whole
//! Hook Workspace toolset, but no coding agent, no project folder and no HTML
//! page served from disk. Those need a machine with files on it; a phone has
//! the account.
//!
//! The preview surface is the one split capability. `preview_workspace` is on,
//! because a board, a task and a document are just JSON from the API;
//! `preview_pages` is off, because the page a coding agent writes lives in a
//! project folder this device does not have.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    hook_core::builder(
        hook_core::Product::Mobile,
        hook_core::Capabilities::mobile(),
        env!("CARGO_PKG_VERSION"),
    )
    .plugin(tauri_plugin_google_signin::init())
    .plugin(tauri_plugin_mobile_shell::init())
    .build(tauri::generate_context!())
    .expect("error while building Hook")
    .run(|app, event| {
        // A phone suspends rather than closes; the only exit we get is the one
        // the user makes. Clean up the same way the desktop does.
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            hook_core::on_exit(app);
        }
    });
}
