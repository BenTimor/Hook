//! How the backend tells a product what happened.
//!
//! Everything below `lib.rs` used to hold a Tauri `AppHandle` and call
//! `app.emit(...)`. That is a window handle: it cannot exist in the host process
//! (`crates/hook-host`), which serves the browser's channel with no window at
//! all. The sink is the one thing the backend actually needs from a product —
//! "here is an event, and a payload" — so it is a trait and the handle is not.
//!
//! A product supplies its sink at startup (`boot::Options`). Tauri wraps
//! `AppHandle::emit`; the host has no window to draw and drops them, which is
//! correct rather than lazy: the same facts (a new reply, a signed-in account)
//! reach the browser over the channel's routes, not over events.
//!
//! Emission is synchronous and must stay cheap: a sink is called from the turn,
//! from the sync engine and from the channel, sometimes while a lock is held.

use serde::Serialize;

pub trait EventSink: Send + Sync + 'static {
    fn emit_value(&self, event: &str, payload: serde_json::Value);
}

/// `emit` for any sink, generic over what is being sent.
///
/// The trait cannot carry this itself: a generic method is not object safe, and
/// the state holds `Arc<dyn EventSink>`. A blanket impl restores the call shape
/// the code had with Tauri (`events.emit("hook://auth", &view)`), so a call site
/// that changes keeps the payload type it already had.
pub trait EmitExt: EventSink {
    fn emit<E: Serialize>(&self, event: &str, payload: E) {
        match serde_json::to_value(payload) {
            Ok(value) => self.emit_value(event, value),
            // An event that cannot be serialised is a bug in a payload, not a
            // reason to fail the work that produced it.
            Err(error) => eprintln!("hook: could not serialise {event}: {error}"),
        }
    }
}

impl<T: EventSink + ?Sized> EmitExt for T {}

/// A process with no window. The host serves facts over the channel instead, so
/// there is nothing to deliver here and nothing to log: a `hook://reply` line
/// per token would bury stderr.
pub struct NoopSink;

impl EventSink for NoopSink {
    fn emit_value(&self, _event: &str, _payload: serde_json::Value) {}
}

/// A Tauri window. Gated on the `desktop` feature because the whole point of the
/// host binary is to link the backend without Tauri.
#[cfg(feature = "desktop")]
pub struct TauriSink {
    app: tauri::AppHandle,
}

#[cfg(feature = "desktop")]
impl TauriSink {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app }
    }
}

#[cfg(feature = "desktop")]
impl EventSink for TauriSink {
    fn emit_value(&self, event: &str, payload: serde_json::Value) {
        use tauri::Emitter;
        let _ = self.app.emit(event, payload);
    }
}
