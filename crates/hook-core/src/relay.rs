//! The outbound connection to the account's relay.
//!
//! Every Hook product holds one WebSocket while it runs. A machine is a *host*
//! (Hook): it can start and steer agents. A phone or a Workspace window is a
//! *controller*: it sends commands to a host and watches the live events that
//! host publishes. The relay never stores conversation content; the durable
//! copy still travels through `sync`.
//!
//! This module is the transport only. It owns reconnection, presence, the
//! request/response map and the subscription set; `remote.rs` decides what an
//! incoming RPC means.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::Duration;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::{header::HeaderName, HeaderValue};
use tokio_tungstenite::tungstenite::Message;

use crate::commands::AppState;
use crate::devices::{DeviceProfile, DeviceView};

/// How a relay event reaches the window. Kept as a callback so the headless
/// runtime can log or forward the same events without a Tauri handle.
pub type Emitter = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// The panel state the UI draws. `state` is one of `signedOut`, `connecting`,
/// `online`, `refused` or `offline`; `message` is the sentence to show when it
/// is not online.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayView {
    pub state: String,
    pub message: Option<String>,
    pub error: Option<String>,
    pub self_id: String,
    pub self_name: String,
    pub devices: Vec<DeviceView>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcFailure {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Inbound {
    Ready {
        #[serde(default)]
        device: Option<DeviceView>,
    },
    Presence {
        devices: Vec<DeviceView>,
    },
    Event {
        chat_id: String,
        payload: Value,
    },
    PreviewRequest {
        id: String,
        chat_id: String,
        method: String,
        path: String,
    },
    Rpc {
        id: String,
        from: String,
        method: String,
        #[serde(default)]
        params: Value,
    },
    RpcResult {
        id: String,
        ok: bool,
        #[serde(default)]
        result: Value,
        #[serde(default)]
        error: Option<RpcFailure>,
    },
    Error {
        code: String,
        message: String,
        #[serde(default)]
        id: Option<String>,
    },
}

struct Inner {
    emit: Emitter,
    profile: Mutex<Option<DeviceProfile>>,
    state: Mutex<Weak<AppState>>,
    /// `Some((generation, sender))` while a session is live. The generation is
    /// how a closing session knows it must not clear a newer one's sender.
    out: Mutex<Option<(u64, mpsc::UnboundedSender<Message>)>>,
    generation: AtomicU64,
    pending: Mutex<HashMap<String, oneshot::Sender<Result<Value, RpcFailure>>>>,
    /// (device, chat, file) -> ticket URL and when it was minted. A preview
    /// reloads as the agent writes; minting a ticket per file change would be a
    /// request every few hundred milliseconds.
    previews: Mutex<HashMap<String, (String, std::time::Instant)>>,
    subscriptions: Mutex<HashSet<String>>,
    view: Mutex<RelayView>,
    wake: tokio::sync::Notify,
    stopped: AtomicBool,
}

pub struct RelayClient {
    inner: Arc<Inner>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|error| error.into_inner())
}

impl RelayClient {
    pub fn new(emit: Emitter) -> Self {
        Self {
            inner: Arc::new(Inner {
                emit,
                profile: Mutex::new(None),
                state: Mutex::new(Weak::new()),
                out: Mutex::new(None),
                generation: AtomicU64::new(0),
                pending: Mutex::new(HashMap::new()),
                previews: Mutex::new(HashMap::new()),
                subscriptions: Mutex::new(HashSet::new()),
                view: Mutex::new(RelayView {
                    state: "signedOut".into(),
                    message: None,
                    error: None,
                    self_id: String::new(),
                    self_name: String::new(),
                    devices: Vec::new(),
                }),
                wake: tokio::sync::Notify::new(),
                stopped: AtomicBool::new(false),
            }),
        }
    }

    /// Build this machine's description and start the connection loop. Called
    /// once the app state exists, so an incoming command can act for the
    /// signed-in account.
    pub fn serve(self: &Arc<Self>, state: Arc<AppState>) {
        let profile = crate::devices::profile(&state);
        {
            let mut slot = lock(&self.inner.profile);
            *slot = Some(profile.clone());
            let mut view = lock(&self.inner.view);
            view.self_id = profile.id;
            view.self_name = profile.name;
        }
        *lock(&self.inner.state) = Arc::downgrade(&state);
        self.emit_view();
        let relay = self.clone();
        tauri::async_runtime::spawn(async move {
            relay.run(state).await;
        });
    }

    /// Something about the account changed (sign-in, plan, the cloud switch).
    /// Break the backoff sleep and look again.
    pub fn wake(&self) {
        self.inner.wake.notify_one();
    }

    /// Close the current socket without stopping the loop. Used on sign-out and
    /// when the account turns cloud sync off; the loop re-evaluates and either
    /// reconnects or shows the refusal.
    pub fn disconnect(&self) {
        let sender = lock(&self.inner.out)
            .as_ref()
            .map(|(_, sender)| sender.clone());
        if let Some(sender) = sender {
            let _ = sender.send(Message::Close(None));
        }
    }

    pub fn view(&self) -> RelayView {
        lock(&self.inner.view).clone()
    }

    pub fn device_id(&self) -> String {
        lock(&self.inner.profile)
            .as_ref()
            .map(|profile| profile.id.clone())
            .unwrap_or_default()
    }

    /// Send a request to a machine's host and wait for its answer. The relay
    /// resolves an offline machine immediately; a live one may take as long as
    /// the caller gives it.
    pub async fn rpc(
        &self,
        to: &str,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, RpcFailure> {
        let id = format!("rpc_{}", uuid::Uuid::new_v4().simple());
        let (sender, receiver) = oneshot::channel();
        lock(&self.inner.pending).insert(id.clone(), sender);
        if let Err(message) = self.send_frame(json!({
            "kind": "rpc",
            "id": id,
            "to": to,
            "method": method,
            "params": params,
        })) {
            lock(&self.inner.pending).remove(&id);
            return Err(RpcFailure {
                code: "offline".into(),
                message,
            });
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RpcFailure {
                code: "offline".into(),
                message: "The relay closed before the machine answered.".into(),
            }),
            Err(_) => {
                lock(&self.inner.pending).remove(&id);
                Err(RpcFailure {
                    code: "timeout".into(),
                    message: "The machine did not answer in time.".into(),
                })
            }
        }
    }

    pub fn publish(&self, chat_id: &str, payload: Value) -> Result<(), String> {
        self.send_frame(json!({
            "kind": "publish",
            "chatId": chat_id,
            "payload": payload,
        }))
    }

    pub fn subscribe(&self, chat_id: &str) {
        lock(&self.inner.subscriptions).insert(chat_id.to_string());
        let _ = self.send_frame(json!({ "kind": "subscribe", "chatId": chat_id }));
    }

    pub fn unsubscribe(&self, chat_id: &str) {
        lock(&self.inner.subscriptions).remove(chat_id);
        let _ = self.send_frame(json!({ "kind": "unsubscribe", "chatId": chat_id }));
    }

    fn send_frame(&self, frame: Value) -> Result<(), String> {
        let text = serde_json::to_string(&frame)
            .map_err(|error| format!("Could not serialize a relay frame: {error}"))?;
        let sender = lock(&self.inner.out)
            .as_ref()
            .map(|(_, sender)| sender.clone());
        match sender {
            Some(sender) => sender
                .send(Message::Text(text.into()))
                .map_err(|_| "This computer is not connected to Hook right now.".to_string()),
            None => Err("This computer is not connected to Hook right now.".into()),
        }
    }

    fn emit_view(&self) {
        let view = self.view();
        if let Ok(payload) = serde_json::to_value(view) {
            (self.inner.emit)("hook://devices", payload);
        }
    }

    fn set_state(&self, state: &str, message: Option<String>) {
        let changed = {
            let mut view = lock(&self.inner.view);
            let changed = view.state != state || view.message != message;
            view.state = state.to_string();
            view.message = message;
            if state == "online" {
                view.error = None;
            }
            changed
        };
        if changed {
            self.emit_view();
        }
    }

    fn set_presence(&self, devices: Vec<DeviceView>) {
        {
            let mut view = lock(&self.inner.view);
            view.devices = devices;
        }
        self.emit_view();
    }

    fn set_error(&self, error: Option<String>) {
        {
            let mut view = lock(&self.inner.view);
            view.error = error;
        }
        self.emit_view();
    }

    async fn run(self: Arc<Self>, state: Arc<AppState>) {
        let mut backoff = 1u64;
        loop {
            if self.inner.stopped.load(Ordering::SeqCst) {
                return;
            }
            if !state.auth.required() {
                self.set_state("signedOut", None);
                self.sleep(Duration::from_secs(60)).await;
                continue;
            }
            if state.auth.token().is_none() {
                self.set_state("signedOut", None);
                self.sleep(Duration::from_secs(15)).await;
                continue;
            }
            if state.auth.is_free() {
                self.set_state(
                    "refused",
                    Some(
                        "Running work on your other machines is part of a paid plan."
                            .to_string(),
                    ),
                );
                self.sleep(Duration::from_secs(30)).await;
                continue;
            }
            if state.auth.cloud_sync() == Some(false) {
                self.set_state(
                    "refused",
                    Some(
                        "Turn on cloud sync to use your other machines. Settings, under Advanced."
                            .to_string(),
                    ),
                );
                self.sleep(Duration::from_secs(30)).await;
                continue;
            }

            self.set_state("connecting", None);
            let token = match state.auth.token() {
                Some(token) => token,
                None => continue,
            };
            match self.session(&state, &token).await {
                Ok(()) => {
                    self.set_state("offline", Some("Reconnecting…".into()));
                    backoff = 1;
                }
                Err(error) => {
                    if error.contains("401") || error.contains("403") {
                        self.set_state(
                            "refused",
                            Some(
                                "This computer is not connected to the account. Sign in again, or check the plan and cloud sync."
                                    .to_string(),
                            ),
                        );
                    } else {
                        self.set_state("offline", Some(error));
                    }
                }
            }
            self.sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    }

    async fn sleep(&self, duration: Duration) {
        tokio::select! {
            _ = tokio::time::sleep(duration) => {}
            _ = self.inner.wake.notified() => {}
        }
    }

    async fn session(&self, state: &Arc<AppState>, token: &str) -> Result<(), String> {
        let profile = lock(&self.inner.profile)
            .clone()
            .ok_or("This build has no device description yet.")?;
        let url = relay_url(state.auth.base_url())?;
        let mut request = url
            .into_client_request()
            .map_err(|error| format!("Could not build the relay request: {error}"))?;
        request.headers_mut().insert(
            HeaderName::from_static("authorization"),
            HeaderValue::from_str(&format!("Bearer {token}"))
                .map_err(|error| format!("Could not sign the relay request: {error}"))?,
        );
        request.headers_mut().insert(
            HeaderName::from_static("x-hook-device"),
            HeaderValue::from_str(state.auth.device_id())
                .map_err(|error| format!("Could not identify this device: {error}"))?,
        );

        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(10),
            tokio_tungstenite::connect_async(request),
        )
        .await
        .map_err(|_| "The account service did not answer.".to_string())?
        .map_err(|error| format!("Could not reach the relay: {error}"))?;

        let (mut sink, mut stream) = socket.split();
        let (out, mut out_rx) = mpsc::unbounded_channel::<Message>();
        let generation = self.inner.generation.fetch_add(1, Ordering::SeqCst) + 1;
        *lock(&self.inner.out) = Some((generation, out.clone()));

        let writer = tauri::async_runtime::spawn(async move {
            while let Some(message) = out_rx.recv().await {
                if sink.send(message).await.is_err() {
                    break;
                }
            }
            let _ = sink.close().await;
        });

        self.send_frame(json!({
            "v": 1,
            "kind": "hello",
            "device": profile,
        }))?;
        for chat_id in lock(&self.inner.subscriptions).iter() {
            self.send_frame(json!({ "kind": "subscribe", "chatId": chat_id }))?;
        }

        let mut policy = tokio::time::interval(Duration::from_secs(60));
        policy.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let close_message = loop {
            tokio::select! {
                message = stream.next() => {
                    let Some(message) = message else {
                        break "The relay closed the connection.".to_string();
                    };
                    match message {
                        Ok(Message::Text(text)) => {
                            self.handle_text(state, &text).await;
                        }
                        Ok(Message::Ping(data)) => {
                            let _ = out.send(Message::Pong(data));
                        }
                        Ok(Message::Close(frame)) => {
                            break frame
                                .map(|frame| format!("The relay closed the connection: {}", frame.reason))
                                .unwrap_or_else(|| "The relay closed the connection.".to_string());
                        }
                        Ok(_) => {}
                        Err(error) => break format!("The relay connection failed: {error}"),
                    }
                }
                _ = policy.tick() => {
                    // A plan change or the account-wide sync switch is
                    // re-checked while connected; the server closes the socket
                    // on the switch, and this catches a plan change too.
                    if state.auth.token().is_none()
                        || state.auth.is_free()
                        || state.auth.cloud_sync() == Some(false)
                    {
                        break "This account can no longer use remote control.".to_string();
                    }
                }
            }
        };

        writer.abort();
        let mine = {
            let mut slot = lock(&self.inner.out);
            if slot.as_ref().map(|(id, _)| *id == generation).unwrap_or(false) {
                slot.take();
                true
            } else {
                false
            }
        };
        if mine {
            let pending: Vec<_> = lock(&self.inner.pending).drain().map(|(_, sender)| sender).collect();
            for sender in pending {
                let _ = sender.send(Err(RpcFailure {
                    code: "offline".into(),
                    message: "The relay connection closed.".into(),
                }));
            }
            if !self.inner.stopped.load(Ordering::SeqCst) {
                self.set_state("offline", Some(close_message.clone()));
            }
        }
        if self.inner.stopped.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(close_message)
        }
    }

    async fn handle_text(&self, state: &Arc<AppState>, text: &str) {
        let Ok(frame) = serde_json::from_str::<Inbound>(text) else {
            return;
        };
        match frame {
            Inbound::Ready { device } => {
                if let Some(device) = device {
                    if device.id == self.device_id() {
                        state.agents.set_device_name(&device.name);
                    }
                    self.set_presence(merge_self(self.view().devices, device));
                }
                self.set_state("online", None);
            }
            Inbound::Presence { devices } => self.set_presence(devices),
            Inbound::Event { chat_id, payload } => {
                // A machine publishes three kinds on the same channel: the
                // chat's own stream, the task-board overview, and the preview
                // panel. The renderer keeps its own events, so it never learns
                // that the run is remote.
                match payload.get("type").and_then(Value::as_str) {
                    Some("agents") => {
                        if let Some(overview) = payload.get("overview") {
                            (self.inner.emit)("hook://agents", overview.clone());
                        }
                    }
                    Some("preview") => {
                        let mut preview = payload.get("preview").cloned().unwrap_or(Value::Null);
                        let device_id = preview
                            .get("deviceId")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .to_string();
                        if !device_id.is_empty() && device_id != self.device_id() {
                            let source_chat = preview
                                .get("chatId")
                                .and_then(Value::as_str)
                                .unwrap_or(&chat_id);
                            let file = preview.get("file").and_then(Value::as_str).unwrap_or("");
                            let key = format!("{device_id}|{source_chat}|{file}");
                            let cached = lock(&self.inner.previews)
                                .get(&key)
                                .filter(|(_, at)| at.elapsed() < Duration::from_secs(300))
                                .map(|(url, _)| url.clone());
                            let url = match cached {
                                Some(url) => Some(url),
                                None => {
                                    let minted = crate::devices::preview_ticket(
                                        &state.auth,
                                        &device_id,
                                        source_chat,
                                        file,
                                    )
                                    .await
                                    .ok();
                                    if let Some(url) = &minted {
                                        lock(&self.inner.previews).insert(
                                            key,
                                            (url.clone(), std::time::Instant::now()),
                                        );
                                    }
                                    minted
                                }
                            };
                            if let Some(url) = url {
                                if let Some(object) = preview.as_object_mut() {
                                    object.insert("url".into(), Value::String(url));
                                    object.insert("remote".into(), Value::Bool(true));
                                }
                            }
                        }
                        (self.inner.emit)("hook://preview", preview);
                    }
                    Some("previewClosed") => {
                        (self.inner.emit)(
                            "hook://preview",
                            json!({ "active": false, "chatId": chat_id }),
                        );
                    }
                    _ => {
                        (self.inner.emit)(
                            "hook://chat",
                            json!({ "chatId": chat_id, "event": payload }),
                        );
                    }
                }
            }
            Inbound::PreviewRequest {
                id,
                chat_id,
                method,
                path,
            } => {
                let page = if method == "GET" || method == "HEAD" {
                    state.preview.fetch(&chat_id, &path)
                } else {
                    Err("Method not allowed.".to_string())
                };
                let frame = match page {
                    Ok(page) => json!({
                        "kind": "previewResult",
                        "id": id,
                        "status": page.status,
                        "contentType": page.content_type,
                        "body": base64::engine::general_purpose::STANDARD.encode(&page.body),
                    }),
                    Err(message) => json!({
                        "kind": "previewResult",
                        "id": id,
                        "status": 404,
                        "contentType": "text/plain; charset=utf-8",
                        "body": base64::engine::general_purpose::STANDARD.encode(message.as_bytes()),
                    }),
                };
                let _ = self.send_frame(frame);
            }
            Inbound::Rpc {
                id,
                from,
                method,
                params,
            } => {
                let relay = RelayClient {
                    inner: self.inner.clone(),
                };
                let state = state.clone();
                tauri::async_runtime::spawn(async move {
                    let result = crate::remote::handle(&state, &from, &method, params).await;
                    let frame = match result {
                        Ok(value) => json!({ "kind": "rpcResult", "id": id, "ok": true, "result": value }),
                        Err(error) => json!({
                            "kind": "rpcResult",
                            "id": id,
                            "ok": false,
                            "error": { "code": error.code, "message": error.message },
                        }),
                    };
                    let _ = relay.send_frame(frame);
                });
            }
            Inbound::RpcResult {
                id,
                ok,
                result,
                error,
            } => {
                if let Some(sender) = lock(&self.inner.pending).remove(&id) {
                    let outcome = if ok {
                        Ok(result)
                    } else {
                        Err(error.unwrap_or(RpcFailure {
                            code: "failed".into(),
                            message: "The machine could not complete that.".into(),
                        }))
                    };
                    let _ = sender.send(outcome);
                }
            }
            Inbound::Error { code, message, id } => {
                if let Some(id) = id {
                    if let Some(sender) = lock(&self.inner.pending).remove(&id) {
                        let _ = sender.send(Err(RpcFailure { code, message }));
                        return;
                    }
                }
                self.set_error(Some(message));
            }
        }
    }
}

fn merge_self(mut devices: Vec<DeviceView>, device: DeviceView) -> Vec<DeviceView> {
    if let Some(existing) = devices.iter_mut().find(|entry| entry.id == device.id) {
        *existing = device;
    } else {
        devices.push(device);
    }
    devices
}

/// `https://host` → `wss://host/api/relay`; `http://host` → `ws://…`.
fn relay_url(base_url: &str) -> Result<String, String> {
    let base = base_url.trim_end_matches('/');
    let rest = base
        .strip_prefix("https://")
        .map(|rest| format!("wss://{rest}"))
        .or_else(|| {
            base.strip_prefix("http://")
                .map(|rest| format!("ws://{rest}"))
        })
        .ok_or_else(|| "The account service address is not an http(s) URL.".to_string())?;
    Ok(format!("{rest}/api/relay"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_relay_url_follows_the_account_origin() {
        assert_eq!(
            relay_url("https://hookcode.io").unwrap(),
            "wss://hookcode.io/api/relay"
        );
        assert_eq!(
            relay_url("https://hookcode.io/").unwrap(),
            "wss://hookcode.io/api/relay"
        );
        assert_eq!(
            relay_url("http://127.0.0.1:5173").unwrap(),
            "ws://127.0.0.1:5173/api/relay"
        );
        assert!(relay_url("ftp://hookcode.io").is_err());
    }

    #[test]
    fn an_inbound_rpc_result_reads_the_server_shape() {
        let frame: Inbound = serde_json::from_str(
            r#"{"kind":"rpcResult","id":"rpc_1","ok":false,"error":{"code":"device_offline","message":"That machine is not running Hook right now."}}"#,
        )
        .unwrap();
        match frame {
            Inbound::RpcResult { id, ok, error, .. } => {
                assert_eq!(id, "rpc_1");
                assert!(!ok);
                assert_eq!(error.unwrap().code, "device_offline");
            }
            _ => panic!("wrong frame"),
        }
    }
}
