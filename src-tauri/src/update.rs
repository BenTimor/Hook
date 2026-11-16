//! In-app updates.
//!
//! The app asks the public `/api/releases` index what the newest build is. If
//! it is behind, the window offers (or, below `minimum`, demands) an update.
//! Installing is one click: the installer is downloaded with the signed-in
//! token, checked against the published SHA-256, and handed to the NSIS
//! installer in passive update mode, which replaces Hook and relaunches it.
//!
//! Nothing here needs a signing key or an extra release channel: the version
//! index is public, the installer stays behind the approved-account gate, and
//! the whole thing speaks the same HTTP API as the website.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::config::HarnessConfig;

const MANIFEST_TIMEOUT: Duration = Duration::from_secs(15);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
const PROGRESS_STEP: u64 = 256 * 1024;

/// One install at a time; a second click while the first is running is a no-op.
static INSTALLING: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseEntry {
    pub version: String,
    #[serde(default)]
    pub size: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub built_at: Option<String>,
    #[serde(default)]
    pub commit: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseIndex {
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub minimum: Option<String>,
    #[serde(default)]
    pub releases: Vec<ReleaseEntry>,
}

/// What the window needs to draw the banner, the blocking dialog, or nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub minimum: String,
    /// A newer build exists.
    pub available: bool,
    /// The running build is below the supported floor and must update.
    pub required: bool,
    pub notes: Option<String>,
    pub built_at: Option<String>,
    pub commit: Option<String>,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEvent {
    /// `downloading` or `installing`.
    pub phase: &'static str,
    pub received: u64,
    pub total: Option<u64>,
}

pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

fn parse_version(value: &str) -> Option<(u64, u64, u64, Option<&str>)> {
    let value = value.trim();
    let value = value.strip_prefix('v').unwrap_or(value);
    // Build metadata (`+sha`) never changes precedence.
    let value = value.split('+').next().unwrap_or(value);
    let (core, prerelease) = match value.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (value, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch, prerelease))
}

/// Semver ordering, with a missing/invalid version treated as "equal" so a
/// malformed manifest can never force an update.
pub fn compare_versions(left: &str, right: &str) -> Ordering {
    let (Some(left), Some(right)) = (parse_version(left), parse_version(right)) else {
        return Ordering::Equal;
    };
    left.0
        .cmp(&right.0)
        .then(left.1.cmp(&right.1))
        .then(left.2.cmp(&right.2))
        .then_with(|| match (left.3, right.3) {
            (None, None) => Ordering::Equal,
            (None, Some(_)) => Ordering::Greater,
            (Some(_), None) => Ordering::Less,
            (Some(left), Some(right)) => left.cmp(right),
        })
}

fn idle(current: &str) -> UpdateInfo {
    UpdateInfo {
        current: current.to_string(),
        latest: current.to_string(),
        minimum: "0.0.0".into(),
        available: false,
        required: false,
        notes: None,
        built_at: None,
        commit: None,
        size: None,
    }
}

/// Pure mapping from the published index to what this build should do.
pub fn build_info(index: &ReleaseIndex, current: &str) -> Option<UpdateInfo> {
    let latest = index.latest.clone().or_else(|| {
        index
            .releases
            .iter()
            .max_by(|left, right| compare_versions(&left.version, &right.version))
            .map(|entry| entry.version.clone())
    })?;
    let entry = index
        .releases
        .iter()
        .find(|entry| entry.version == latest)?;
    let minimum = index
        .minimum
        .clone()
        .filter(|value| parse_version(value).is_some())
        .unwrap_or_else(|| "0.0.0".into());

    let behind_latest = compare_versions(current, &latest) == Ordering::Less;
    // A floor above the newest build cannot be satisfied, so it never forces.
    let below_minimum = compare_versions(current, &minimum) == Ordering::Less;

    Some(UpdateInfo {
        current: current.to_string(),
        latest,
        minimum,
        available: behind_latest,
        required: behind_latest && below_minimum,
        notes: entry.notes.clone(),
        built_at: entry.built_at.clone(),
        commit: entry.commit.clone(),
        size: entry.size,
    })
}

fn base(cfg: &HarnessConfig) -> &str {
    cfg.auth.base_url.trim_end_matches('/')
}

fn http_client(timeout: Option<Duration>) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        // A stalled stream should fail the update, not hang the dialog forever.
        .read_timeout(Duration::from_secs(60));
    if let Some(timeout) = timeout {
        builder = builder.timeout(timeout);
    }
    builder.build().map_err(|error| error.to_string())
}

async fn fetch_index(cfg: &HarnessConfig) -> Result<ReleaseIndex, String> {
    let url = format!("{}/api/releases", base(cfg));
    let client = http_client(Some(MANIFEST_TIMEOUT))?;
    let response = client
        .get(&url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(|error| format!("Could not check for updates: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "The update service answered with HTTP {}.",
            response.status().as_u16()
        ));
    }
    response
        .json()
        .await
        .map_err(|error| format!("Could not read the update manifest: {error}"))
}

/// Read the published index and compare it with this build.
pub async fn check(cfg: &HarnessConfig) -> Result<UpdateInfo, String> {
    let current = current_version();
    if !cfg.auth.required {
        // Local mock builds never talk to hookcode.io.
        return Ok(idle(&current));
    }
    let index = fetch_index(cfg).await?;
    Ok(build_info(&index, &current).unwrap_or_else(|| idle(&current)))
}

fn safe_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 32
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

/// Download, verify and launch the newest installer, then exit.
pub async fn install(
    app: &AppHandle,
    cfg: &HarnessConfig,
    token: Option<String>,
) -> Result<(), String> {
    if INSTALLING.swap(true, AtomicOrdering::SeqCst) {
        return Err("An update is already being installed.".into());
    }
    let result = install_inner(app, cfg, token).await;
    if result.is_err() {
        INSTALLING.store(false, AtomicOrdering::SeqCst);
    }
    result
}

async fn install_inner(
    app: &AppHandle,
    cfg: &HarnessConfig,
    token: Option<String>,
) -> Result<(), String> {
    let token = token.ok_or("Sign in to update Hook.")?;
    if !cfg.auth.required {
        return Err("This build does not install updates.".into());
    }

    let index = fetch_index(cfg).await?;
    let info = build_info(&index, &current_version())
        .ok_or("The update service did not describe a downloadable version.")?;
    if !info.available {
        return Err("Hook is already up to date.".into());
    }

    let entry = index
        .releases
        .iter()
        .find(|entry| entry.version == info.latest)
        .ok_or("The newest version has no installer.")?;
    let expected = entry
        .sha256
        .clone()
        .ok_or("The newest version has no checksum; refusing to install it.")?;
    if !safe_version(&entry.version) {
        return Err("The update service returned an invalid version.".into());
    }

    let path = entry
        .url
        .clone()
        .unwrap_or_else(|| format!("/api/download/windows?version={}", entry.version));
    let url = if path.starts_with("http://") || path.starts_with("https://") {
        path
    } else {
        format!("{}{}", base(cfg), path)
    };

    let dir = std::env::temp_dir()
        .join("hook-update")
        .join(format!("Hook-{}", entry.version));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|error| format!("Could not prepare the update: {error}"))?;
    let installer = dir.join(format!("Hook-{}-setup.exe", entry.version));
    let partial = installer.with_extension("exe.part");

    let client = http_client(None)?;
    let mut response = client
        .get(&url)
        .header("authorization", format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| format!("Could not download the update: {error}"))?;
    if !response.status().is_success() {
        return Err(match response.status().as_u16() {
            401 | 403 => "This account cannot download Hook right now. Sign in again.".into(),
            status => format!("The update download failed (HTTP {status})."),
        });
    }

    let total = response.content_length().or(entry.size);
    let mut file = tokio::fs::File::create(&partial)
        .await
        .map_err(|error| format!("Could not write the update: {error}"))?;
    use tokio::io::AsyncWriteExt;

    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_emit = 0u64;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("The update download was interrupted: {error}"))?
    {
        file.write_all(&chunk)
            .await
            .map_err(|error| format!("Could not write the update: {error}"))?;
        hasher.update(&chunk);
        received += chunk.len() as u64;
        if received - last_emit >= PROGRESS_STEP || total == Some(received) {
            last_emit = received;
            let _ = app.emit(
                "hook://update",
                UpdateEvent {
                    phase: "downloading",
                    received,
                    total,
                },
            );
        }
    }
    file.flush()
        .await
        .map_err(|error| format!("Could not finish writing the update: {error}"))?;
    drop(file);

    let digest = format!("{:x}", hasher.finalize());
    if !digest.eq_ignore_ascii_case(&expected) {
        let _ = std::fs::remove_file(&partial);
        return Err("The downloaded update did not match its published checksum.".into());
    }
    if let Some(size) = entry.size {
        if size != received {
            let _ = std::fs::remove_file(&partial);
            return Err("The downloaded update was incomplete.".into());
        }
    }
    std::fs::rename(&partial, &installer)
        .map_err(|error| format!("Could not finish the update: {error}"))?;

    let _ = app.emit(
        "hook://update",
        UpdateEvent {
            phase: "installing",
            received,
            total,
        },
    );
    launch_installer(&installer)?;
    // The installer waits two seconds and then closes/restarts Hook itself; let
    // the normal exit path stop coding agents and the preview server first.
    app.exit(0);
    Ok(())
}

/// Run the NSIS installer once this process has gone away.
///
/// Starting it immediately races our own exit: the installer's Restart Manager
/// check can see a half-closed app and abort (tauri-apps/tauri#16277). A tiny
/// detached batch file waits, then launches it in passive update mode, which
/// installs without prompts and relaunches Hook (`/R`).
#[cfg(windows)]
fn launch_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let dir = installer
        .parent()
        .ok_or("The update has no folder to run from.")?;
    let script = dir.join("install.cmd");
    let body = format!(
        "@echo off\r\nping -n 3 127.0.0.1 >nul\r\nstart \"\" \"{}\" /P /UPDATE /R\r\n",
        installer.display()
    );
    std::fs::write(&script, body)
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    std::process::Command::new("cmd.exe")
        .arg("/C")
        .arg(PathBuf::from(&script))
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map_err(|error| format!("Could not start the installer: {error}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn launch_installer(_installer: &Path) -> Result<(), String> {
    Err("Hook installs updates automatically on Windows only.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_order_is_semver() {
        assert_eq!(compare_versions("0.1.0", "0.1.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.2.0", "0.10.0"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "1.0.0-beta"), Ordering::Greater);
        assert_eq!(compare_versions("v1.2.3", "1.2.3"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.3+build", "1.2.3"), Ordering::Equal);
        // Malformed input never forces anything.
        assert_eq!(compare_versions("garbage", "1.0.0"), Ordering::Equal);
    }

    fn index(json: &str) -> ReleaseIndex {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn a_newer_build_is_optional_when_above_the_floor() {
        let index = index(
            r#"{
                "latest": "0.3.0",
                "minimum": "0.1.0",
                "releases": [
                    { "version": "0.3.0", "sha256": "abc", "size": 10, "notes": "New" },
                    { "version": "0.2.0", "sha256": "def" }
                ]
            }"#,
        );
        let info = build_info(&index, "0.2.0").unwrap();
        assert_eq!(info.latest, "0.3.0");
        assert!(info.available);
        assert!(!info.required);
        assert_eq!(info.notes.as_deref(), Some("New"));
    }

    #[test]
    fn falling_below_the_floor_requires_the_update() {
        let index = index(
            r#"{
                "latest": "0.3.0",
                "minimum": "0.2.0",
                "releases": [{ "version": "0.3.0", "sha256": "abc" }]
            }"#,
        );
        let info = build_info(&index, "0.1.0").unwrap();
        assert!(info.available);
        assert!(info.required);
        assert_eq!(info.minimum, "0.2.0");
    }

    #[test]
    fn being_current_means_no_prompt() {
        let index = index(
            r#"{ "latest": "0.3.0", "minimum": "0.3.0", "releases": [{ "version": "0.3.0" }] }"#,
        );
        let info = build_info(&index, "0.3.0").unwrap();
        assert!(!info.available);
        assert!(!info.required);
    }

    #[test]
    fn a_floor_above_the_newest_build_does_not_force() {
        let index = index(
            r#"{ "latest": "0.3.0", "minimum": "9.0.0", "releases": [{ "version": "0.3.0" }] }"#,
        );
        let info = build_info(&index, "0.3.0").unwrap();
        // The newest build is the real floor; a config mistake cannot brick it.
        assert!(!info.available);
        assert!(!info.required);
    }

    #[test]
    fn the_declared_latest_wins_even_if_a_higher_version_exists() {
        let index = index(
            r#"{
                "latest": "0.2.0",
                "releases": [
                    { "version": "0.3.0" },
                    { "version": "0.2.0" }
                ]
            }"#,
        );
        assert_eq!(build_info(&index, "0.1.0").unwrap().latest, "0.2.0");
    }

    #[test]
    fn an_empty_index_is_not_an_update() {
        let index = index(r#"{ "latest": null, "releases": [] }"#);
        assert!(build_info(&index, "0.1.0").is_none());
    }

    #[test]
    fn update_file_names_are_restricted() {
        assert!(safe_version("0.2.0"));
        assert!(safe_version("0.2.0-beta.1"));
        assert!(!safe_version("../../evil"));
        assert!(!safe_version(""));
    }
}
