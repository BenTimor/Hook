use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// Runtime preferences that are *not* part of the compiled-in harness config.
/// Only one remains: where the user's projects live.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Absolute path to the folder that holds every project. A stale
    /// `pi_command` in an existing settings.json is ignored on load.
    #[serde(default)]
    pub projects_dir: Option<String>,
}

pub struct SettingsStore {
    path: PathBuf,
    data: Mutex<Settings>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub fn default_projects_dir() -> PathBuf {
    home_dir().join("Documents").join("Hook")
}

impl SettingsStore {
    pub fn new(app_data_dir: &Path) -> Self {
        let path = app_data_dir.join("settings.json");
        let data = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();
        let store = Self {
            path,
            data: Mutex::new(data),
        };
        // Make sure the projects root exists so the first request never fails.
        let _ = fs::create_dir_all(store.projects_dir());
        store
    }

    fn save_locked(&self, data: &Settings) -> Result<(), String> {
        let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, raw).map_err(|e| format!("Could not save settings: {e}"))?;
        fs::rename(&tmp, &self.path).map_err(|e| format!("Could not save settings: {e}"))
    }

    /// Canonical projects root. Falls back to `~/Documents/Hook` when unset.
    pub fn projects_dir(&self) -> PathBuf {
        let configured = lock(&self.data).projects_dir.clone();
        let candidate = configured
            .map(PathBuf::from)
            .unwrap_or_else(default_projects_dir);
        resolve_dir(&candidate).unwrap_or(candidate)
    }

    pub fn set_projects_dir(&self, raw: &str) -> Result<PathBuf, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("Choose a folder for your projects.".into());
        }
        let path = PathBuf::from(trimmed);
        fs::create_dir_all(&path).map_err(|e| format!("Could not create {trimmed}: {e}"))?;
        let canonical = crate::store::strip_verbatim(
            path.canonicalize()
                .map_err(|e| format!("Could not open {trimmed}: {e}"))?,
        );
        if !canonical.is_dir() {
            return Err(format!("{trimmed} is not a folder."));
        }
        let mut data = lock(&self.data);
        data.projects_dir = Some(canonical.to_string_lossy().to_string());
        self.save_locked(&data)?;
        Ok(canonical)
    }

}

fn resolve_dir(path: &Path) -> Option<PathBuf> {
    path.canonicalize()
        .ok()
        .filter(|p| p.is_dir())
        .map(crate::store::strip_verbatim)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_dir_is_under_documents() {
        let dir = default_projects_dir();
        assert!(dir.ends_with("Documents/Hook") || dir.ends_with("Documents\\Hook"));
    }

    #[test]
    fn rejects_empty_projects_dir() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(store.set_projects_dir("   ").is_err());
    }

    #[test]
    fn persists_projects_dir() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let target = tmp.join("projects");
        let store = SettingsStore::new(&tmp);
        let saved = store.set_projects_dir(&target.to_string_lossy()).unwrap();
        assert_eq!(store.projects_dir(), saved);

        let reopened = SettingsStore::new(&tmp);
        assert_eq!(reopened.projects_dir(), saved);
    }
}
