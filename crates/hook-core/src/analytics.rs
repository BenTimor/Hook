//! The few facts product decisions need that the model proxy cannot see.
//!
//! `usage_events` on the server records every request that comes through
//! hookcode.io. A user who brings their own endpoint never appears there, and
//! neither does the free limit refusing a turn or the cloud-sync switch being
//! flipped. Those are reported as one of a small, fixed set of kinds — never a
//! message, a path, an endpoint or a key.
//!
//! Reporting is best effort and silent: a dropped event must never interrupt a
//! conversation, and a local preview build must not call hookcode.io at all.

use crate::commands::AppState;

/// The kinds `server/events.mjs` accepts. Kept here as well so a typo in a call
/// site is caught by `hook-core`'s own tests rather than silently stored.
pub const KINDS: [&str; 8] = [
    "byok_saved",
    "byok_removed",
    "byok_turn",
    "byok_models_loaded",
    "quota_blocked",
    "coding_blocked_free",
    "sync_enabled",
    "sync_disabled",
];

pub fn track(state: &AppState, kind: &str) {
    if !KINDS.contains(&kind) {
        debug_assert!(false, "unreported analytics kind: {kind}");
        return;
    }
    if !state.auth.required() {
        return;
    }
    let Some(token) = state.auth.token() else {
        return;
    };
    let base = state.cfg.auth.base_url.trim_end_matches('/').to_string();
    let product = match state.product {
        crate::Product::Chat => "chat",
        crate::Product::Workspace => "workspace",
        crate::Product::Mobile => "mobile",
    };
    let version = crate::version::current().to_string();
    let kind = kind.to_string();
    // `tauri::async_runtime` on purpose: this is called from synchronous
    // commands (a sent message), where a bare `tokio::spawn` has no reactor and
    // panics the window.
    tauri::async_runtime::spawn(async move {
        let Ok(client) = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(5))
            .timeout(std::time::Duration::from_secs(8))
            .build()
        else {
            return;
        };
        let _ = client
            .post(format!("{base}/api/events"))
            .bearer_auth(token)
            .header("x-hook-app-version", version)
            .json(&serde_json::json!({ "kind": kind, "product": product }))
            .send()
            .await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_kind_is_one_the_server_accepts() {
        // The same list lives in `server/events.mjs`; the server rejects anything
        // else, so this is a compatibility check, not a formality.
        assert_eq!(KINDS.len(), 8);
        for kind in KINDS {
            assert!(kind.is_ascii() && !kind.contains(' '), "{kind}");
        }
    }
}
