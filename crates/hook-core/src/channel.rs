//! The browser channel: a loopback HTTP surface for Hook Browser.
//!
//! Why it exists. `hook-core` is the backend every product links, but the browser
//! has no Tauri: it cannot call an IPC command, and a `chrome://` renderer is not
//! allowed to make a network request at all (Chromium kills the renderer for
//! "Incorrect scheme"). So a *running* Hook app publishes this channel on
//! 127.0.0.1, writes a descriptor into the shared `app.hook` folder, and the
//! browser's own process reads it and asks the browser process to make the calls.
//!
//! It is the cheap proof of the direction `docs/browser-poc-plan.md` calls Step 3;
//! the shipping shape is a sidecar that owns auth and the turn. The routes and
//! their JSON are therefore deliberately boring, and [`ChannelBackend`] is the
//! seam: the sidecar implements the same trait without an `AppState`.
//!
//! Security, in order of what matters:
//!
//! * loopback only, one ephemeral port, and a token minted per process;
//! * the token lives in `%APPDATA%\app.hook\browser-channel.json`, beside the
//!   account file (mode 0600 where the OS has modes), and is required on every
//!   route but `/health`;
//! * nothing is served while signed out, so a signed-out machine has no window
//!   into a previous account's chats;
//! * the channel is read-and-send only. It never renames, deletes, syncs or
//!   changes a setting — those stay in the window, with the user.

use std::future::Future;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const MAX_HEAD: usize = 16 * 1024;
const MAX_BODY: usize = 64 * 1024;
const DESCRIPTOR_PREFIX: &str = "browser-channel";
const CHANNEL_DIR: &str = "app.hook";

/// What the HTTP surface asks the application for.
///
/// A trait so the routes can be tested without a Tauri `AppHandle`, and so the
/// sidecar that replaces this channel can implement it directly.
pub trait ChannelBackend: Send + Sync {
    fn product(&self) -> &'static str;
    fn version(&self) -> String;
    fn signed_in(&self) -> bool;
    /// Every conversation the dock may show, newest first, without content.
    fn chats(&self) -> Result<Value, String>;
    /// One conversation with its messages, or `None` for a chat this channel
    /// does not serve (a coding chat belongs to the engine on its machine).
    fn chat(&self, id: &str) -> Result<Option<Value>, String>;
    /// Start an empty conversation and return its id: the dock sends its first
    /// message into a chat it has not created yet.
    fn create(&self) -> Result<String, String>;
    /// Append the user's message and start the turn. Returns immediately: the
    /// browser polls `chat` while it runs, so there is no stream to keep alive.
    fn send(&self, id: &str, text: &str, context: &str) -> Result<(), String>;
    fn stop(&self, id: &str) -> Result<(), String>;
    /// The account, as `auth_signer` sees it: the pending code while the device
    /// flow waits, and `signed_in` once it has been approved.
    fn sign_in_state(&self) -> Value;
    /// Starts the device flow for the browser page. The page shows the code; the
    /// app keeps polling and is what writes the account file, so the page has
    /// nothing to hold onto but a number.
    fn start_sign_in(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>>;
    /// Abandons a pending flow, so a page that was closed is not left waiting on
    /// a code the app will never finish.
    fn cancel_sign_in(&self);
}

/// The live backend: the running app's store, turn state and account.
pub struct LiveBackend {
    pub state: Arc<crate::state::AppState>,
}

fn message_json(message: &crate::store::Message) -> Value {
    json!({
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "status": message.status,
        "hidden": message.hidden,
        "error": message.error,
    })
}

fn meta_json(meta: &crate::store::ChatMeta, busy: bool, unsynced: bool) -> Value {
    json!({
        "id": meta.id,
        "title": meta.title,
        "updatedAt": meta.updated_at,
        "busy": busy,
        "unsynced": unsynced,
    })
}

impl ChannelBackend for LiveBackend {
    fn product(&self) -> &'static str {
        self.state.product.slug()
    }

    fn version(&self) -> String {
        crate::version::current()
    }

    fn signed_in(&self) -> bool {
        self.state.auth.token().is_some()
    }

    fn chats(&self) -> Result<Value, String> {
        let unsynced = !self.state.sync.status().enabled;
        let list = self.state.store.list()?;
        let rows: Vec<Value> = list
            .iter()
            // A conversation with a coding agent belongs to a folder and an
            // engine on one computer; the dock is the chat agent's panel.
            .filter(|meta| meta.kind.as_deref() != Some("coding"))
            .map(|meta| meta_json(meta, self.state.turns.is_busy(&meta.id), unsynced))
            .collect();
        Ok(Value::Array(rows))
    }

    fn chat(&self, id: &str) -> Result<Option<Value>, String> {
        let chat = self.state.store.load(id)?;
        if chat.meta.kind.as_deref() == Some("coding") {
            return Ok(None);
        }
        let unsynced = !self.state.sync.status().enabled;
        let messages: Vec<Value> = chat.messages.iter().map(message_json).collect();
        Ok(Some(json!({
            "chat": meta_json(&chat.meta, self.state.turns.is_busy(id), unsynced),
            "messages": messages,
        })))
    }

    fn create(&self) -> Result<String, String> {
        let mut chat = crate::store::Chat::new();
        let id = chat.meta.id.clone();
        self.state.store.save(&mut chat)?;
        Ok(id)
    }

    fn send(&self, id: &str, text: &str, context: &str) -> Result<(), String> {
        self.state.set_chat_context(context);
        crate::session::send_chat_message(&self.state, id, text)
    }

    fn stop(&self, id: &str) -> Result<(), String> {
        crate::session::stop_chat_turn(&self.state, id);
        Ok(())
    }

    fn sign_in_state(&self) -> Value {
        serde_json::to_value(self.state.auth.view()).unwrap_or(Value::Null)
    }

    fn cancel_sign_in(&self) {
        self.state.auth.cancel();
    }

    fn start_sign_in(
        &self,
    ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
        Box::pin(async move {
            let view = crate::session::begin_browser_sign_in(&self.state).await?;
            serde_json::to_value(view).map_err(|error| error.to_string())
        })
    }
}

/// The server itself: one port, one token, one descriptor file.
pub struct Channel {
    token: String,
    port: AtomicU16,
    descriptor: Mutex<Option<PathBuf>>,
}

impl Default for Channel {
    fn default() -> Self {
        Self::new()
    }
}

impl Channel {
    pub fn new() -> Self {
        Self::with_token(
            &(uuid::Uuid::new_v4().simple().to_string()
                + &uuid::Uuid::new_v4().simple().to_string()),
        )
    }

    fn with_token(token: &str) -> Self {
        Self {
            token: token.to_string(),
            port: AtomicU16::new(0),
            descriptor: Mutex::new(None),
        }
    }

    /// Bind, publish the descriptor, and serve until the process ends.
    ///
    /// `data_dir` is this product's folder; the descriptor goes beside the shared
    /// account file, because that is the one place every product already agrees on.
    pub fn serve(self: &Arc<Self>, backend: Arc<dyn ChannelBackend>, data_dir: &std::path::Path) {
        if std::env::var("HOOK_CHANNEL").map(|value| value == "0").unwrap_or(false) {
            return;
        }
        let port = match self.bind_and_serve(backend.clone()) {
            Ok(port) => port,
            Err(error) => {
                eprintln!("hook: the browser channel is unavailable: {error}");
                return;
            }
        };
        if let Some(path) = descriptor_path(data_dir, backend.product()) {
            match write_descriptor(&path, port, &self.token, backend.as_ref()) {
                Ok(()) => *lock(&self.descriptor) = Some(path),
                Err(error) => eprintln!("hook: could not publish the browser channel: {error}"),
            }
        }
    }

    /// Bind the port and start accepting. Returns the port.
    ///
    /// Separate from `serve` so a test can drive the real HTTP surface without a
    /// descriptor file (and therefore without a data folder).
    /// Where a client should look, for a log line. Empty until the port is bound.
    pub fn describe(&self) -> String {
        match self.port.load(Ordering::SeqCst) {
            0 => "not started".to_string(),
            port => format!("http://127.0.0.1:{port}"),
        }
    }

    fn bind_and_serve(self: &Arc<Self>, backend: Arc<dyn ChannelBackend>) -> std::io::Result<u16> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
        listener.set_nonblocking(true)?;
        let port = listener.local_addr()?.port();
        self.port.store(port, Ordering::SeqCst);

        let token = self.token.clone();
        crate::rt::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("hook: the browser channel failed: {error}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let backend = backend.clone();
                let token = token.clone();
                crate::rt::spawn(async move {
                    if let Err(error) = handle(stream, &token, backend).await {
                        if error.kind() != ErrorKind::BrokenPipe
                            && error.kind() != ErrorKind::ConnectionReset
                        {
                            eprintln!("hook: browser channel request failed: {error}");
                        }
                    }
                });
            }
        });
        Ok(port)
    }
}

impl Drop for Channel {
    fn drop(&mut self) {
        if let Some(path) = lock(&self.descriptor).take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|error| error.into_inner())
}

/// Where this product's descriptor goes: `browser-channel.<product>.json` beside
/// the shared account file.
///
/// One file per product, because the folder is shared and two hosts running at
/// once is the normal case once the browser is a product of its own: a Hook app
/// in the tray and the browser's own host must not overwrite each other's token,
/// and a browser must be able to tell which of them answered.
fn descriptor_path(data_dir: &std::path::Path, product: &str) -> Option<PathBuf> {
    let parent = data_dir.parent()?;
    Some(
        parent
            .join(CHANNEL_DIR)
            .join(format!("{DESCRIPTOR_PREFIX}.{product}.json")),
    )
}

fn write_descriptor(
    path: &std::path::Path,
    port: u16,
    token: &str,
    backend: &dyn ChannelBackend,
) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    }
    let body = json!({
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "product": backend.product(),
        "version": backend.version(),
    });
    let raw = serde_json::to_string_pretty(&body).map_err(|error| error.to_string())?;
    // A unique temp name, then a rename: a browser reading this file sees the old
    // descriptor or the new one, never half a token.
    let unique = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("json.tmp-{}-{unique}", std::process::id()));
    std::fs::write(&tmp, raw).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())
}

// ------------------------------------------------------------------ requests --

struct Request {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl Request {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }

    fn token(&self) -> Option<&str> {
        if let Some(value) = self.header("authorization") {
            if let Some(rest) = value.strip_prefix("Bearer ") {
                return Some(rest.trim());
            }
        }
        self.header("x-hook-token")
    }
}

#[derive(Deserialize)]
struct SendBody {
    text: String,
    #[serde(default)]
    context: String,
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> std::io::Result<Option<Request>> {
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 4096];
    let split = loop {
        if head.len() > MAX_HEAD {
            return Ok(None);
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(None);
        }
        head.extend_from_slice(&chunk[..read]);
        if let Some(at) = head.windows(4).position(|window| window == b"\r\n\r\n") {
            break at + 4;
        }
    };

    let text = String::from_utf8_lossy(&head[..split]).to_string();
    let mut lines = text.lines();
    let mut first = lines.next().unwrap_or("").split_whitespace();
    let method = first.next().unwrap_or("").to_ascii_uppercase();
    let target = first.next().unwrap_or("/");
    let path = target.split(['?', '#']).next().unwrap_or("/").to_string();

    let mut headers = Vec::new();
    let mut length = 0usize;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let value = value.trim().to_string();
        if key.eq_ignore_ascii_case("content-length") {
            length = value.parse().unwrap_or(0);
        }
        headers.push((key, value));
    }

    let mut body = head[split..].to_vec();
    if length > MAX_BODY {
        return Ok(None);
    }
    while body.len() < length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }

    Ok(Some(Request {
        method,
        path,
        headers,
        body,
    }))
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &Value,
) -> std::io::Result<()> {
    let payload = serde_json::to_string(body).unwrap_or_else(|_| "{\"ok\":false}".into());
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {length}\r\n\
         Cache-Control: no-store\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Connection: close\r\n\r\n",
        reason = reason_for(status),
        length = payload.len(),
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(payload.as_bytes()).await?;
    stream.flush().await
}

fn reason_for(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Internal Server Error",
    }
}

async fn handle(
    mut stream: tokio::net::TcpStream,
    token: &str,
    backend: Arc<dyn ChannelBackend>,
) -> std::io::Result<()> {
    let Some(request) = read_request(&mut stream).await? else {
        return respond(
            &mut stream,
            400,
            &json!({ "ok": false, "error": "Malformed request." }),
        )
        .await;
    };

    // A liveness probe, so the browser can tell a stale descriptor from a live
    // one without a credential.
    if request.method == "GET" && request.path == "/health" {
        return respond(
            &mut stream,
            200,
            &json!({
                "ok": true,
                "product": backend.product(),
                "version": backend.version(),
                "signedIn": backend.signed_in(),
            }),
        )
        .await;
    }

    if request.token() != Some(token) {
        return respond(
            &mut stream,
            403,
            &json!({ "ok": false, "error": "The channel needs its token." }),
        )
        .await;
    }
    let segments: Vec<&str> = request.path.trim_start_matches('/').split('/').collect();

    // Signing in is the one thing the browser may ask while signed out: it is
    // the page that shows the code, and the app that polls for the approval.
    // Everything below this block needs a session.
    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["auth", "status"]) => {
            return respond(
                &mut stream,
                200,
                &json!({ "ok": true, "signIn": backend.sign_in_state() }),
            )
            .await;
        }
        ("POST", ["auth", "cancel"]) => {
            backend.cancel_sign_in();
            return respond(&mut stream, 200, &json!({ "ok": true })).await;
        }
        ("POST", ["auth", "start"]) => {
            return match backend.start_sign_in().await {
                Ok(view) => {
                    respond(&mut stream, 202, &json!({ "ok": true, "signIn": view })).await
                }
                Err(error) => {
                    respond(&mut stream, 400, &json!({ "ok": false, "error": error })).await
                }
            };
        }
        _ => {}
    }

    // Everything below needs a session: a signed-out machine has no window into
    // a previous account's chats.
    if !backend.signed_in() {
        return respond(
            &mut stream,
            403,
            &json!({ "ok": false, "error": "Sign in to Hook first." }),
        )
        .await;
    }

    match (request.method.as_str(), segments.as_slice()) {
        ("GET", ["chats"]) => match backend.chats() {
            Ok(chats) => respond(&mut stream, 200, &json!({ "ok": true, "chats": chats })).await,
            Err(error) => respond(&mut stream, 500, &json!({ "ok": false, "error": error })).await,
        },
        ("GET", ["chats", id]) => match backend.chat(id) {
            Ok(Some(view)) => {
                respond(&mut stream, 200, &json!({ "ok": true, "view": view })).await
            }
            Ok(None) => respond(
                &mut stream,
                404,
                &json!({ "ok": false, "error": "That conversation is not served here." }),
            )
            .await,
            Err(error) => respond(&mut stream, 500, &json!({ "ok": false, "error": error })).await,
        },
        ("POST", ["chats"]) => match backend.create() {
            Ok(id) => respond(&mut stream, 202, &json!({ "ok": true, "chatId": id })).await,
            Err(error) => respond(&mut stream, 500, &json!({ "ok": false, "error": error })).await,
        },
        ("POST", ["chats", id, "send"]) => {
            let body: SendBody = match serde_json::from_slice(&request.body) {
                Ok(body) => body,
                Err(error) => {
                    return respond(
                        &mut stream,
                        400,
                        &json!({ "ok": false, "error": format!("Bad body: {error}") }),
                    )
                    .await;
                }
            };
            match backend.send(id, body.text.trim(), &body.context) {
                Ok(()) => {
                    respond(&mut stream, 202, &json!({ "ok": true, "chatId": id })).await
                }
                Err(error) => {
                    respond(&mut stream, 400, &json!({ "ok": false, "error": error })).await
                }
            }
        }
        ("POST", ["chats", id, "stop"]) => match backend.stop(id) {
            Ok(()) => respond(&mut stream, 200, &json!({ "ok": true })).await,
            Err(error) => respond(&mut stream, 400, &json!({ "ok": false, "error": error })).await,
        },
        _ => {
            respond(
                &mut stream,
                404,
                &json!({ "ok": false, "error": "No such route." }),
            )
            .await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};

    struct Fake {
        signed_in: AtomicBool,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                signed_in: AtomicBool::new(true),
            })
        }
    }

    const PENDING: &str = r#"{"signedIn":false,"state":"pending","userCode":"K7QM-2XPD","verificationUrl":"https://hookcode.io/authorize"}"#;

    impl ChannelBackend for Fake {
        fn product(&self) -> &'static str {
            "chat"
        }
        fn version(&self) -> String {
            "0.0.0-test".into()
        }
        fn signed_in(&self) -> bool {
            self.signed_in.load(Ordering::SeqCst)
        }
        fn chats(&self) -> Result<Value, String> {
            Ok(json!([
                { "id": "c1", "title": "First", "updatedAt": 1, "busy": false, "unsynced": false }
            ]))
        }
        fn chat(&self, id: &str) -> Result<Option<Value>, String> {
            if id != "c1" {
                return Ok(None);
            }
            Ok(Some(json!({
                "chat": { "id": "c1", "title": "First", "updatedAt": 1, "busy": false, "unsynced": false },
                "messages": [ { "id": "m1", "role": "user", "content": "hello", "status": "complete", "hidden": false, "error": null } ],
            })))
        }
        fn create(&self) -> Result<String, String> {
            Ok("c2".into())
        }
        fn send(&self, id: &str, text: &str, _context: &str) -> Result<(), String> {
            if id != "c1" {
                return Err("unknown chat".into());
            }
            if text.is_empty() {
                return Err("Message is empty".into());
            }
            Ok(())
        }
        fn stop(&self, _id: &str) -> Result<(), String> {
            Ok(())
        }
        fn sign_in_state(&self) -> Value {
            if self.signed_in() {
                json!({ "signedIn": true, "state": "signed_in" })
            } else {
                serde_json::from_str(PENDING).unwrap_or(Value::Null)
            }
        }
        fn start_sign_in(
            &self,
        ) -> Pin<Box<dyn Future<Output = Result<Value, String>> + Send + '_>> {
            Box::pin(async move { Ok(serde_json::from_str(PENDING).unwrap_or(Value::Null)) })
        }
        fn cancel_sign_in(&self) {}
    }

    /// Bind the server against a fake backend and return (port, token).
    fn serve(backend: Arc<dyn ChannelBackend>) -> (u16, String) {
        let channel = Arc::new(Channel::with_token("test-token"));
        let port = channel.bind_and_serve(backend).expect("bind");
        std::mem::forget(channel);
        (port, "test-token".into())
    }

    async fn get(port: u16, path: &str, token: Option<&str>) -> (u16, Value) {
        call(port, "GET", path, token, None).await
    }

    async fn call(
        port: u16,
        method: &str,
        path: &str,
        token: Option<&str>,
        body: Option<&str>,
    ) -> (u16, Value) {
        use tokio::io::AsyncBufReadExt;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let mut request = format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        let body = body.unwrap_or("");
        request.push_str(&format!("Content-Length: {}\r\n\r\n{body}", body.len()));
        stream.write_all(request.as_bytes()).await.expect("write");

        let mut reader = tokio::io::BufReader::new(stream);
        let mut status_line = String::new();
        reader.read_line(&mut status_line).await.expect("status");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        let mut length = 0usize;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("header");
            if line == "\r\n" || line.is_empty() {
                break;
            }
            if let Some((key, value)) = line.split_once(':') {
                if key.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap_or(0);
                }
            }
        }
        let mut payload = vec![0u8; length];
        use tokio::io::AsyncReadExt as _;
        reader.read_exact(&mut payload).await.expect("body");
        (status, serde_json::from_slice(&payload).unwrap_or(Value::Null))
    }

    #[tokio::test]
    async fn health_needs_no_token_and_reports_the_product() {
        let (port, _) = serve(Fake::new());
        let (status, body) = get(port, "/health", None).await;
        assert_eq!(status, 200);
        assert_eq!(body["product"], "chat");
        assert_eq!(body["signedIn"], true);
    }

    #[tokio::test]
    async fn every_route_but_health_needs_the_token() {
        let (port, _) = serve(Fake::new());
        let (status, _) = get(port, "/chats", None).await;
        assert_eq!(status, 403);
        let (status, _) = get(port, "/chats", Some("wrong")).await;
        assert_eq!(status, 403);
    }

    #[tokio::test]
    async fn a_signed_out_app_serves_nothing() {
        let fake = Fake::new();
        fake.signed_in.store(false, Ordering::SeqCst);
        let channel = Arc::new(Channel::with_token("t"));
        let port = channel
            .bind_and_serve(fake as Arc<dyn ChannelBackend>)
            .expect("bind");
        std::mem::forget(channel);
        let (status, body) = get(port, "/chats", Some("t")).await;
        assert_eq!(status, 403);
        assert_eq!(body["error"], "Sign in to Hook first.");
    }

    #[tokio::test]
    async fn signing_in_is_the_one_route_a_signed_out_machine_can_use() {
        let fake = Fake::new();
        fake.signed_in.store(false, Ordering::SeqCst);
        let (port, token) = serve(fake);

        // Signed out: the code, and the code alone.
        let (status, body) = get(port, "/auth/status", Some(&token)).await;
        assert_eq!(status, 200);
        assert_eq!(body["signIn"]["state"], "pending");
        assert_eq!(body["signIn"]["userCode"], "K7QM-2XPD");

        let (status, body) = call(port, "POST", "/auth/start", Some(&token), Some("{}")).await;
        assert_eq!(status, 202);
        assert_eq!(body["signIn"]["userCode"], "K7QM-2XPD");

        // The same machine still has no chats: the gate is only opened for
        // signing in.
        let (status, body) = get(port, "/chats", Some(&token)).await;
        assert_eq!(status, 403);
        assert!(body["error"].as_str().unwrap_or_default().contains("Sign in"));
    }

    #[tokio::test]
    async fn chats_and_one_chat_read_back() {
        let (port, token) = serve(Fake::new());
        let (status, body) = get(port, "/chats", Some(&token)).await;
        assert_eq!(status, 200);
        assert_eq!(body["chats"][0]["id"], "c1");

        let (status, body) = get(port, "/chats/c1", Some(&token)).await;
        assert_eq!(status, 200);
        assert_eq!(body["view"]["messages"][0]["content"], "hello");

        let (status, _) = get(port, "/chats/missing", Some(&token)).await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn send_accepts_a_message_and_refuses_an_empty_one() {
        let (port, token) = serve(Fake::new());
        let (status, body) = call(
            port,
            "POST",
            "/chats/c1/send",
            Some(&token),
            Some(r#"{"text":"hi","context":"Browser: Hook"}"#),
        )
        .await;
        assert_eq!(status, 202);
        assert_eq!(body["chatId"], "c1");

        let (status, _) = call(
            port,
            "POST",
            "/chats/c1/send",
            Some(&token),
            Some(r#"{"text":"   "}"#),
        )
        .await;
        assert_eq!(status, 400);
    }

    #[tokio::test]
    async fn a_conversation_can_be_created_for_the_first_message() {
        let (port, token) = serve(Fake::new());
        let (status, body) = call(port, "POST", "/chats", Some(&token), Some("{}")).await;
        assert_eq!(status, 202);
        assert_eq!(body["chatId"], "c2");
    }

    #[test]
    fn the_descriptor_is_written_beside_the_account_file() {
        let base = std::env::temp_dir().join(format!("hook-channel-{}", std::process::id()));
        let data = base.join("app.hook.chat");
        std::fs::create_dir_all(&data).expect("dir");
        let backend = Fake::new();
        let path = descriptor_path(&data, "chat").expect("path");
        write_descriptor(&path, 4242, "abc", backend.as_ref()).expect("write");
        let raw = std::fs::read_to_string(&path).expect("read");
        let parsed: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(parsed["port"], 4242);
        assert_eq!(parsed["token"], "abc");
        assert_eq!(parsed["product"], "chat");
        // Named after the product that published it: the folder is shared, and a
        // Hook app in the tray must not overwrite the browser's own host.
        let name = path.file_name().and_then(|name| name.to_str()).unwrap_or("");
        assert_eq!(name, "browser-channel.chat.json");
        let _ = std::fs::remove_dir_all(base);
    }
}
