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
