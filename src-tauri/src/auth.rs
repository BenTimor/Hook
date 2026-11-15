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
//! The token is kept in `auth.json` under the app data directory and is what
//! both the chat agent and the bundled pi runtime present to the proxy.

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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSession {
    pub token: String,
    pub email: String,
    #[serde(default)]
    pub name: Option<String>,
    pub subject: String,
    pub signed_in_at: i64,
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
    base_url: String,
    /// When false (local mock builds) the app is always "signed in" and never
    /// talks to hookcode.io.
    required: bool,
    session: Mutex<Option<StoredSession>>,
    pending: Mutex<Option<Pending>>,
    generation: AtomicU64,
    client: reqwest::Client,
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
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiUser {
    subject: String,
    email: String,
    name: Option<String>,
    approved: bool,
}

#[derive(Deserialize)]
struct MeResponse {
    user: ApiUser,
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
        let session = if required {
            fs::read_to_string(&path)
                .ok()
                .and_then(|raw| serde_json::from_str::<StoredSession>(&raw).ok())
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
            })
        };
        Self {
            path,
            base_url: base_url.trim_end_matches('/').to_string(),
            required,
            session: Mutex::new(session),
            pending: Mutex::new(None),
            generation: AtomicU64::new(0),
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(10))
                .timeout(HTTP_TIMEOUT)
                .build()
                .unwrap_or_else(|_| reqwest::Client::new()),
        }
    }

    #[cfg(test)]
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    pub fn token(&self) -> Option<String> {
        lock(&self.session).as_ref().map(|s| s.token.clone())
    }

    pub fn session(&self) -> Option<StoredSession> {
        lock(&self.session).clone()
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
                "version": env!("CARGO_PKG_VERSION"),
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
                    };
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

    pub fn save_session(&self, session: &StoredSession) -> Result<(), String> {
        if !self.required {
            *lock(&self.session) = Some(session.clone());
            return Ok(());
        }
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
        let _ = fs::remove_file(&self.path);
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
                let mut session = self.session();
                if let Some(session) = session.as_mut() {
                    session.email = me.user.email;
                    session.name = me.user.name;
                    session.subject = me.user.subject;
                    let _ = self.save_session(session);
                }
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
        let dir = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        (AuthStore::new(&dir, "https://hookcode.io/", true, ""), dir)
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
        };
        auth.save_session(&session).unwrap();
        let reopened = AuthStore::new(&dir, "https://hookcode.io", true, "");
        let view = reopened.view();
        assert!(view.signed_in);
        assert_eq!(view.state, "signed_in");
        assert_eq!(view.email.as_deref(), Some("member@example.test"));
        assert_eq!(reopened.token().as_deref(), Some("hk_test_token"));

        reopened.clear_session();
        assert!(reopened.token().is_none());
        assert!(!dir.join("auth.json").exists());
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
        let dir = std::env::temp_dir().join(format!("hook-auth-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let auth = AuthStore::new(&dir, "http://127.0.0.1:8787", false, "");
        let view = auth.view();
        assert!(view.signed_in);
        assert_eq!(view.state, "signed_in");
        assert_eq!(auth.token().as_deref(), Some("mock-local"));
        assert!(!dir.join("auth.json").exists());

        let direct = AuthStore::new(&dir, "https://api.example.test", false, "sk-direct");
        assert_eq!(direct.token().as_deref(), Some("sk-direct"));
        fs::remove_dir_all(dir).ok();
    }
}
