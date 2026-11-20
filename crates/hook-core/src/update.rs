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
    /// The Store channel's own latest/floor, updated after certification.
    #[serde(default)]
    pub store: Option<StoreIndex>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreIndex {
    #[serde(default)]
    pub latest: Option<String>,
    #[serde(default)]
    pub minimum: Option<String>,
}

/// How this build receives updates. A packaged MSIX cannot run an installer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Direct,
    Store,
}

/// What the window needs to draw the banner, the blocking dialog, or nothing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current: String,
    pub latest: String,
    pub minimum: String,
    /// `direct` (Hook installs it) or `store` (Microsoft Store installs it).
    pub channel: UpdateChannel,
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
    // The product's number, injected by `builder`; hook-core's own Cargo version
    // is not a release and must never reach the index comparison.
    crate::version::current()
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

fn idle(current: &str, channel: UpdateChannel) -> UpdateInfo {
    UpdateInfo {
        current: current.to_string(),
        latest: current.to_string(),
        minimum: "0.0.0".into(),
        channel,
        available: false,
        required: false,
        notes: None,
        built_at: None,
        commit: None,
        size: None,
    }
}

/// Pure mapping from the published index to what this build should do.
///
/// Direct builds read `latest`/`minimum`; a packaged MSIX reads the Store's own
/// pair, which only moves after Microsoft certifies a release.
pub fn build_info(
    index: &ReleaseIndex,
    current: &str,
    channel: UpdateChannel,
) -> Option<UpdateInfo> {
    let (latest, minimum) = match channel {
        UpdateChannel::Direct => {
            let latest = index.latest.clone().or_else(|| {
                index
                    .releases
                    .iter()
                    .max_by(|left, right| compare_versions(&left.version, &right.version))
                    .map(|entry| entry.version.clone())
            })?;
            let minimum = index
                .minimum
                .clone()
                .filter(|value| parse_version(value).is_some())
                .unwrap_or_else(|| "0.0.0".into());
            (latest, minimum)
        }
        UpdateChannel::Store => {
            let store = index.store.as_ref()?;
            let latest = store
                .latest
                .clone()
                .filter(|value| parse_version(value).is_some())?;
            let minimum = store
                .minimum
                .clone()
                .filter(|value| parse_version(value).is_some())
                .unwrap_or_else(|| "0.0.0".into());
            // A Store floor above the newest Store build cannot be satisfied,
            // so it falls back to that build instead of forcing the impossible.
            let minimum = if compare_versions(&minimum, &latest) == Ordering::Greater {
                latest.clone()
            } else {
                minimum
            };
            (latest, minimum)
        }
    };

    let entry = index.releases.iter().find(|entry| entry.version == latest);
    // A direct update without an installer cannot be installed; a Store update
    // is fetched by the Store itself and does not need a release entry.
    if channel == UpdateChannel::Direct && entry.is_none() {
        return None;
    }

    let behind_latest = compare_versions(current, &latest) == Ordering::Less;
    let below_minimum = compare_versions(current, &minimum) == Ordering::Less;

    Some(UpdateInfo {
        current: current.to_string(),
        latest,
        minimum,
        channel,
        available: behind_latest,
        required: behind_latest && below_minimum,
        notes: entry.and_then(|entry| entry.notes.clone()),
        built_at: entry.and_then(|entry| entry.built_at.clone()),
        commit: entry.and_then(|entry| entry.commit.clone()),
        size: entry.and_then(|entry| entry.size),
    })
}

/// Whether this process runs from an MSIX package.
#[cfg(windows)]
fn packaged() -> bool {
    const APPMODEL_ERROR_NO_PACKAGE: i32 = 15700;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentPackageFullName(length: *mut u32, name: *mut u16) -> i32;
    }
    let mut length = 0u32;
    let result = unsafe { GetCurrentPackageFullName(&mut length, std::ptr::null_mut()) };
    result != APPMODEL_ERROR_NO_PACKAGE
}

#[cfg(not(windows))]
fn packaged() -> bool {
    false
}

pub fn current_channel() -> UpdateChannel {
    if packaged() {
        UpdateChannel::Store
    } else {
        UpdateChannel::Direct
    }
}

/// The Store page to open for a packaged build.
pub fn store_url(cfg: &HarnessConfig) -> String {
    store_url_for(cfg.update.store_id.as_deref())
}

fn store_url_for(store_id: Option<&str>) -> String {
    match store_id.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => format!("ms-windows-store://pdp/?productid={id}"),
        None => "ms-windows-store://downloadsandupdates".to_string(),
    }
}

/// Open the Store's update surface. Store apps never download an installer.
pub fn open_store(cfg: &HarnessConfig) -> Result<(), String> {
    let url = store_url(cfg);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd.exe")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|error| format!("Could not open the Microsoft Store: {error}"))?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err("The Microsoft Store is available on Windows only.".into())
    }
}

/// Open the Store's update surface and quit, so the Store is never asked to
/// replace files this process holds open.
///
/// MSIX refuses to service a package that is in use (`ERROR_PACKAGES_IN_USE`,
/// `0x80073D02`) and the Store only reports "try again". `uap17:UpdateWhileInUse`
/// makes Windows defer such an update on Windows 11 24H2+, but older Windows has
/// no such option, so the user's click closes Hook first either way. `on_exit`
/// stops the coding agents and the preview server before the process goes away,
/// which is what releases `resources/pi-runtime` and `resources/git`.
pub fn open_store_for_update(app: &AppHandle, cfg: &HarnessConfig) -> Result<(), String> {
    open_store(cfg)?;
    // The shell launches the Store as its own process, but the protocol handler
    // needs a moment before this one disappears. Long enough to be reliable,
    // short enough that the window does not look stuck.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_millis(700)).await;
        handle.exit(0);
    });
    Ok(())
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

async fn fetch_index(cfg: &HarnessConfig, product: crate::Product) -> Result<ReleaseIndex, String> {
    // The chat app keeps the historical URL every installed build already
    // knows; every other product has its own index beside it.
    let url = match product {
        crate::Product::Chat => format!("{}/api/releases", base(cfg)),
        crate::Product::Workspace => format!("{}/api/releases/workspace", base(cfg)),
        // The phone installs through its store, and the store decides when a
        // build is replaced. There is no installer to offer, so this index is
        // never read; the product's own release channel lives in App Store
        // Connect and Play Console, not in `release.config.json`.
        crate::Product::Mobile => format!("{}/api/releases/mobile", base(cfg)),
    };
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
pub async fn check(cfg: &HarnessConfig, product: crate::Product) -> Result<UpdateInfo, String> {
    let current = current_version();
    let channel = current_channel();
    if !cfg.auth.required {
        // Local mock builds never talk to hookcode.io.
        return Ok(idle(&current, channel));
    }
    let index = fetch_index(cfg, product).await?;
    let info = build_info(&index, &current, channel).unwrap_or_else(|| idle(&current, channel));
    // The version this build reports and the version it compares against are the
    // only way to tell "the index is behind" from "the build believes it is
    // older than it is". One line here makes that difference visible in stderr.
    if info.available {
        eprintln!(
            "hook: update available: {} -> {} ({:?} channel)",
            info.current, info.latest, info.channel
        );
    }
    Ok(info)
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
    product: crate::Product,
    token: Option<String>,
) -> Result<(), String> {
    if INSTALLING.swap(true, AtomicOrdering::SeqCst) {
        return Err("An update is already being installed.".into());
    }
    let result = install_inner(app, cfg, product, token).await;
    if result.is_err() {
        INSTALLING.store(false, AtomicOrdering::SeqCst);
    }
    result
}

async fn install_inner(
    app: &AppHandle,
    cfg: &HarnessConfig,
    product: crate::Product,
    token: Option<String>,
) -> Result<(), String> {
    let token = token.ok_or("Sign in to update Hook.")?;
    if !cfg.auth.required {
        return Err("This build does not install updates.".into());
    }
    if current_channel() == UpdateChannel::Store {
        return Err("This build updates through the Microsoft Store.".into());
    }

    let index = fetch_index(cfg, product).await?;
    let info = build_info(&index, &current_version(), UpdateChannel::Direct)
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
        let info = build_info(&index, "0.2.0", UpdateChannel::Direct).unwrap();
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
        let info = build_info(&index, "0.1.0", UpdateChannel::Direct).unwrap();
        assert!(info.available);
        assert!(info.required);
        assert_eq!(info.minimum, "0.2.0");
    }

    #[test]
    fn being_current_means_no_prompt() {
        let index = index(
            r#"{ "latest": "0.3.0", "minimum": "0.3.0", "releases": [{ "version": "0.3.0" }] }"#,
        );
        let info = build_info(&index, "0.3.0", UpdateChannel::Direct).unwrap();
        assert!(!info.available);
        assert!(!info.required);
    }

    #[test]
    fn a_floor_above_the_newest_build_does_not_force() {
        let index = index(
            r#"{ "latest": "0.3.0", "minimum": "9.0.0", "releases": [{ "version": "0.3.0" }] }"#,
        );
        let info = build_info(&index, "0.3.0", UpdateChannel::Direct).unwrap();
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
        assert_eq!(build_info(&index, "0.1.0", UpdateChannel::Direct).unwrap().latest, "0.2.0");
    }

    #[test]
    fn an_empty_index_is_not_an_update() {
        let index = index(r#"{ "latest": null, "releases": [] }"#);
        assert!(build_info(&index, "0.1.0", UpdateChannel::Direct).is_none());
    }

    #[test]
    fn a_store_build_reads_the_store_fields_not_the_direct_ones() {
        let index = index(
            r#"{
                "latest": "0.5.0",
                "minimum": "0.5.0",
                "store": { "latest": "0.4.0", "minimum": "0.3.0" },
                "releases": [{ "version": "0.5.0" }, { "version": "0.4.0" }]
            }"#,
        );
        let info = build_info(&index, "0.3.0", UpdateChannel::Store).unwrap();
        assert_eq!(info.channel, UpdateChannel::Store);
        assert_eq!(info.latest, "0.4.0");
        assert_eq!(info.minimum, "0.3.0");
        assert!(info.available);
        assert!(!info.required);
    }

    #[test]
    fn a_store_without_a_published_version_never_prompts() {
        let index = index(
            r#"{
                "latest": "0.5.0",
                "store": { "latest": null, "minimum": null },
                "releases": [{ "version": "0.5.0" }]
            }"#,
        );
        assert!(build_info(&index, "0.1.0", UpdateChannel::Store).is_none());
    }

    #[test]
    fn a_store_floor_above_its_latest_is_clamped() {
        let index = index(
            r#"{
                "store": { "latest": "0.4.0", "minimum": "9.0.0" },
                "releases": []
            }"#,
        );
        let info = build_info(&index, "0.4.0", UpdateChannel::Store).unwrap();
        assert_eq!(info.minimum, "0.4.0");
        assert!(!info.required);
    }

    #[test]
    fn a_store_update_does_not_need_a_direct_installer_entry() {
        let index = index(
            r#"{
                "store": { "latest": "0.4.0", "minimum": "0.0.0" },
                "releases": []
            }"#,
        );
        let info = build_info(&index, "0.3.0", UpdateChannel::Store).unwrap();
        assert!(info.available);
        assert!(info.notes.is_none());
    }

    #[test]
    fn the_store_url_prefers_the_product_page() {
        assert_eq!(
            store_url_for(Some("9NBLGGH4R315")),
            "ms-windows-store://pdp/?productid=9NBLGGH4R315"
        );
        assert_eq!(
            store_url_for(Some("  ")),
            "ms-windows-store://downloadsandupdates"
        );
        assert_eq!(
            store_url_for(None),
            "ms-windows-store://downloadsandupdates"
        );
    }

    #[test]
    fn update_file_names_are_restricted() {
        assert!(safe_version("0.2.0"));
        assert!(safe_version("0.2.0-beta.1"));
        assert!(!safe_version("../../evil"));
        assert!(!safe_version(""));
    }
}
