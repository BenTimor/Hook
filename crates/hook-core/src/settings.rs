use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::UNIX_EPOCH;

use serde::{Deserialize, Serialize};

use crate::store::now_ms;

/// A model endpoint the user brought themselves.
///
/// It lives in this *product's* `settings.json`, not in the shared account file:
/// two products can point at two different providers. A paid account with cloud
/// sync on also keeps one encrypted copy on the account
/// (`server/provider.mjs`), so a key typed on one computer reaches the user's
/// phone and Workspace. With sync off — or on the free plan, which never syncs —
/// it never leaves this computer. The account copy is encrypted at rest and the
/// key is only ever read back by a device that is adopting it.
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
    /// has entered one. Shared with the account only when it may sync; see
    /// `CustomProvider`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_provider: Option<CustomProvider>,
    /// When the provider above was last set or cleared here, in Unix ms. It is
    /// the merge stamp the account uses (last write wins) and it survives a
    /// clear, so "use Hook's models again" travels to the other devices instead
    /// of being undone by a stale copy. Zero means "written before this existed"
    /// and is dated from the file when it is loaded.
    #[serde(default)]
    pub custom_provider_changed_at: i64,
    /// The account this endpoint was typed or adopted under. A key belongs to a
    /// person, not to a machine: when a different account signs in here the
    /// endpoint keeps working (as it always has) but is never uploaded to that
    /// account's cloud copy. `None` on a build with no account service, and on a
    /// file written before this field existed — that one is claimed by the first
    /// account to sync it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_provider_account: Option<String>,
    /// Folders a controller starred in this machine's folder picker, as absolute
    /// paths on *this* computer. They are the shortcuts the relay's
    /// `folders.browse` lists before Home and Projects, so a controller that
    /// starts chats in the same three folders does not walk to them every time.
    /// Not account data: a path exists here or nowhere, so it lives in this
    /// product's settings rather than in the account.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub pinned_folders: Vec<String>,
}

/// How many starred folders one machine keeps. A longer list is a folder tree,
/// not a shortcut, and every `folders.browse` root answer would carry it.
pub const MAX_PINNED_FOLDERS: usize = 12;

/// Whether two stored paths name the same folder. Windows paths are case
/// insensitive, and a controller may send the path back with other casing.
pub fn same_path(a: &str, b: &str) -> bool {
    #[cfg(windows)]
    {
        a.eq_ignore_ascii_case(b)
    }
    #[cfg(not(windows))]
    {
        a == b
    }
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
        let mut data = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Settings>(&raw).ok())
            .unwrap_or_default();
        // A provider saved before the account carried a stamp is dated from the
        // file, not from now: it joins the merge at the moment it was actually
        // written, so a newer endpoint from another device still wins.
        if data.custom_provider.is_some() && data.custom_provider_changed_at == 0 {
            data.custom_provider_changed_at = fs::metadata(&path)
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                .map(|since| since.as_millis() as i64)
                .filter(|stamp| *stamp > 0)
                .unwrap_or_else(now_ms);
        }
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

    /// The folders this machine offers as shortcuts in the relay's picker, in
    /// the order they were starred.
    pub fn pinned_folders(&self) -> Vec<String> {
        lock(&self.data).pinned_folders.clone()
    }

    /// Star or unstar one of this machine's folders. `path` is the host's own
    /// canonical string (see `commands::remote_pin_folder`), so it is stored as
    /// it arrived; a path that is no longer a folder is still stored, because a
    /// drive that is unplugged today is the same folder tomorrow. Returns the
    /// list after the change.
    pub fn set_pinned_folder(&self, path: &str, pinned: bool) -> Result<Vec<String>, String> {
        let path = path.trim();
        if path.is_empty() {
            return Err("Choose a folder first.".into());
        }
        let mut data = lock(&self.data);
        let existing = data
            .pinned_folders
            .iter()
            .position(|entry| same_path(entry, path));
        let mut changed = false;
        if pinned {
            if existing.is_none() {
                if data.pinned_folders.len() >= MAX_PINNED_FOLDERS {
                    return Err(format!(
                        "A machine keeps {MAX_PINNED_FOLDERS} pinned folders. Unpin one first."
                    ));
                }
                data.pinned_folders.push(path.to_string());
                changed = true;
            }
        } else if let Some(index) = existing {
            data.pinned_folders.remove(index);
            changed = true;
        }
        let list = data.pinned_folders.clone();
        if changed {
            self.save_locked(&data)?;
        }
        Ok(list)
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
    /// back out. `account` is the signed-in subject, which is what keeps a key
    /// from crossing to another account that later signs in here.
    pub fn set_custom_provider(
        &self,
        base_url: &str,
        api_key: &str,
        model: &str,
        account: Option<&str>,
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
        data.custom_provider_changed_at = now_ms();
        data.custom_provider_account = account.map(str::to_string);
        self.save_locked(&data)?;
        Ok(provider)
    }

    pub fn clear_custom_provider(&self, account: Option<&str>) -> Result<(), String> {
        let mut data = lock(&self.data);
        if data.custom_provider.is_none() {
            return Ok(());
        }
        data.custom_provider = None;
        // The stamp stays: it is what lets the clear beat a stale copy on
        // another device, and it is the last word on this account's endpoint.
        data.custom_provider_changed_at = now_ms();
        data.custom_provider_account = account.map(str::to_string);
        self.save_locked(&data)
    }

    /// The merge stamp of the endpoint, for the account sync. Zero means this
    /// device has never set or cleared one.
    pub fn provider_changed_at(&self) -> i64 {
        lock(&self.data).custom_provider_changed_at
    }

    /// The account this endpoint belongs to; see `custom_provider_account`.
    pub fn provider_account(&self) -> Option<String> {
        lock(&self.data).custom_provider_account.clone()
    }

    /// An endpoint written before the owner was recorded: the first account to
    /// sync this device takes it, so a key someone already typed still reaches
    /// their phone instead of waiting to be typed twice.
    pub fn claim_provider(&self, account: &str) -> Result<bool, String> {
        let mut data = lock(&self.data);
        if data.custom_provider.is_none() || data.custom_provider_account.is_some() {
            return Ok(false);
        }
        data.custom_provider_account = Some(account.to_string());
        self.save_locked(&data)?;
        Ok(true)
    }

    /// Apply the account's endpoint. An older stamp never wins, so a push that
    /// has not been acknowledged yet cannot be overwritten by a pull that ran
    /// before it, and the device that adopted a change does not echo it back.
    /// Returns whether anything was applied.
    pub fn adopt_provider(
        &self,
        provider: Option<CustomProvider>,
        changed_at: i64,
        account: &str,
    ) -> bool {
        if changed_at <= 0 {
            return false;
        }
        let mut data = lock(&self.data);
        if changed_at <= data.custom_provider_changed_at {
            return false;
        }
        data.custom_provider_changed_at = changed_at;
        data.custom_provider = provider;
        data.custom_provider_account = Some(account.to_string());
        if let Err(error) = self.save_locked(&data) {
            // The account still has the truth, so the next cycle retries rather
            // than the whole sync failing over a settings file.
            eprintln!("hook: could not store a synced endpoint: {error}");
        }
        true
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
    fn pinned_folders_are_this_machines_shortcuts() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(store.pinned_folders().is_empty());
        let list = store.set_pinned_folder("C:\\work\\hook", true).unwrap();
        assert_eq!(list, vec!["C:\\work\\hook"]);
        // Starring it again is not a second entry.
        let again = store.set_pinned_folder("C:\\work\\hook", true).unwrap();
        assert_eq!(again.len(), 1);
        // The list is a shortcut, not a tree: the cap is refused, not trimmed.
        for index in 0..MAX_PINNED_FOLDERS {
            let _ = store.set_pinned_folder(&format!("C:\\work\\{index}"), true);
        }
        assert_eq!(store.pinned_folders().len(), MAX_PINNED_FOLDERS);
        assert!(store.set_pinned_folder("C:\\work\\one-too-many", true).is_err());
        // Unpinning is by path, and survives a restart.
        store.set_pinned_folder("C:\\work\\hook", false).unwrap();
        let reopened = SettingsStore::new(&tmp);
        assert_eq!(reopened.pinned_folders().len(), MAX_PINNED_FOLDERS - 1);
        assert!(!reopened.pinned_folders().iter().any(|p| p == "C:\\work\\hook"));
        // A settings.json written before pins existed reads as none.
        fs::write(tmp.join("settings.json"), r#"{ "memory": true }"#).unwrap();
        assert!(SettingsStore::new(&tmp).pinned_folders().is_empty());
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
            .set_custom_provider(" https://api.example.test/v1/ ", "sk-local", "gpt-4o-mini", Some("subject-a"))
            .unwrap();
        assert_eq!(saved.base_url, "https://api.example.test/v1");
        assert_eq!(saved.model, "gpt-4o-mini");

        let reopened = SettingsStore::new(&tmp);
        assert_eq!(reopened.custom_provider(), Some(saved));

        // Saving the same endpoint again without the key keeps the stored one,
        // which is what a window that never reads the secret back needs.
        let updated = reopened
            .set_custom_provider("https://api.example.test/v1", "", "gpt-4o", Some("subject-a"))
            .unwrap();
        assert_eq!(updated.api_key, "sk-local");
        assert_eq!(updated.model, "gpt-4o");

        reopened.clear_custom_provider(Some("subject-a")).unwrap();
        assert_eq!(SettingsStore::new(&tmp).custom_provider(), None);
    }

    #[test]
    fn the_provider_carries_a_stamp_so_a_clear_can_travel() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert_eq!(store.provider_changed_at(), 0, "nothing to sync yet");
        store
            .set_custom_provider("https://api.example.test/v1", "sk-local", "gpt-4o", Some("subject-a"))
            .unwrap();
        let stamp = store.provider_changed_at();
        assert!(stamp > 0, "saving one stamps it for the account merge");

        // An older copy from another device never overwrites this one, and
        // adopting does not need the key to be re-typed.
        let older = CustomProvider {
            base_url: "https://old.example.test/v1".into(),
            api_key: "sk-old".into(),
            model: "old".into(),
        };
        assert!(!store.adopt_provider(Some(older.clone()), stamp - 1, "subject-a"));
        assert_eq!(store.custom_provider().unwrap().model, "gpt-4o");
        assert!(store.adopt_provider(Some(older), stamp + 1, "subject-a"));
        assert_eq!(store.custom_provider().unwrap().model, "old");

        // A clear is a newer change too, and it survives a restart: it is what
        // stops a device that had not seen it from resurrecting the endpoint.
        let cleared = stamp + 2;
        assert!(store.adopt_provider(None, cleared, "subject-a"));
        assert_eq!(store.custom_provider(), None);
        let reopened = SettingsStore::new(&tmp);
        assert_eq!(reopened.provider_changed_at(), cleared);
        assert_eq!(reopened.custom_provider(), None);
    }

    #[test]
    fn a_provider_saved_before_the_stamp_existed_is_dated_from_its_file() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        fs::write(
            tmp.join("settings.json"),
            r#"{ "customProvider": { "baseUrl": "https://old.example.test/v1", "apiKey": "k", "model": "m" } }"#,
        )
        .unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(
            store.provider_changed_at() > 0,
            "it must join the merge instead of being lost or winning forever"
        );
        assert_eq!(store.custom_provider().unwrap().base_url, "https://old.example.test/v1");
        // It has no owner yet, so the first account to sync claims it once.
        assert_eq!(store.provider_account(), None);
        assert!(store.claim_provider("subject-a").unwrap());
        assert_eq!(store.provider_account().as_deref(), Some("subject-a"));
        // A different account on this machine does not inherit it.
        assert!(!store.claim_provider("subject-b").unwrap());
    }

    #[test]
    fn a_provider_belongs_to_the_account_that_typed_it() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        store
            .set_custom_provider("https://api.example.test/v1", "sk-local", "gpt-4o", Some("subject-a"))
            .unwrap();
        assert_eq!(store.provider_account().as_deref(), Some("subject-a"));
        assert!(!store.claim_provider("subject-b").unwrap());
        assert_eq!(store.provider_account().as_deref(), Some("subject-a"));
        // Adopting from an account makes it that account's.
        assert!(store.adopt_provider(None, store.provider_changed_at() + 1, "subject-b"));
        assert_eq!(store.provider_account().as_deref(), Some("subject-b"));
    }

    #[test]
    fn a_custom_provider_refuses_a_url_it_cannot_talk_to() {
        let tmp = std::env::temp_dir().join(format!("hook-settings-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&tmp).unwrap();
        let store = SettingsStore::new(&tmp);
        assert!(store.set_custom_provider("", "k", "m", None).is_err());
        assert!(store.set_custom_provider("file:///tmp/x", "k", "m", None).is_err());
        assert!(store.set_custom_provider("https://user:pw@host/v1", "k", "m", None).is_err());
        assert!(store.set_custom_provider("https://host/v1", "", "m", None).is_err());
        assert!(store.set_custom_provider("https://host/v1", "k", " ", None).is_err());
        assert!(store.set_custom_provider("https://host/v1", "k", "two words", None).is_err());
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
