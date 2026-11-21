//! Desktop sign-in.
//!
//! Hook uses the OAuth device flow so the app never has to spin up a local
//! HTTP listener or register a custom URL scheme:
//!
//!   1. `POST /api/auth/device/start` → secret device code + short user code;
//!   2. open `https://hookcode.io/authorize?code=…` in the system browser;
//!   3. the signed-in, approved user approves that code;
//!   4. `POST /api/auth/device/poll` returns the opaque API token once.
//!
//! The token is kept in a *shared* account file, `%APPDATA%\app.hook\account.json`,
//! so signing in to one Hook product signs in all of them on this machine. Each
//! product still mirrors the old per-app `auth.json` so a downgrade keeps working.
//! The token is what the chat agent, the proxy and the bundled pi runtime present.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

const POLL_LIMIT: Duration = Duration::from_secs(10 * 60);
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn is_valid_device_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// One stable id per installation, kept across sign-ins. It lets this computer
/// rotate its own git token without touching the account's other devices.
fn load_or_create_device(data_dir: &Path) -> String {
    let path = data_dir.join("device.json");
    if let Ok(raw) = fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
                if is_valid_device_id(id) {
                    return id.to_string();
                }
            }
        }
    }
    let id = format!("dev_{}", uuid::Uuid::new_v4().simple());
    let _ = fs::create_dir_all(data_dir);
    let _ = fs::write(
        &path,
        serde_json::json!({ "id": id }).to_string(),
    );
    id
}

/// The one account file the whole Hook family on this machine shares.
///
/// A product's own data directory is `%APPDATA%\app.hook.<product>`; the account
/// lives one level up, next to all of them, so installing a second product finds
/// the first one's sign-in instead of asking again.
///
/// A phone has no such folder. Android's app data directory is
/// `/data/user/0/<package>` and its parent belongs to the system, so the desktop
/// rule would try to write `/data/user/0/app.hook/` and be refused. Each app on a
/// phone has its own container, there is no sibling to share with, and the
/// per-app `auth.json` this store also keeps is the whole answer.
#[cfg(not(any(target_os = "android", target_os = "ios")))]
fn shared_account_path(data_dir: &Path) -> Option<PathBuf> {
    let parent = data_dir.parent()?;
    Some(parent.join("app.hook").join("account.json"))
}

#[cfg(any(target_os = "android", target_os = "ios"))]
fn shared_account_path(_data_dir: &Path) -> Option<PathBuf> {
    None
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SharedAccount {
    /// Bumped when the shape changes; unknown versions are read leniently.
    #[serde(default)]
    version: u32,
    /// One id per machine. The server rotates a git token per device, so both
    /// products must look like the same installation rather than two computers.
    #[serde(default)]
    device_id: String,
    /// The signed-in account, if any. `None` after signing out.
    #[serde(default)]
    session: Option<StoredSession>,
}

fn read_shared(path: &Path) -> Option<SharedAccount> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<SharedAccount>(&raw).ok()
}

fn write_shared(path: &Path, value: &SharedAccount) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Could not save sign-in: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    // A unique temp name: two products signing in at the same moment must not
    // rename each other's half-written file.
    let unique = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.tmp-{}-{unique}", std::process::id()));
    fs::write(&tmp, raw).map_err(|e| format!("Could not save sign-in: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
    }
    // Atomic: a reader (the other Hook product) sees the old file or the new
    // one, never half a token.
    fs::rename(&tmp, path).map_err(|e| format!("Could not save sign-in: {e}"))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub token: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub subject: String,
    pub signed_in_at: i64,
    /// A git-only token minted from `token`. It can read and write this
    /// account's project repositories and nothing else, so it is the one
    /// credential that may reach a coding agent's environment.
    #[serde(default)]
    pub git_token: Option<String>,
    /// `free`, `plus` or `pro` as last reported by the account service. Only
    /// `free` restricts anything, and an older account file without the field
    /// is treated as "not known to be free" until the next check — Hook's
    /// local restrictions follow the server, they never invent a downgrade.
    #[serde(default)]
    pub plan: Option<String>,
    /// Whether this account lets its conversations leave its computers. `None`
    /// means "not known yet" and behaves as on; the server refuses sync for a
    /// free account whatever this says.
    #[serde(default)]
    pub cloud_sync: Option<bool>,
}

/// The free plan's 24-hour message window, as the account service reports it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Quota {
    pub limit: i64,
    pub used: i64,
    pub remaining: i64,
    /// When the oldest counted message falls out of the window.
    pub reset_at: Option<String>,
}

impl Quota {
    pub fn exhausted(&self) -> bool {
        self.limit > 0 && self.used >= self.limit
    }
}

/// What the window needs to draw the login screen or the account section.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthView {
    pub signed_in: bool,
    /// `signed_out`, `pending` or `signed_in`.
    pub state: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub user_code: Option<String>,
    pub verification_url: Option<String>,
    pub message: Option<String>,
    /// The account's entitlement, when known. `None` on a local preview build.
    pub plan: Option<String>,
    /// The account's cloud-sync switch. `None` before the first account check.
    pub cloud_sync: Option<bool>,
    /// The free plan's message window. `None` for a paid account.
    pub quota: Option<Quota>,
}

impl AuthView {
    pub fn signed_out(message: Option<String>) -> Self {
        Self {
            signed_in: false,
            state: "signed_out".into(),
            email: None,
            name: None,
            user_code: None,
            verification_url: None,
            message,
            plan: None,
            cloud_sync: None,
            quota: None,
        }
    }
}

#[derive(Debug, Clone)]
struct Pending {
    generation: u64,
    device_code: String,
    user_code: String,
    verification_url: String,
    deadline_ms: i64,
    interval_secs: u64,
}

#[derive(Debug)]
pub enum LoginOutcome {
    Approved,
    Cancelled,
    Failed(String),
}

#[derive(Debug)]
pub enum RefreshOutcome {
    Valid,
    /// The token was rejected: clear it and show the login screen again.
    Revoked(String),
    /// hookcode.io was unreachable; keep the cached login and let the next
    /// request surface the problem.
    Unreachable(String),
}

pub struct AuthStore {
    path: PathBuf,
    /// The account file shared by every Hook product on this machine.
    account: Option<PathBuf>,
    base_url: String,
    /// Stable identifier for this installation. Not a secret.
    device: String,
    /// When false (local mock builds) the app is always "signed in" and never
    /// talks to hookcode.io.
    required: bool,
    session: Mutex<Option<StoredSession>>,
    /// The free plan's message window as of the last account check. Ephemeral:
    /// the server is the authority and recomputes it on every `/me`.
    quota: Mutex<Option<Quota>>,
    pending: Mutex<Option<Pending>>,
    generation: AtomicU64,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct GitTokenResponse {
    token: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceStart {
    device_code: String,
    user_code: String,
    verification_url: String,
    #[serde(default = "default_interval")]
    interval: u64,
}

fn default_interval() -> u64 {
    2
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicePoll {
    status: String,
    token: Option<String>,
    user: Option<ApiUser>,
    #[serde(default)]
    quota: Option<Quota>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiUser {
    subject: String,
    email: String,
    name: Option<String>,
    approved: bool,
    #[serde(default)]
    plan: Option<String>,
    #[serde(default)]
    cloud_sync: Option<bool>,
}

/// The answer to a native sign-in: the same session the device flow returns.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct GoogleSession {
    token: String,
    user: ApiUser,
    #[serde(default)]
    quota: Option<Quota>,
}

#[derive(Deserialize)]
struct MeResponse {
    user: ApiUser,
    #[serde(default)]
    quota: Option<Quota>,
}

/// The answer to changing an account preference: the account as it now stands.
#[derive(Deserialize)]
struct PreferencesResponse {
    user: ApiUser,
    #[serde(default)]
    quota: Option<Quota>,
}

#[derive(Deserialize)]
struct ErrorBody {
    error: ApiErrorBody,
}

#[derive(Deserialize)]
struct ApiErrorBody {
    message: Option<String>,
}

impl AuthStore {
    pub fn new(
        data_dir: &Path,
        base_url: &str,
        required: bool,
        fallback_token: &str,
    ) -> Self {
        let path = data_dir.join("auth.json");
        let account = shared_account_path(data_dir);
        let legacy_session = || {
            fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<StoredSession>(&raw).ok())
        };

        // Read the shared file first; fall back to this product's old file and
        // adopt it, so the first launch after an update keeps the sign-in. Once
        // the shared file exists it is authoritative — otherwise a sign-out in
        // one product would be undone by another product's old mirror.
        let account_present = account.as_deref().map(|p| p.exists()).unwrap_or(false);
        let mut shared = account.as_deref().and_then(read_shared).unwrap_or_default();
        if shared.version == 0 {
            shared.version = 1;
        }
        let session = if required {
            let adopted = if shared.session.is_some() || account_present {
                shared.session.clone()
            } else {
                legacy_session()
            };
            if shared.session.is_none() {
                shared.session = adopted.clone();
            }
            adopted
        } else {
            // A standalone/direct-provider build keeps its old api_key flow by
            // treating the configured key as the session token.
            Some(StoredSession {
                token: if fallback_token.trim().is_empty() {
                    "mock-local".to_string()
                } else {
                    fallback_token.trim().to_string()
                },
                email: "local@hookcode.io".into(),
                name: Some("Local preview".into()),
                subject: "local-preview".into(),
                signed_in_at: 0,
                git_token: None,
                plan: None,
                cloud_sync: None,
            })
        };
        let device = if is_valid_device_id(&shared.device_id) {
            shared.device_id.clone()
        } else {
            load_or_create_device(data_dir)
        };
        if shared.device_id != device {
            shared.device_id = device.clone();
        }
        if required {
            if let Some(account_path) = &account {
                let _ = write_shared(account_path, &shared);
            }
        }

        Self {
            path,
            account,
            device,
            base_url: base_url.trim_end_matches('/').to_string(),
            required,
            session: Mutex::new(session),
            quota: Mutex::new(None),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(HTTP_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// The account's opaque subject, when signed in. Sync keys everything by it.
    pub fn subject(&self) -> Option<String> {
        lock(&self.session).as_ref().map(|s| s.subject.clone())
    }

    /// Local preview builds never talk to an account service.
    pub fn required(&self) -> bool {
        self.required
    }

    /// Stable identifier for this installation. Not a secret.
    pub fn device_id(&self) -> &str {
        &self.device
    }

    pub fn git_token(&self) -> Option<String> {
        lock(&self.session)
            .as_ref()
            .and_then(|s| s.git_token.clone())
    }

    /// Fetch (or reuse) the git-only token. Refreshed lazily so a token revoked
    /// server-side heals without a new sign-in.
    pub async fn ensure_git_token(&self) -> Option<String> {
        if !self.required {
            return None;
        }
        if let Some(token) = self.git_token() {
            return Some(token);
        }
        let token = self.token()?;
        let response = self
            .client
            .post(format!("{}/api/auth/git-token", self.base_url))
            .bearer_auth(token)
            .header("x-hook-device", self.device_id())
            .json(&serde_json::json!({ "label": "Hook desktop" }))
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            eprintln!("hook: could not mint a git token ({})", response.status());
            return None;
        }
        let body: GitTokenResponse = response.json().await.ok()?;
        let mut session = self.session()?;
        session.git_token = Some(body.token.clone());
        if let Err(error) = self.save_session(&session) {
            eprintln!("hook: could not save the git token: {error}");
            return None;
        }
        Some(body.token)
    }

    pub fn token(&self) -> Option<String> {
        lock(&self.session).as_ref().map(|s| s.token.clone())
    }

    pub fn session(&self) -> Option<StoredSession> {
        lock(&self.session).clone()
    }

    /// The account's entitlement as last reported by the service. `None` means
    /// "not known" (a local preview, or a build that has not reached the server
    /// yet); only a server-confirmed `free` restricts anything locally.
    pub fn plan(&self) -> Option<String> {
        lock(&self.session)
            .as_ref()
            .and_then(|s| s.plan.clone())
            .map(|plan| plan.trim().to_ascii_lowercase())
            .filter(|plan| !plan.is_empty())
    }

    /// A free account: no cloud sync, 100 messages per rolling day through
    /// Hook's model service, no coding agents without a personal provider.
    pub fn is_free(&self) -> bool {
        self.plan().as_deref() == Some("free")
    }

    /// The account's own cloud-sync switch. `None` is "not checked yet".
    pub fn cloud_sync(&self) -> Option<bool> {
        lock(&self.session).as_ref().and_then(|s| s.cloud_sync)
    }

    pub fn quota(&self) -> Option<Quota> {
        lock(&self.quota).clone()
    }

    fn remember_account(&self, user: &ApiUser, quota: Option<Quota>) {
        let Some(mut session) = self.session() else {
            return;
        };
        session.email = user.email.clone();
        session.name = user.name.clone();
        session.subject = user.subject.clone();
        if user.plan.is_some() {
            session.plan = user.plan.clone();
        }
        if user.cloud_sync.is_some() {
            session.cloud_sync = user.cloud_sync;
        }
        if let Err(error) = self.save_session(&session) {
            eprintln!("hook: could not save the account state: {error}");
            return;
        }
        *lock(&self.quota) = quota;
    }

    /// Turn the account's cloud-sync switch on or off. It is account state, not
    /// product state: setting it here changes it for Workspace and the phone as
    /// well, and the server refuses the call for a free account.
    pub async fn set_cloud_sync(&self, enabled: bool) -> Result<AuthView, String> {
        if !self.required {
            return Ok(self.view());
        }
        let Some(token) = self.token() else {
            return Err("Sign in to Hook to change this.".into());
        };
        let response = self
            .client
            .post(format!("{}/api/auth/preferences", self.base_url))
            .bearer_auth(&token)
            .header("x-hook-device", self.device_id())
            .json(&serde_json::json!({ "cloudSync": enabled }))
            .send()
            .await
            .map_err(|e| format!("Could not reach hookcode.io: {e}"))?;
        if !response.status().is_success() {
            return Err(error_message(response, "Could not change cloud sync.").await);
        }
        let body: PreferencesResponse = response
            .json()
            .await
            .map_err(|e| format!("Unexpected account response: {e}"))?;
        self.remember_account(&body.user, body.quota);
        Ok(self.view())
    }

    pub fn view(&self) -> AuthView {
        let mut pending = lock(&self.pending);
        if let Some(entry) = pending.as_ref() {
            if entry.generation == self.generation.load(Ordering::SeqCst)
                && entry.deadline_ms > now_ms()
            {
                return AuthView {
                    signed_in: false,
                    state: "pending".into(),
                    email: None,
                    name: None,
                    user_code: Some(entry.user_code.clone()),
                    verification_url: Some(entry.verification_url.clone()),
                    message: None,
                    plan: None,
                    cloud_sync: None,
                    quota: None,
                };
            }
            *pending = None;
        }
        drop(pending);

        match lock(&self.session).clone() {
            Some(session) => AuthView {
                signed_in: true,
                state: "signed_in".into(),
                email: Some(session.email),
                name: session.name,
                user_code: None,
                verification_url: None,
                message: None,
                plan: session.plan,
                cloud_sync: session.cloud_sync,
                quota: self.quota(),
            },
            None => AuthView::signed_out(None),
        }
    }

    /// Ask hookcode.io for a device code. The returned generation is what
    /// `wait_for_approval` watches so a Cancel or a second login attempt
    /// abandons the old poll loop.
    pub async fn begin(&self) -> Result<(u64, String, u64), String> {
        if !self.required {
            return Err("Local preview does not use sign-in.".into());
        }
        let response = self
            .client
            .post(format!("{}/api/auth/device/start", self.base_url))
            .json(&serde_json::json!({
                "client": "hook-desktop",
                "version": crate::version::current(),
            }))
            .send()
            .await
            .map_err(|e| format!("Could not reach hookcode.io: {e}"))?;
        if !response.status().is_success() {
            return Err(error_message(
                response,
                "Could not start sign-in.",
            )
            .await);
        }
        let started: DeviceStart = response
            .json()
            .await
            .map_err(|e| format!("Unexpected sign-in response: {e}"))?;

        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let interval = started.interval.clamp(1, 10);
        *lock(&self.pending) = Some(Pending {
            generation,
            device_code: started.device_code.clone(),
            user_code: started.user_code.clone(),
            verification_url: started.verification_url.clone(),
            deadline_ms: now_ms() + POLL_LIMIT.as_millis() as i64,
            interval_secs: interval,
        });
        Ok((generation, started.device_code, interval))
    }

    /// Poll until the browser approves, the code expires, or the attempt is
    /// superseded. The token is written to disk before this returns.
    pub async fn wait_for_approval(&self, generation: u64) -> LoginOutcome {
        let (device_code, interval, deadline) = {
            let pending = lock(&self.pending);
            match pending.as_ref() {
                Some(entry) if entry.generation == generation => (
                    entry.device_code.clone(),
                    entry.interval_secs,
                    entry.deadline_ms,
                ),
                _ => return LoginOutcome::Cancelled,
            }
        };

        loop {
            if self.generation.load(Ordering::SeqCst) != generation {
                return LoginOutcome::Cancelled;
            }
            if now_ms() >= deadline {
                self.clear_pending(generation);
                return LoginOutcome::Failed(
                    "The sign-in code expired. Start again from Hook.".into(),
                );
            }
            tokio::time::sleep(Duration::from_secs(interval)).await;
            if self.generation.load(Ordering::SeqCst) != generation {
                return LoginOutcome::Cancelled;
            }

            let response = match self
                .client
                .post(format!("{}/api/auth/device/poll", self.base_url))
                .header("x-hook-device", self.device_id())
                .json(&serde_json::json!({ "deviceCode": device_code }))
                .send()
                .await
            {
                Ok(response) => response,
                Err(e) => {
                    // A dropped poll is not worth losing the whole attempt;
                    // keep trying until the code's deadline.
                    if now_ms() >= deadline {
                        self.clear_pending(generation);
                        return LoginOutcome::Failed(format!(
                            "Could not reach hookcode.io: {e}"
                        ));
                    }
                    eprintln!("hook: sign-in poll failed, retrying: {e}");
                    continue;
                }
            };
            if !response.status().is_success() {
                let message = error_message(response, "Could not check sign-in.").await;
                return LoginOutcome::Failed(message);
            }
            let polled: DevicePoll = match response.json().await {
                Ok(value) => value,
                Err(e) => {
                    return LoginOutcome::Failed(format!(
                        "Unexpected sign-in response: {e}"
                    ))
                }
            };
            match polled.status.as_str() {
                "pending" => continue,
                "approved" => {
                    let Some(token) = polled.token else {
                        return LoginOutcome::Failed(
                            "Sign-in completed without a token. Try again.".into(),
                        );
                    };
                    let Some(user) = polled.user else {
                        return LoginOutcome::Failed(
                            "Sign-in completed without an account. Try again.".into(),
                        );
                    };
                    if !user.approved {
                        self.clear_pending(generation);
                        return LoginOutcome::Failed(
                            "Hook is not enabled for this account.".into(),
                        );
                    }
                    let session = StoredSession {
                        token,
                        email: user.email,
                        name: user.name,
                        subject: user.subject,
                        signed_in_at: now_ms(),
                        git_token: None,
                        plan: user.plan,
                        cloud_sync: user.cloud_sync,
                    };
                    *lock(&self.quota) = polled.quota;
                    if let Err(error) = self.save_session(&session) {
                        return LoginOutcome::Failed(error);
                    }
                    self.clear_pending(generation);
                    return LoginOutcome::Approved;
                }
                "claimed" => {
                    self.clear_pending(generation);
                    return LoginOutcome::Failed(
                        "That sign-in was already used. Start again from Hook.".into(),
                    );
                }
                "expired" => {
                    self.clear_pending(generation);
                    return LoginOutcome::Failed(
                        "The sign-in code expired. Start again from Hook.".into(),
                    );
                }
                _ => {
                    self.clear_pending(generation);
                    return LoginOutcome::Failed(
                        "Unexpected sign-in response. Try again.".into(),
                    );
                }
            }
        }
    }

    pub fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        *lock(&self.pending) = None;
    }

    fn clear_pending(&self, generation: u64) {
        if self.generation.load(Ordering::SeqCst) == generation {
            *lock(&self.pending) = None;
        }
    }

    /// The Google client id this deployment expects a *native* ID token to name.
    ///
    /// Asked of the server at sign-in rather than compiled into the app: the
    /// phone talks to whichever server the build points at, and a client id
    /// baked into an APK would be one deployment's.
    pub async fn google_client_id(&self) -> Result<Option<String>, String> {
        if !self.required {
            return Ok(None);
        }
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Config {
            google_client_id: Option<String>,
        }
        let response = self
            .client
            .get(format!("{}/api/auth/config", self.base_url))
            .send()
            .await
            .map_err(|e| format!("Could not reach hookcode.io: {e}"))?;
        if !response.status().is_success() {
            return Ok(None);
        }
        let config: Config = response
            .json()
            .await
            .map_err(|e| format!("Unexpected sign-in response: {e}"))?;
        Ok(config.google_client_id.filter(|id| !id.trim().is_empty()))
    }

    /// Sign in with the ID token the phone's own account sheet returned.
    ///
    /// The token is checked by the server before it becomes a session, so it is
    /// a bearer in transit and nothing more. Choosing the account picker
    /// supersedes a pending device code: the person made a choice, and a code
    /// they are no longer looking at must not win later.
    pub async fn login_with_google(&self, id_token: &str) -> Result<AuthView, String> {
        if !self.required {
            return Err("Local preview does not use sign-in.".into());
        }
        let response = self
            .client
            .post(format!("{}/api/auth/google", self.base_url))
            .header("x-hook-device", self.device_id())
            .json(&serde_json::json!({ "idToken": id_token }))
            .send()
            .await
            .map_err(|e| format!("Could not reach hookcode.io: {e}"))?;
        if !response.status().is_success() {
            let status = response.status();
            let message =
                error_message(response, "Google could not sign this account in.").await;
            // A phone has no console; this is what `adb logcat` reads when the
            // account picker worked and the exchange did not.
            eprintln!("hook: google sign-in refused ({status}): {message}");
            return Err(message);
        }
        let session: GoogleSession = response
            .json()
            .await
            .map_err(|e| format!("Unexpected sign-in response: {e}"))?;
        self.cancel();
        *lock(&self.quota) = session.quota;
        self.save_session(&StoredSession {
            token: session.token,
            email: session.user.email,
            name: session.user.name,
            subject: session.user.subject,
            signed_in_at: now_ms(),
            git_token: None,
            plan: session.user.plan,
            cloud_sync: session.user.cloud_sync,
        })?;
        Ok(self.view())
    }

    pub fn save_session(&self, session: &StoredSession) -> Result<(), String> {
        if !self.required {
            *lock(&self.session) = Some(session.clone());
            return Ok(());
        }
        // The shared file is the one that matters: it is what the other
        // products on this machine read.
        if let Some(account) = &self.account {
            write_shared(
                account,
                &SharedAccount {
                    version: 1,
                    device_id: self.device.clone(),
                    session: Some(session.clone()),
                },
            )?;
        }
        // Mirror the old per-app file so a downgraded build still starts signed in.
        fs::create_dir_all(self.path.parent().unwrap_or(Path::new(".")))
            .map_err(|e| format!("Could not save sign-in: {e}"))?;
        let raw = serde_json::to_string_pretty(session).map_err(|e| e.to_string())?;
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, raw).map_err(|e| format!("Could not save sign-in: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &self.path).map_err(|e| format!("Could not save sign-in: {e}"))?;
        *lock(&self.session) = Some(session.clone());
        Ok(())
    }

    pub fn clear_session(&self) {
        if !self.required {
            return;
        }
        *lock(&self.session) = None;
        *lock(&self.quota) = None;
        let _ = fs::remove_file(&self.path);
        // Signing out is an account decision, not a product decision: drop the
        // session from the shared file so every Hook product asks again.
        if let Some(account) = &self.account {
            let _ = write_shared(
                account,
                &SharedAccount {
                    version: 1,
                    device_id: self.device.clone(),
                    session: None,
                },
            );
        }
    }

    /// Confirm the cached token is still valid and still approved. Called on
    /// launch and after a window reload; a revoked account is signed out here
    /// rather than on its next message.
    pub async fn refresh(&self) -> RefreshOutcome {
        if !self.required {
            return RefreshOutcome::Valid;
        }
        let Some(token) = self.token() else {
            return RefreshOutcome::Valid;
        };
        let response = match self
            .client
            .get(format!("{}/api/auth/me", self.base_url))
            .bearer_auth(&token)
            .send()
            .await
        {
            Ok(response) => response,
            Err(e) => return RefreshOutcome::Unreachable(e.to_string()),
        };
        if response.status().is_success() {
            if let Ok(me) = response.json::<MeResponse>().await {
                self.remember_account(&me.user, me.quota);
            }
            return RefreshOutcome::Valid;
        }
        if response.status() == reqwest::StatusCode::UNAUTHORIZED
            || response.status() == reqwest::StatusCode::FORBIDDEN
        {
            let message = error_message(
                response,
                "Your Hook access is no longer active. Sign in again.",
            )
            .await;
            self.clear_session();
            return RefreshOutcome::Revoked(message);
        }
        RefreshOutcome::Unreachable(format!("hookcode.io returned {}", response.status()))
    }

    /// Best-effort server-side revocation, then forget the token locally. A
    /// network failure must not trap the user in a signed-in state.
    pub async fn logout(&self) {
        if !self.required {
            return;
        }
        if let Some(token) = self.token() {
            let _ = self
                .client
                .post(format!("{}/api/auth/token/logout", self.base_url))
                .bearer_auth(token)
                .timeout(Duration::from_secs(6))
                .send()
                .await;
        }
        self.cancel();
        self.clear_session();
    }
}

async fn error_message(response: reqwest::Response, fallback: &str) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    if let Ok(parsed) = serde_json::from_str::<ErrorBody>(&body) {
        if let Some(message) = parsed.error.message {
            return message;
        }
    }
    if body.trim().is_empty() {
        format!("{fallback} ({status})")
    } else {
        format!("{fallback} ({status})")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (AuthStore, PathBuf) {
        let base = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        // A product's data directory is one level below the family root, which
        // is where the shared account file lives.
        let dir = base.join("app.hook.chat");
        fs::create_dir_all(&dir).unwrap();
        (AuthStore::new(&dir, "https://hookcode.io/", true, ""), base)
    }

    #[test]
    fn starts_signed_out() {
        let (auth, dir) = store();
        let view = auth.view();
        assert!(!view.signed_in);
        assert_eq!(view.state, "signed_out");
        assert!(auth.token().is_none());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn persists_and_clears_the_session() {
        let (auth, dir) = store();
        let session = StoredSession {
            token: "hk_test_token".into(),
            email: "member@example.test".into(),
            name: Some("Member".into()),
            subject: "subject-1".into(),
            signed_in_at: 1,
            git_token: None,
            plan: None,
            cloud_sync: None,
        };
        auth.save_session(&session).unwrap();
        let reopened = AuthStore::new(&dir.join("app.hook.chat"), "https://hookcode.io", true, "");
        let view = reopened.view();
        assert!(view.signed_in);
        assert_eq!(view.state, "signed_in");
        assert_eq!(view.email.as_deref(), Some("member@example.test"));
        assert_eq!(reopened.token().as_deref(), Some("hk_test_token"));

        reopened.clear_session();
        assert!(reopened.token().is_none());
        assert!(!dir.join("app.hook.chat").join("auth.json").exists());
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn base_url_trailing_slash_is_removed() {
        let (auth, dir) = store();
        assert_eq!(auth.base_url(), "https://hookcode.io");
        fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn local_preview_is_signed_in_without_a_file() {
        let base = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        let dir = base.join("app.hook.chat");
        fs::create_dir_all(&dir).unwrap();
        let auth = AuthStore::new(&dir, "http://127.0.0.1:8787", false, "");
        let view = auth.view();
        assert!(view.signed_in);
        assert_eq!(view.state, "signed_in");
        assert_eq!(auth.token().as_deref(), Some("mock-local"));
        assert!(!dir.join("app.hook.chat").join("auth.json").exists());

        let direct = AuthStore::new(&dir, "https://api.example.test", false, "sk-direct");
        assert_eq!(direct.token().as_deref(), Some("sk-direct"));
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn one_sign_in_serves_every_product_on_the_machine() {
        let base = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        let chat_dir = base.join("app.hook.chat");
        let workspace_dir = base.join("app.hook.workspace");
        fs::create_dir_all(&chat_dir).unwrap();

        let chat = AuthStore::new(&chat_dir, "https://hookcode.io", true, "");
        chat.save_session(&StoredSession {
            token: "hk_shared".into(),
            email: "member@example.test".into(),
            name: Some("Member".into()),
            subject: "subject-1".into(),
            signed_in_at: 7,
            git_token: None,
            plan: None,
            cloud_sync: None,
        })
        .unwrap();

        // The second product starts from the same account without signing in.
        let workspace = AuthStore::new(&workspace_dir, "https://hookcode.io", true, "");
        assert_eq!(workspace.token().as_deref(), Some("hk_shared"));
        assert_eq!(workspace.subject().as_deref(), Some("subject-1"));
        // ...and the server sees one installation, not two computers.
        assert_eq!(workspace.device_id(), chat.device_id());

        // Signing out of either one signs both out.
        workspace.clear_session();
        let reopened = AuthStore::new(&chat_dir, "https://hookcode.io", true, "");
        assert!(reopened.token().is_none());
        fs::remove_dir_all(base).ok();
    }

    #[test]
    fn adopts_the_old_per_app_session_once() {
        let base = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        let dir = base.join("app.hook.chat");
        fs::create_dir_all(&dir).unwrap();
        let legacy = StoredSession {
            token: "hk_legacy".into(),
            email: "old@example.test".into(),
            name: None,
            subject: "subject-old".into(),
            signed_in_at: 1,
            git_token: None,
            plan: None,
            cloud_sync: None,
        };
        fs::write(dir.join("auth.json"), serde_json::to_string(&legacy).unwrap()).unwrap();

        let auth = AuthStore::new(&dir, "https://hookcode.io", true, "");
        assert_eq!(auth.token().as_deref(), Some("hk_legacy"));
        // The shared file was written, so the next product finds it too.
        assert!(base.join("app.hook").join("account.json").exists());
        fs::remove_dir_all(base).ok();
    }
}
