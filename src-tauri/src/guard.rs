use std::fs;
use std::path::{Path, PathBuf};

/// The guard extension is compiled into the binary and materialized into the
/// app data directory on every launch so `pi -e <path>` always has a stable
/// file to load, regardless of install location or dev/prod paths.
pub const GUARD_SOURCE: &str = include_str!("../resources/hook-guard.mjs");

pub fn ensure(data_dir: &Path) -> Result<PathBuf, String> {
    let path = data_dir.join("hook-guard.mjs");
    let stale = fs::read_to_string(&path)
        .map(|current| current != GUARD_SOURCE)
        .unwrap_or(true);
    if stale {
        fs::write(&path, GUARD_SOURCE)
            .map_err(|e| format!("Could not write the agent guard: {e}"))?;
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guard_blocks_bash_without_a_timeout() {
        assert!(GUARD_SOURCE.contains("event.toolName !== \"bash\""));
        assert!(GUARD_SOURCE.contains("block: true"));
        assert!(GUARD_SOURCE.contains("PI_BASH_MAX_TIMEOUT"));
        // Node built-ins only: the guard is copied into the user's data folder,
        // where package imports could never resolve.
        for line in GUARD_SOURCE
            .lines()
            .filter(|line| line.trim_start().starts_with("import "))
        {
            assert!(
                line.contains("from \"node:"),
                "guard may only import Node built-ins: {line}"
            );
        }
        assert!(GUARD_SOURCE.contains("report_progress"));
        // The user's checklist: the tool and the plain-language rule live here.
        assert!(GUARD_SOURCE.contains("update_plan"));
        assert!(GUARD_SOURCE.contains("no file names"));
        assert!(GUARD_SOURCE.contains("plan.json"));
        // The guidance must forbid batching the plan to the end of the run, not
        // just describe the fields: that is what left the board stuck on step 1.
        assert!(GUARD_SOURCE.contains("not a report you write at the end"));
        assert!(GUARD_SOURCE.contains("still shown `active` is a lie"));
        // A long run must be pulled back to the checklist even if the model
        // ignores the system prompt, without ever deadlocking it.
        assert!(GUARD_SOURCE.contains("PLAN_NUDGE_AFTER"));
        assert!(GUARD_SOURCE.contains("PLAN_BLOCK_AFTER"));
        assert!(GUARD_SOURCE.contains("pi.on(\"tool_result\""));
        assert!(GUARD_SOURCE.contains("[Hook checklist]"));
        assert!(GUARD_SOURCE.contains("without updating the user's checklist"));
        assert!(GUARD_SOURCE.contains("callsSincePlan = 0;"));
        // The preview panel: the coding agent points it at a page from the
        // project, and the guard refuses anything outside it or anything that
        // is not HTML.
        assert!(GUARD_SOURCE.contains("name: \"show_preview\""));
        assert!(GUARD_SOURCE.contains("preview file must stay inside the project"));
        assert!(GUARD_SOURCE.contains("must be an .html page"));
        assert!(GUARD_SOURCE.contains("`v-${Date.now()}-${process.pid}.json`"));
        assert!(GUARD_SOURCE.contains("It is optional"));
        // The guidance must forbid heartbeat updates, not encourage them.
        assert!(GUARD_SOURCE.contains("still working"));
        assert!(GUARD_SOURCE.contains("Long stretches of silence"));
        assert!(!GUARD_SOURCE.contains("roughly every couple of minutes"));
    }

    #[test]
    fn writes_the_guard_once() {
        let dir = std::env::temp_dir().join(format!("hook-guard-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let path = ensure(&dir).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), GUARD_SOURCE);
        assert_eq!(ensure(&dir).unwrap(), path);
    }
}
