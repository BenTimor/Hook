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
// A page read answers with up to 200k characters of text, and JSON escaping can
// double that. A `run_js` answer is whatever the script returned, and a
// `Page.captureScreenshot` is a base64 image, which is megabytes. So the cap has
// to hold the largest thing a tool legitimately hands back. The channel is
// loopback and token-authenticated; this is a size a browser really sends, not a
// trust boundary being widened. A body over the cap is refused, which a tool
// sees as a browser that never answered.
const MAX_BODY: usize = 8 * 1024 * 1024;
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
    /// Advanced mode, as the account holds it. The dock asks once when it opens
    /// and draws the turn's thinking and tool calls from it; the rest of the
    /// surface is the same either way.
    fn advanced_mode(&self) -> bool;
    /// Every conversation the dock may show, newest first, without content.
    fn chats(&self) -> Result<Value, String>;
    /// One conversation with its messages, or `None` for a chat this channel
    /// does not serve (a coding chat belongs to the engine on its machine).
    fn chat(&self, id: &str) -> Result<Option<Value>, String>;
    /// Start an empty conversation and return its id: the dock sends its first
    /// message into a chat it has not created yet.
    fn create(&self) -> Result<String, String>;
    /// Append the user's message and start the turn. Returns immediately: the
    /// browser watches the turn through `GET /chats/<id>/events` while it runs
    /// (`stream_chat`), so this call has nothing to keep alive.
    fn send(&self, id: &str, text: &str, context: &str) -> Result<(), String>;
    fn stop(&self, id: &str) -> Result<(), String>;
    /// The next page task for this machine's browser, held open until there is
    /// one or `wait` runs out. `None` is "nothing to do", which is also how an
    /// idle browser says it is alive: every poll is a heartbeat.
    fn browser_task(
        &self,
        wait: std::time::Duration,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + '_>>;
    /// The browser's answer to one task, by id.
    fn browser_answer(&self, id: &str, body: &Value);
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
    // Advanced mode draws what a reply did on the way to answering it, so the
    // thinking, the calls and the result rows travel too. A simple-mode page
    // ignores the extra fields; the builder in `packages/chat` is what decides.
    json!({
        "id": message.id,
        "role": message.role,
        "content": message.content,
        "status": message.status,
        "hidden": message.hidden,
        "error": message.error,
        "reasoning": message.reasoning,
        "toolCalls": message.tool_calls.as_ref().map(|calls| {
            calls
                .iter()
                .map(|call| {
                    json!({
                        "id": call.id,
                        "name": call.name,
                        "arguments": call.arguments,
                    })
                })
                .collect::<Vec<Value>>()
        }),
        "toolCallId": message.tool_call_id,
        "compaction": message.compaction.as_ref().map(|fold| {
            json!({
                "messages": fold.messages,
                "tokensBefore": fold.tokens_before,
                "tokensAfter": fold.tokens_after,
            })
        }),
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

    fn advanced_mode(&self) -> bool {
        self.state.advanced_mode()
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

    fn browser_task(
        &self,
        wait: std::time::Duration,
    ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + '_>> {
        Box::pin(async move { self.state.browser.next_waiting(wait).await })
    }

    fn browser_answer(&self, id: &str, body: &Value) {
        self.state.browser.answer(id, body.clone());
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

/// One server-sent event: `event:` names it, `data:` is the JSON the page reads.
/// The three fields in it (`kind`, `text`, `messages`) are the same ones the
/// dock's `DockEvent` already has, so the stream is not a second protocol.
async fn sse(
    stream: &mut tokio::net::TcpStream,
    event: &str,
    data: &Value,
) -> std::io::Result<()> {
    let payload = serde_json::to_string(data).unwrap_or_else(|_| "{}".into());
    // A JSON body cannot contain a raw newline, so one `data:` line is enough.
    let frame = format!("event: {event}\ndata: {payload}\n\n");
    stream.write_all(frame.as_bytes()).await?;
    stream.flush().await
}

/// How often the host looks at its own store while a turn runs. This is the only
/// clock in the loop: the browser no longer asks, so nothing here is a request.
const STREAM_TICK: std::time::Duration = std::time::Duration::from_millis(80);
/// A stream is not a lease on the host: a browser that was killed without
/// closing its socket must not pin a turn forever.
const STREAM_MAX: std::time::Duration = std::time::Duration::from_secs(900);
/// `send` answers after the turn is kicked, so a stream opened right behind it can
/// look at the chat a hair early. This is how long it waits before deciding the
/// turn it was opened for has already finished.
const STREAM_GRACE: std::time::Duration = std::time::Duration::from_secs(3);
/// A comment line keeps a quiet turn (a long tool call) from looking like a dead
/// connection to anything between here and the page.
const STREAM_KEEPALIVE: std::time::Duration = std::time::Duration::from_secs(15);

fn view_parts(view: &Value) -> (bool, Vec<Value>, Value) {
    let busy = view
        .get("chat")
        .and_then(|chat| chat.get("busy"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let messages = view
        .get("messages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let chat = view.get("chat").cloned().unwrap_or(Value::Null);
    (busy, messages, chat)
}

/// One turn, written as it happens: `started` with the whole conversation the
/// first time a reply appears, `delta` with only the text that grew, `done` with
/// the authoritative list at the end.
///
/// The page used to ask for all of this every third of a second, which sent the
/// whole conversation back per tick. The answer is the same one; only the asking
/// is gone — the browser process keeps this response open and pushes each frame
/// to the page over mojom (`hook_channel.cc`, `ChatObserver`).
async fn stream_chat(
    stream: &mut tokio::net::TcpStream,
    backend: Arc<dyn ChannelBackend>,
    id: &str,
) -> std::io::Result<()> {
    // A chat this channel does not serve is a plain answer, not an open stream
    // that says nothing.
    let mut view = match backend.chat(id) {
        Ok(Some(view)) => view,
        Ok(None) => {
            return respond(
                stream,
                404,
                &json!({ "ok": false, "error": "That conversation is not served here." }),
            )
            .await
        }
        Err(error) => {
            return respond(stream, 500, &json!({ "ok": false, "error": error })).await
        }
    };

    stream
        .write_all(
            b"HTTP/1.1 200 OK\r\n\
              Content-Type: text/event-stream\r\n\
              Cache-Control: no-store\r\n\
              X-Accel-Buffering: no\r\n\
              Access-Control-Allow-Origin: *\r\n\
              Connection: close\r\n\r\n",
        )
        .await?;
    stream.flush().await?;

    let opened = std::time::Instant::now();
    let mut written = std::time::Instant::now();
    let mut seen_busy = false;
    let mut answer_id: Option<String> = None;
    let mut answer_text = String::new();

    loop {
        if opened.elapsed() > STREAM_MAX {
            let _ = sse(
                stream,
                "error",
                &json!({ "kind": "error", "error": "This turn is still running; open the chat again to follow it." }),
            )
            .await;
            return Ok(());
        }

        let (busy, messages, chat) = view_parts(&view);
        if busy {
            seen_busy = true;
        }

        if let Some(reply) = messages
            .iter()
            .rev()
            .find(|message| message["role"] == "assistant")
        {
            let reply_id = reply["id"].as_str().unwrap_or_default().to_string();
            let text = reply["content"].as_str().unwrap_or_default();
            if answer_id.as_deref() != Some(reply_id.as_str()) {
                // A reply the page has not seen: it needs the list, not a suffix.
                sse(
                    stream,
                    "started",
                    &json!({ "kind": "started", "chat": &chat, "messages": &messages }),
                )
                .await?;
                answer_id = Some(reply_id);
                answer_text = text.to_string();
                written = std::time::Instant::now();
            } else if text.len() > answer_text.len() && text.starts_with(&answer_text) {
                let delta = text[answer_text.len()..].to_string();
                sse(
                    stream,
                    "delta",
                    &json!({ "kind": "delta", "id": reply_id, "text": delta }),
                )
                .await?;
                answer_text = text.to_string();
                written = std::time::Instant::now();
            } else if text != answer_text {
                // Not append-only (an edited or rewritten reply): send it whole.
                sse(
                    stream,
                    "started",
                    &json!({ "kind": "started", "chat": &chat, "messages": &messages }),
                )
                .await?;
                answer_text = text.to_string();
                written = std::time::Instant::now();
            }
        }

        // The end carries the authoritative list, so whatever a delta missed is
        // drawn once more and only once.
        if !busy && (seen_busy || answer_id.is_some() || opened.elapsed() >= STREAM_GRACE) {
            sse(
                stream,
                "done",
                &json!({ "kind": "done", "chat": &chat, "messages": &messages }),
            )
            .await?;
            return Ok(());
        }

        if written.elapsed() >= STREAM_KEEPALIVE {
            stream.write_all(b": keep-alive\n\n").await?;
            stream.flush().await?;
            written = std::time::Instant::now();
        }

        tokio::time::sleep(STREAM_TICK).await;
        view = match backend.chat(id) {
            Ok(Some(view)) => view,
            Ok(None) => {
                sse(
                    stream,
                    "error",
                    &json!({ "kind": "error", "error": "That conversation is not served here." }),
                )
                .await?;
                return Ok(());
            }
            Err(error) => {
                sse(stream, "error", &json!({ "kind": "error", "error": error })).await?;
                return Ok(());
            }
        };
    }
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
        // How the dock draws a turn. Append-only like every route here: a host
        // that does not know it is an older Hook, and the page keeps the simple
        // view rather than failing to draw.
        ("GET", ["settings"]) => {
            respond(
                &mut stream,
                200,
                &json!({ "ok": true, "advancedMode": backend.advanced_mode() }),
            )
            .await
        }
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
        // Hook Browser asking for page work: the queue `browser.rs` fills when a
        // chat somewhere on the account reads a tab on this machine. Signed in,
        // like every other route below the gate: a signed-out browser has no
        // dock to read for.
        ("GET", ["browser", "tasks"]) => {
            let task = backend
                .browser_task(std::time::Duration::from_secs(10))
                .await;
            respond(&mut stream, 200, &json!({ "ok": true, "task": task })).await
        }
        ("POST", ["browser", "tasks", id]) => {
            let body: Value = serde_json::from_slice(&request.body).unwrap_or(Value::Null);
            backend.browser_answer(id, &body);
            respond(&mut stream, 200, &json!({ "ok": true })).await
        }
        // One turn, as it is written: the dock holds this response open and is
        // pushed each change, instead of asking for the whole conversation every
        // third of a second (`stream_chat`).
        ("GET", ["chats", id, "events"]) => stream_chat(&mut stream, backend, id).await,
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
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    struct Fake {
        signed_in: AtomicBool,
        /// A turn that grows while something watches it: `chat` hands out one
        /// more letter of it per read, and stays busy until the last.
        growing: AtomicBool,
        turns: AtomicUsize,
    }

    impl Fake {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                signed_in: AtomicBool::new(true),
                growing: AtomicBool::new(false),
                turns: AtomicUsize::new(0),
            })
        }

        fn growing() -> Arc<Self> {
            let fake = Self::new();
            fake.growing.store(true, Ordering::SeqCst);
            fake
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
        fn advanced_mode(&self) -> bool {
            true
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
            if self.growing.load(Ordering::SeqCst) {
                // "abcdef" a letter at a time, busy until the last one: what a
                // stream is supposed to turn into one `delta` per tick.
                let letters = self.turns.fetch_add(1, Ordering::SeqCst).min(6);
                let busy = letters < 6;
                let text = "abcdef".get(..letters).unwrap_or_default();
                return Ok(Some(json!({
                    "chat": { "id": "c1", "title": "First", "updatedAt": 1, "busy": busy, "unsynced": false },
                    "messages": [
                        { "id": "m1", "role": "user", "content": "hello", "status": "complete", "hidden": false, "error": null },
                        { "id": "m2", "role": "assistant", "content": text, "status": "streaming", "hidden": false, "error": null },
                    ],
                })));
            }
            Ok(Some(json!({
                "chat": { "id": "c1", "title": "First", "updatedAt": 1, "busy": false, "unsynced": false },
                "messages": [ { "id": "m1", "role": "user", "content": "hello", "status": "complete", "hidden": false, "error": null } ],
            })))
        }
        fn create(&self) -> Result<String, String> {
            Ok("c2".into())
        }
        fn browser_task(
            &self,
            _wait: std::time::Duration,
        ) -> Pin<Box<dyn Future<Output = Option<Value>> + Send + '_>> {
            Box::pin(async { None })
        }

        fn browser_answer(&self, _id: &str, _body: &Value) {}

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

    /// Read a response that declares no body length: until the server closes.
    async fn stream(port: u16, path: &str, token: Option<&str>) -> (u16, String) {
        use tokio::io::AsyncReadExt as _;
        let mut socket = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connect");
        let mut request = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n");
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        request.push_str("Content-Length: 0\r\n\r\n");
        socket.write_all(request.as_bytes()).await.expect("write");
        let mut raw = String::new();
        socket.read_to_string(&mut raw).await.expect("read");
        let status = raw
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .and_then(|code| code.parse().ok())
            .unwrap_or(0);
        (status, raw)
    }

    #[tokio::test]
    async fn a_turn_streams_its_text_instead_of_being_asked_for() {
        let (port, token) = serve(Fake::growing());
        let (status, raw) = stream(port, "/chats/c1/events", Some(&token)).await;
        assert_eq!(status, 200, "{raw}");
        assert!(raw.contains("Content-Type: text/event-stream"), "{raw}");
        // The first frame is the reply the page has not seen, then only what grew.
        assert!(raw.contains("event: started"), "{raw}");
        assert!(raw.contains("\"kind\":\"delta\""), "{raw}");
        assert!(raw.contains("\"text\":\"f\""), "{raw}");
        // And the end carries the finished transcript, once.
        assert_eq!(raw.matches("event: done").count(), 1, "{raw}");
        assert!(raw.contains("\"content\":\"abcdef\""), "{raw}");
    }

    #[tokio::test]
    async fn a_stream_for_a_chat_it_does_not_serve_is_a_404() {
        let (port, token) = serve(Fake::new());
        let (status, _) = stream(port, "/chats/nope/events", Some(&token)).await;
        assert_eq!(status, 404);
    }

    #[tokio::test]
    async fn a_stream_needs_the_token_like_every_other_route() {
        let (port, _) = serve(Fake::growing());
        let (status, _) = stream(port, "/chats/c1/events", None).await;
        assert_eq!(status, 403);
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
    async fn the_dock_asks_whether_the_advanced_view_is_on() {
        let (port, token) = serve(Fake::new());
        // The account's answer, and the same gate as the rest: it is account
        // state behind the token, not something `/health` says.
        let (status, _) = get(port, "/settings", None).await;
        assert_eq!(status, 403);
        let (status, body) = get(port, "/settings", Some(&token)).await;
        assert_eq!(status, 200);
        assert_eq!(body["advancedMode"], true);
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

    /// A reply that used a tool, with the thinking that led to it: what advanced
    /// mode needs and what the simple view ignores.
    #[test]
    fn a_message_carries_what_the_advanced_view_draws() {
        let message = crate::store::Message {
            id: "m1".into(),
            role: "assistant".into(),
            content: "Here it is.".into(),
            reasoning: Some("the file is in src".into()),
            reasoning_field: None,
            created_at: 1,
            status: "complete".into(),
            error: None,
            usage: None,
            tool_calls: Some(vec![crate::store::ToolCallRecord {
                id: "call-1".into(),
                name: "read_file".into(),
                arguments: r#"{"path":"src/lib.rs"}"#.into(),
            }]),
            tool_call_id: None,
            hidden: false,
            kind: None,
            attachments: Vec::new(),
            compaction: None,
        };
        let json = message_json(&message);
        assert_eq!(json["reasoning"], "the file is in src");
        assert_eq!(json["toolCalls"][0]["name"], "read_file");
        assert_eq!(json["toolCalls"][0]["arguments"], r#"{"path":"src/lib.rs"}"#);
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
