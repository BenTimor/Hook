use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

/// A model endpoint the user brought themselves.
///
/// It is deliberately not account data: the key is this product's, kept in this
/// product's `settings.json`, and never uploaded, synced or handed to another
/// Hook product. Two products can point at two different providers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CustomProvider {
    /// Base URL, e.g. `https://api.openai.com/v1`. `/chat/completions` is
    /// appended unless the user pasted the full endpoint.
    pub base_url: String,
    /// The user's own key. Stored on this computer only.
    pub api_key: String,
    /// The model id sent with every request.
    pub model: String,
}

impl CustomProvider {
    pub fn is_complete(&self) -> bool {
        !self.base_url.trim().is_empty()
            && !self.api_key.trim().is_empty()
            && !self.model.trim().is_empty()
    }
}

/// Trim and check a base URL. `http` is accepted for a provider on this
/// machine; anything else is refused rather than silently ignored.
pub fn validate_base_url(raw: &str) -> Result<String, String> {
    let value = raw.trim().trim_end_matches('/');
    if value.is_empty() {
        return Err("Enter the endpoint, for example https://api.openai.com/v1".into());
    }
    if value.len() > 300 {
        return Err("That endpoint is too long.".into());
    }
    let url = reqwest::Url::parse(value)
        .map_err(|_| "That endpoint is not a URL. It should start with https://".to_string())?;
    if !matches!(url.scheme(), "https" | "http") {
        return Err("The endpoint must be an http:// or https:// URL.".into());
    }
    if url.host_str().unwrap_or("").is_empty() {
        return Err("The endpoint has no host name.".into());
    }
    if url.username() != "" || url.password().is_some() {
        return Err("Put the key in the API key field, not in the URL.".into());
    }
    if value.chars().any(|c| c.is_control()) {
        return Err("The endpoint contains an invalid character.".into());
    }
    Ok(value.to_string())
}

/// Runtime preferences that are *not* part of the compiled-in harness config:
/// where the user's projects live, whether the chat may use memory, and whether
/// the advanced view (thinking, tool calls, agent transcripts) is on.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Absolute path to the folder that holds every project. A stale
    /// `pi_command` in an existing settings.json is ignored on load.
    #[serde(default)]
    pub projects_dir: Option<String>,
    /// The user's own switch. `None` means "on", which is the default and also
    /// what every settings.json written before memory existed says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory: Option<bool>,
    /// Show the model's thinking and tool calls, and the coding agents' own
    /// transcripts. Off unless the user asks for it: it is a debugging view,
    /// not the normal conversation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_mode: Option<bool>,
    /// A provider this product talks to instead of Hook's own, once the user
    /// has entered one. Per product on purpose; see `CustomProvider`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_provider: Option<CustomProvider>,
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
        // A personal model key lives in this file. On a Unix install another
        // local user must not be able to read it. On Windows `%APPDATA%` is
        // already per-user.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
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

    /// Whether the chat agent may use long-term memory. On unless the user
    /// turned it off; a settings.json written before memory existed has no key
    /// and must not read as "off".
    pub fn memory_enabled(&self) -> bool {
        lock(&self.data).memory.unwrap_or(true)
    }

    pub fn set_memory_enabled(&self, enabled: bool) -> Result<(), String> {
        let mut data = lock(&self.data);
        data.memory = Some(enabled);
        self.save_locked(&data)
    }

    /// Whether the conversation shows thinking, tool calls and coding-agent
    /// transcripts. Off unless the user turned it on.
    pub fn advanced_mode(&self) -> bool {
        lock(&self.data).advanced_mode.unwrap_or(false)
    }

    pub fn set_advanced_mode(&self, enabled: bool) -> Result<(), String> {
        let mut data = lock(&self.data);
        data.advanced_mode = Some(enabled);
        self.save_locked(&data)
    }

    /// The user's own model endpoint, when they have set a complete one.
    pub fn custom_provider(&self) -> Option<CustomProvider> {
        lock(&self.data)
            .custom_provider
            .clone()
            .filter(CustomProvider::is_complete)
    }

    /// Save the user's own endpoint. An empty `api_key` keeps the stored key,
    /// so the window can show the URL and model without ever reading the secret
    /// back out.
    pub fn set_custom_provider(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
    ) -> Result<CustomProvider, String> {
        let base_url = validate_base_url(base_url)?;
        let model = model.trim();
        if model.is_empty() {
            return Err("Choose or type a model name.".into());
        }
        if model.len() > 200 || model.chars().any(|c| c.is_control() || c.is_whitespace()) {
            return Err("That model name contains an invalid character.".into());
        }
        let mut data = lock(&self.data);
        let key = api_key.trim();
        let key = if key.is_empty() {
            match data.custom_provider.as_ref() {
                Some(existing) if !existing.api_key.is_empty() => existing.api_key.clone(),
                _ => return Err("Enter the API key for this endpoint.".into()),
            }
        } else {
            if key.len() > 4_000 || key.chars().any(|c| c.is_control() || c.is_whitespace()) {
                return Err("That API key contains an invalid character.".into());
            }
            key.to_string()
        };
        let provider = CustomProvider {
            base_url,
            api_key: key,
            model: model.to_string(),
        };
        data.custom_provider = Some(provider.clone());
        self.save_locked(&data)?;
        Ok(provider)
    }

    pub fn clear_custom_provider(&self) -> Result<(), String> {
        let mut data = lock(&self.data);
        data.custom_provider = None;
        self.save_locked(&data)
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
    fn memory_is_on_until_it_is_turned_off() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(store.memory_enabled(), "a fresh install remembers things");
        store.set_memory_enabled(false).unwrap();
        assert!(!store.memory_enabled());
        let reopened = SettingsStore::new(&tmp);
        assert!(!reopened.memory_enabled());
    }

    #[test]
    fn advanced_mode_is_off_until_it_is_turned_on() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(!store.advanced_mode(), "a fresh install keeps the simple view");
        // A file written before the switch existed has no key and must not
        // read as "on".
        fs::write(tmp.join("settings.json"), r#"{ "projectsDir": null }"#).unwrap();
        assert!(!SettingsStore::new(&tmp).advanced_mode());
        store.set_advanced_mode(true).unwrap();
        assert!(store.advanced_mode());
        assert!(SettingsStore::new(&tmp).advanced_mode());
        store.set_advanced_mode(false).unwrap();
        assert!(!SettingsStore::new(&tmp).advanced_mode());
    }

    #[test]
    fn a_custom_provider_survives_a_restart_and_never_needs_its_key_again() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert_eq!(store.custom_provider(), None);
        let saved = store
            .set_custom_provider(" https://api.example.test/v1/ ", "sk-local", "gpt-4o-mini")
            .unwrap();
        assert_eq!(saved.base_url, "https://api.example.test/v1");
        assert_eq!(saved.model, "gpt-4o-mini");

        let reopened = SettingsStore::new(&tmp);
        assert_eq!(reopened.custom_provider(), Some(saved));

        // Saving the same endpoint again without the key keeps the stored one,
        // which is what a window that never reads the secret back needs.
        let updated = reopened
            .set_custom_provider("https://api.example.test/v1", "", "gpt-4o")
            .unwrap();
        assert_eq!(updated.api_key, "sk-local");
        assert_eq!(updated.model, "gpt-4o");

        reopened.clear_custom_provider().unwrap();
        assert_eq!(SettingsStore::new(&tmp).custom_provider(), None);
    }

    #[test]
    fn a_custom_provider_refuses_a_url_it_cannot_talk_to() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(store.set_custom_provider("", "k", "m").is_err());
        assert!(store.set_custom_provider("file:///tmp/x", "k", "m").is_err());
        assert!(store.set_custom_provider("https://user:pw@host/v1", "k", "m").is_err());
        assert!(store.set_custom_provider("https://host/v1", "", "m").is_err());
        assert!(store.set_custom_provider("https://host/v1", "k", " ").is_err());
        assert!(store.set_custom_provider("https://host/v1", "k", "two words").is_err());
        assert_eq!(store.custom_provider(), None);
    }

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
