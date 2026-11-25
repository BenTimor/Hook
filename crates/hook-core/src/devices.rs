//! What this machine is, and the account's device list.
//!
//! The server is the authority on a device's name and on whether it accepts
//! remote work. This module only builds the description a machine sends when it
//! connects, and wraps the small REST surface the Machines UI needs.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::auth::AuthStore;
use crate::state::AppState;

/// What this build tells the account about itself on connect. It is not a
/// fingerprint: a name, a shape, a version, a capability summary and a few
/// numbers that help a person tell two computers apart.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub id: String,
    pub name: String,
    /// `desktop`, `headless` or `mobile`.
    pub kind: String,
    pub platform: String,
    pub arch: String,
    pub app_version: String,
    /// `chat`, `workspace`, `mobile` or `headless`.
    pub product: String,
    /// `host` or `controller`. Only Hook and the headless daemon host.
    pub role: String,
    pub can_host: bool,
    pub capabilities: Value,
    pub specs: Value,
}

/// One row of `GET /api/devices`, merged with the live connection state by the
/// relay. The UI reads this shape directly.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub kind: String,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub product: Option<String>,
    #[serde(default)]
    pub can_host: bool,
    #[serde(default)]
    pub online: bool,
    /// Whether Hook Browser is running on that machine *now*. Products share a
    /// device row and one account file, so `capabilities` holds whichever of
    /// them connected last; this is the live answer the server reads off the
    /// sockets.
    #[serde(default)]
    pub browser_online: bool,
    #[serde(default)]
    pub host_online: bool,
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub remote_allowed: bool,
    #[serde(default)]
    pub last_seen: Option<String>,
    #[serde(default)]
    pub capabilities: Option<Value>,
    #[serde(default)]
    pub specs: Option<Value>,
}

fn platform_label() -> String {
    std::env::consts::OS.to_string()
}

fn machine_kind(product: crate::Product) -> &'static str {
    match product {
        crate::Product::Mobile => "mobile",
        _ => "desktop",
    }
}

fn host_role(product: crate::Product, capabilities: crate::Capabilities) -> &'static str {
    // Hook is the host. Workspace and HookCode drive machines but never accept
    // agent commands themselves; a phone has no project folder and Workspace is
    // a second window on a machine Hook already owns.
    if product == crate::Product::Chat && capabilities.coding_agents {
        "host"
    } else {
        "controller"
    }
}

/// A friendly default for a machine that has never been named. The user can
/// rename it from Settings, and the server keeps that name forever after.
pub fn default_name() -> String {
    let raw = std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .unwrap_or_default();
    let host = raw.split('.').next().unwrap_or("").trim();
    if host.is_empty() {
        return "This computer".to_string();
    }
    host.replace('-', " ").replace('_', " ")
}

pub fn profile(state: &AppState) -> DeviceProfile {
    let caps = state.capabilities;
    let role = host_role(state.product, caps);
    let projects = if caps.projects {
        state
            .projects
            .list(&state.settings.projects_dir())
            .map(|list| list.len())
            .unwrap_or(0)
    } else {
        0
    };
    DeviceProfile {
        id: state.auth.device_id().to_string(),
        name: default_name(),
        kind: machine_kind(state.product).to_string(),
        platform: platform_label(),
        arch: std::env::consts::ARCH.to_string(),
        app_version: crate::version::current(),
        product: state.product.slug().to_string(),
        role: role.to_string(),
        can_host: role == "host",
        capabilities: json!({
            "codingAgents": caps.coding_agents,
            "projects": caps.projects,
            "previewPages": caps.preview_pages,
            "previewWorkspace": caps.preview_workspace,
            "workspaceTools": caps.workspace_tools,
            // Whether a page can be read on this machine. A tool that names it
            // for `read_page` needs to know before it tries.
            "browser": caps.browser,
        }),
        specs: json!({
            "cpuCores": std::thread::available_parallelism()
                .map(|count| count.get())
                .unwrap_or(1),
            "projects": projects,
        }),
    }
}

fn failure(status: u16, body: &str) -> String {
    if let Ok(value) = serde_json::from_str::<Value>(body) {
        if let Some(message) = value
            .pointer("/error/message")
            .and_then(Value::as_str)
            .filter(|message| !message.trim().is_empty())
        {
            return message.to_string();
        }
    }
    match status {
        401 => "Sign in to Hook to see your machines.".into(),
        403 => "Running work on your other machines is part of a paid plan.".into(),
        _ => "The account service could not answer.".into(),
    }
}

async fn call(
    auth: &AuthStore,
    method: reqwest::Method,
    path: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let token = auth.token().ok_or("Sign in to Hook to see your machines.")?;
    let mut request = auth
        .http()
        .request(method, format!("{}/api/devices{path}", auth.base_url()))
        .bearer_auth(token)
        .header("x-hook-device", auth.device_id());
    if let Some(body) = body {
        request = request.json(&body);
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("Could not reach Hook: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(failure(status.as_u16(), &text));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|error| format!("Hook sent a malformed answer: {error}"))
}


pub async fn rename(auth: &AuthStore, id: &str, name: &str) -> Result<DeviceView, String> {
    let value = call(
        auth,
        reqwest::Method::PATCH,
        &format!("/{id}"),
        Some(json!({ "name": name })),
    )
    .await?;
    let device = value
        .get("device")
        .cloned()
        .ok_or("Hook did not return the renamed machine.")?;
    serde_json::from_value(device).map_err(|error| error.to_string())
}

pub async fn set_remote(auth: &AuthStore, id: &str, allowed: bool) -> Result<DeviceView, String> {
    let value = call(
        auth,
        reqwest::Method::PATCH,
        &format!("/{id}"),
        Some(json!({ "remoteAllowed": allowed })),
    )
    .await?;
    let device = value
        .get("device")
        .cloned()
        .ok_or("Hook did not return the machine.")?;
    serde_json::from_value(device).map_err(|error| error.to_string())
}

pub async fn remove(auth: &AuthStore, id: &str) -> Result<(), String> {
    call(auth, reqwest::Method::DELETE, &format!("/{id}"), None).await?;
    Ok(())
}

/// Mint a short-lived URL for a preview served by `device_id`. The viewer never
/// reaches that machine directly; the URL points at the account service, which
/// tunnels the request over the machine's outbound socket.
pub async fn preview_ticket(
    auth: &AuthStore,
    device_id: &str,
    chat_id: &str,
    file: &str,
) -> Result<String, String> {
    let token = auth.token().ok_or("Sign in to Hook to see this preview.")?;
    let response = auth
        .http()
        .post(format!("{}/api/remote/preview/ticket", auth.base_url()))
        .bearer_auth(token)
        .header("x-hook-device", auth.device_id())
        .json(&serde_json::json!({
            "deviceId": device_id,
            "chatId": chat_id,
            "file": file,
        }))
        .send()
        .await
        .map_err(|error| format!("Could not reach Hook: {error}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(failure(status.as_u16(), &text));
    }
    let value: Value =
        serde_json::from_str(&text).map_err(|error| format!("Hook sent a malformed ticket: {error}"))?;
    value
        .get("url")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "Hook did not return a preview link.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_default_name_is_human_readable() {
        let name = default_name();
        assert!(!name.is_empty());
        assert!(name.len() <= 60);
        assert!(!name.contains(".local"));
    }

    #[test]
    fn only_hook_hosts() {
        assert_eq!(
            host_role(crate::Product::Chat, crate::Capabilities::chat()),
            "host"
        );
        assert_eq!(
            host_role(crate::Product::Workspace, crate::Capabilities::workspace()),
            "controller"
        );
        assert_eq!(
            host_role(crate::Product::Mobile, crate::Capabilities::mobile()),
            "controller"
        );
    }

    #[test]
    fn a_device_view_reads_the_server_shape() {
        let view: DeviceView = serde_json::from_value(json!({
            "id": "device-one",
            "name": "Office PC",
            "kind": "desktop",
            "platform": "windows",
            "arch": "x86_64",
            "appVersion": "0.4.0",
            "product": "chat",
            "canHost": true,
            "online": true,
            "hostOnline": true,
            "role": "host",
            "remoteAllowed": true,
            "lastSeen": "2026-11-22T10:00:00.000Z",
            "capabilities": { "codingAgents": true },
            "specs": { "cpuCores": 16, "projects": 2 }
        }))
        .unwrap();
        assert!(view.can_host);
        assert!(view.host_online);
        assert_eq!(view.specs.unwrap()["cpuCores"], 16);
    }
}
