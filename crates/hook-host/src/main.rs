//! Hook Browser's host.
//!
//! The browser is a product like Hook and Hook Workspace: it has its own data
//! folder, syncs the same account, and needs a process that serves the loopback
//! channel its dock and sign-in card read (`crates/hook-core/src/channel.rs`).
//! That process is this one.
//!
//! What it is not: a window. There is no webview, no tray, no IPC surface and no
//! Tauri at all — `hook-core` is linked with `default-features = false`, and the
//! modules that need a window (`commands.rs`, `update.rs`) are not compiled. What
//! remains is the backend: the account, the chat store and its sync engine, the
//! assistant turn, the tools, the relay, the preview server and the channel.
//!
//! Started by `browser/overlay/src/hook/browser/host/hook_host.cc` when no
//! channel answers, with `HOOK_DATA_DIR` naming the folder the browser's gate
//! reads the account from. It runs until the browser exits (which terminates it)
//! or Ctrl+C is pressed.

use std::process::ExitCode;
use std::sync::Arc;

use hook_core::{rt, start, Capabilities, NoopSink, Product, StartOptions};

fn main() -> ExitCode {
    // This process has no Tauri app to install a runtime, so it builds one and
    // names it before anything can spawn. Every background task in the backend
    // (`rt::spawn`) lands here.
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("hook")
        .build()
    {
        Ok(runtime) => runtime,
        Err(error) => {
            eprintln!("hook-host: could not start the runtime: {error}");
            return ExitCode::FAILURE;
        }
    };
    rt::set(runtime.handle().clone());

    // The browser's own folder, resolved the same way a product's is: the debug
    // build nests under `hook-dev`, and `HOOK_DATA_DIR` overrides both (which is
    // how the browser hands this process the folder its gate already reads).
    let data_dir = match hook_core::product_data_dir(Product::Browser.identifier()) {
        Ok(dir) => dir,
        Err(error) => {
            eprintln!("hook-host: could not resolve the data folder: {error}");
            return ExitCode::FAILURE;
        }
    };

    let state = match start(StartOptions {
        data_dir: data_dir.clone(),
        // Nothing bundled: no `pi`, no MinGit. The browser drives agents on the
        // account's other computers instead, so there is no engine to find.
        resource_dir: None,
        product: Product::Browser,
        capabilities: Capabilities::browser(),
        // No window to draw them on. The same facts reach the browser over the
        // channel's routes, which is why this is a no-op and not a hack.
        events: Arc::new(NoopSink),
        // This is its own crate, so its own `CARGO_PKG_VERSION`. It is what
        // `/health` reports and what the browser compares against its own; the
        // release that publishes both bumps them together.
        version: env!("CARGO_PKG_VERSION"),
    }) {
        Ok(state) => state,
        Err(error) => {
            eprintln!("hook-host: could not start: {error}");
            return ExitCode::FAILURE;
        }
    };

    eprintln!(
        "hook-host: {} · channel {}",
        data_dir.display(),
        state.channel.describe()
    );

    // Serve until asked to stop. Ctrl+C is the orderly way out and stops the
    // preview server and any agent child first; the browser terminating the
    // process (which is what it does on exit) skips that, and a descriptor whose
    // pid is gone reads as "not running" to the next browser.
    runtime.block_on(async {
        let _ = tokio::signal::ctrl_c().await;
    });
    hook_core::shutdown(&state);
    ExitCode::SUCCESS
}
