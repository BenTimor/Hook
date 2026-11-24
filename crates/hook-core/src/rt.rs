//! The async runtime the backend's background work runs on.
//!
//! Every product used to spawn through `tauri::async_runtime`, which is a global
//! tokio runtime Tauri installs when the app is built. The host process
//! (`crates/hook-host`) has no Tauri app, so the handle is set once at startup by
//! whichever process is running — Tauri's runtime for a window, the host's own
//! for the browser — and everything below spawns through it.
//!
//! Two properties are worth keeping in mind, because both were bugs once:
//!
//! - `Handle::spawn` does not need the caller to be *inside* the runtime. That is
//!   why `crate::rt::spawn` was safe to call from a command thread, and
//!   why `tokio::spawn` was not: the latter panics with "there is no reactor
//!   running", and a panic in a command thread cannot unwind into the window.
//   Nothing here uses `tokio::spawn`.
//! - A spawn with no handle yet must still work. `cargo test` has no startup, and
//!   an event arriving during `setup` must not be the first thing to discover
//!   that. The fallback below is a runtime of our own, created on first use and
//!   leaked, which is exactly what Tauri does for the same reason.

use std::future::Future;
use std::sync::OnceLock;

use tokio::runtime::Handle;

static HANDLE: OnceLock<Handle> = OnceLock::new();

/// Name this process's runtime. Called once, from product startup, before
/// anything can spawn. A second call is ignored: the first process to exist is
/// the one that owns the threads.
pub fn set(handle: Handle) {
    let _ = HANDLE.set(handle);
}

/// The runtime's handle, creating the fallback one if no product named a runtime.
pub fn handle() -> Handle {
    if let Some(handle) = HANDLE.get() {
        return handle.clone();
    }
    // Already inside a runtime (a `#[tokio::test]`, or a caller that ran before
    // startup): use it rather than starting a second pool behind its back.
    if let Ok(handle) = Handle::try_current() {
        return handle;
    }
    detached().clone()
}

/// The runtime of last resort. Built once, leaked on purpose: its tasks are the
/// process's work, so it must outlive every caller and never be dropped.
fn detached() -> &'static Handle {
    static DETACHED: OnceLock<Handle> = OnceLock::new();
    DETACHED.get_or_init(|| {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .thread_name("hook")
            .build()
            .expect("a tokio runtime");
        // Leak it: a `Runtime` stops its threads when dropped, and a task that
        // outlived the caller is the normal case here.
        Box::leak(Box::new(runtime)).handle().clone()
    })
}

/// Spawn a task on this process's runtime.
pub fn spawn<F>(future: F) -> tokio::task::JoinHandle<F::Output>
where
    F: Future + Send + 'static,
    F::Output: Send + 'static,
{
    handle().spawn(future)
}

/// Run blocking work off the runtime's threads. The store, the importers and
/// the image helpers are blocking by nature; a turn awaits their result.
pub fn spawn_blocking<F, R>(work: F) -> tokio::task::JoinHandle<R>
where
    F: FnOnce() -> R + Send + 'static,
    R: Send + 'static,
{
    handle().spawn_blocking(work)
}
