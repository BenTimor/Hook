//! A loopback endpoint that runs the chat agent's own tools for a coding agent
//! the user talks to directly.
//!
//! A coding agent started by the chat agent only needs its own tools: the chat
//! agent organises projects, remembers things and touches Workspace. When the
//! user drives `pi` themselves there is no chat agent in the conversation, so
//! `pi` has to be able to do those things — and they live in Rust, against
//! Hook's own stores (projects, memory, the Workspace API), not in the engine.
//!
//! The guard extension (which runs inside `pi`) cannot call Rust, so the app
//! listens on loopback and the guard `fetch`es it:
//!
//! ```text
//! POST http://127.0.0.1:<port>/tool
//! x-hook-token: <random per chat>
//! {"name":"memory_search","args":{"query":"..."}}
//! ```
//!
//! The token is minted when a direct agent starts, written next to the tool
//! list in the agent's mailbox (`<updates>/tools.json`), and only grants the
//! tools that were advertised in that same file. Nothing outside the machine
//! can reach the listener, and nothing on the machine can use it without the
//! token.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, Weak};

use serde_json::{json, Value};

use crate::commands::AppState;

/// A tool call is a few kilobytes of JSON; the answer can be a page of results.
const MAX_REQUEST_BYTES: usize = 256 * 1024;
const MAX_HEADER_BYTES: usize = 16 * 1024;

/// What one token may do: which chat it acts for, and which tools it may call.
#[derive(Debug, Clone)]
struct Grant {
    chat_id: String,
    tools: Vec<String>,
}

#[derive(Default)]
struct Inner {
    /// token -> grant
    tokens: HashMap<String, Grant>,
    /// chat -> current token, so restarting an agent replaces the old one
    /// instead of leaving a growing pile of live tokens behind.
    by_chat: HashMap<String, String>,
    port: Option<u16>,
    server: Option<tauri::async_runtime::JoinHandle<()>>,
}

pub struct ToolBridge {
    inner: Mutex<Inner>,
    state: Mutex<Weak<AppState>>,
}

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

impl ToolBridge {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            state: Mutex::new(Weak::new()),
        }
    }

    /// Bind the listener once the app state exists. Tools are executed against
    /// it, so a call can only ever act for the signed-in account.
    pub fn serve(self: &Arc<Self>, state: Arc<AppState>) {
        *lock(&self.state) = Arc::downgrade(&state);
        let listener = match std::net::TcpListener::bind(("127.0.0.1", 0)) {
            Ok(listener) => listener,
            Err(error) => {
                eprintln!("hook: the coding-agent tool bridge is unavailable: {error}");
                return;
            }
        };
        let _ = listener.set_nonblocking(true);
        let port = match listener.local_addr() {
            Ok(addr) => addr.port(),
            Err(_) => return,
        };

        let bridge = self.clone();
        let handle = tauri::async_runtime::spawn(async move {
            let listener = match tokio::net::TcpListener::from_std(listener) {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("hook: coding-agent tool bridge failed: {error}");
                    return;
                }
            };
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    continue;
                };
                let bridge = bridge.clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = handle_connection(stream, bridge).await {
                        if error.kind() != std::io::ErrorKind::BrokenPipe
                            && error.kind() != std::io::ErrorKind::ConnectionReset
                        {
                            eprintln!("hook: coding-agent tool call failed: {error}");
                        }
                    }
                });
            }
        });

        let mut inner = lock(&self.inner);
        inner.port = Some(port);
        inner.server = Some(handle);
    }

    /// Write the tool list and a token into a direct agent's mailbox. The guard
    /// reads the file when it starts; without one the agent simply gets the
    /// coding engine's own tools.
    ///
    /// The caller decides *what* may be offered (config, product, memory
    /// switch); this only records it and mints the token. Deliberately no
    /// `AppState` here: this runs from the agent's start path, which the unit
    /// tests exercise, and reaching through the app state would drag the whole
    /// window stack into the test binary.
    pub fn prepare(
        &self,
        chat_id: &str,
        dir: &Path,
        tools: Vec<Value>,
        remembered: Option<String>,
    ) {
        if let Some(text) = remembered {
            // The same pinned picture the chat agent gets, so the agent knows
            // what the user already told Hook about themselves.
            let text = format!(
                "## What Hook remembers about the user\n{text}\nUse `memory_search` for the rest and `remember` for something durable they tell you. Never store a secret.\n"
            );
            let _ = fs::write(dir.join("memory.txt"), text);
        }
        if tools.is_empty() {
            return;
        }
        let names: Vec<String> = tools
            .iter()
            .filter_map(|tool| tool["function"]["name"].as_str().map(str::to_string))
            .collect();
        let Some(port) = lock(&self.inner).port else {
            return;
        };

        let token = format!("tk_{}", uuid::Uuid::new_v4().simple());
        {
            let mut inner = lock(&self.inner);
            if let Some(previous) = inner.by_chat.insert(chat_id.to_string(), token.clone()) {
                inner.tokens.remove(&previous);
            }
            inner.tokens.insert(
                token.clone(),
                Grant {
                    chat_id: chat_id.to_string(),
                    tools: names,
                },
            );
        }

        let payload = json!({
            "url": format!("http://127.0.0.1:{port}/tool"),
            "token": token,
            "tools": tools,
        });
        if let Err(error) = fs::write(dir.join("tools.json"), payload.to_string()) {
            eprintln!("hook: could not write the coding agent's tool list: {error}");
        }
    }

    /// Drop the token of a chat whose run is over. The next start mints a new
    /// one, so a token never outlives the process it was written for by more
    /// than one run.
    pub fn release(&self, chat_id: &str) {
        let mut inner = lock(&self.inner);
        if let Some(token) = inner.by_chat.remove(chat_id) {
            inner.tokens.remove(&token);
        }
    }

    fn grant(&self, token: &str) -> Option<Grant> {
        lock(&self.inner).tokens.get(token).cloned()
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    bridge: Arc<ToolBridge>,
) -> std::io::Result<()> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    // Read the head, then exactly as much body as it announces.
    let mut head = Vec::with_capacity(1024);
    let mut chunk = [0u8; 2048];
    loop {
        if head.len() > MAX_HEADER_BYTES {
            return refuse(&mut stream, 431, "Request head is too large.").await;
        }
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            return Ok(());
        }
        head.extend_from_slice(&chunk[..read]);
        if head.windows(4).any(|window| window == b"\r\n\r\n") {
            break;
        }
    }
    let split = head
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .map(|at| at + 4)
        .unwrap_or(head.len());
    let text = String::from_utf8_lossy(&head[..split]).to_string();
    let mut lines = text.lines();
    let mut request = lines.next().unwrap_or("").split_whitespace();
    let method = request.next().unwrap_or("");
    let target = request.next().unwrap_or("/");

    if method != "POST" || target.split(['?', '#']).next() != Some("/tool") {
        return refuse(&mut stream, 404, "Not found.").await;
    }

    let mut token = String::new();
    let mut length = 0usize;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key.trim().to_ascii_lowercase().as_str() {
            "x-hook-token" => token = value.to_string(),
            "content-length" => length = value.parse::<usize>().unwrap_or(0),
            _ => {}
        }
    }
    if token.is_empty() {
        return refuse(&mut stream, 403, "Missing token.").await;
    }
    let Some(grant) = bridge.grant(&token) else {
        return refuse(&mut stream, 403, "Unknown token.").await;
    };
    if length == 0 || length > MAX_REQUEST_BYTES {
        return refuse(&mut stream, 413, "The tool call has an unusable size.").await;
    }

    let mut body = head[split..].to_vec();
    body.truncate(length);
    while body.len() < length {
        let read = stream.read(&mut chunk).await?;
        if read == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..read]);
    }
    if body.len() != length {
        return refuse(&mut stream, 400, "The tool call body was cut short.").await;
    }

    let Ok(call) = serde_json::from_slice::<Value>(&body) else {
        return refuse(&mut stream, 400, "The tool call is not JSON.").await;
    };
    let name = call
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if !grant.tools.iter().any(|tool| tool == &name) {
        return refuse(&mut stream, 403, "That tool was not offered here.").await;
    }
    let args = call.get("args").cloned().unwrap_or(Value::Null);

    let Some(state) = lock(&bridge.state).upgrade() else {
        return refuse(&mut stream, 503, "Hook is not running.").await;
    };
    let result = dispatch(state, grant.chat_id, name, args).await;

    let head = format!(
        "HTTP/1.1 200 OK\r\n\
         Content-Type: text/plain; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\r\n",
        result.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(result.as_bytes()).await?;
    Ok(())
}

async fn refuse(stream: &mut tokio::net::TcpStream, status: u16, message: &str) -> std::io::Result<()> {
    use tokio::io::AsyncWriteExt;

    let reason = match status {
        400 => "Bad Request",
        403 => "Forbidden",
        404 => "Not Found",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        _ => "Service Unavailable",
    };
    let body = json!({ "error": message }).to_string();
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).await?;
    stream.write_all(body.as_bytes()).await?;
    Ok(())
}

/// Run one tool call for one chat and return the JSON text the model reads.
///
/// Workspace tools are `async` (they go over the account API); everything else
/// is blocking file work, kept off the reactor.
async fn dispatch(state: Arc<AppState>, chat_id: String, name: String, args: Value) -> String {
    if crate::workspace::handles(&name) {
        return crate::workspace::execute(&state.workspace, &chat_id, &name, &args).await;
    }
    let result = tauri::async_runtime::spawn_blocking(move || {
        if crate::memory::handles(&name) {
            return crate::memory::execute(&state.memory, &name, &args, &chat_id);
        }
        let env = crate::tools::ToolEnv {
            agents: &state.agents,
            projects: &state.projects,
            settings: &state.settings,
            chat_id: &chat_id,
            // The user typed the message that led here; a coding agent talking
            // to them directly is never woken by a note.
            user_initiated: true,
        };
        crate::tools::execute(&env, &name, &args)
    })
    .await;
    match result {
        Ok(text) => text,
        Err(error) => json!({ "error": format!("That tool did not finish: {error}") }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_token_only_grants_what_was_offered_and_dies_with_its_chat() {
        let bridge = ToolBridge::new();
        {
            let mut inner = lock(&bridge.inner);
            inner.by_chat.insert("c1".into(), "tk_demo".into());
            inner.tokens.insert(
                "tk_demo".into(),
                Grant {
                    chat_id: "c1".into(),
                    tools: vec!["memory_search".into()],
                },
            );
        }
        let grant = bridge.grant("tk_demo").expect("grant");
        assert_eq!(grant.chat_id, "c1");
        assert!(grant.tools.iter().any(|tool| tool == "memory_search"));
        assert!(bridge.grant("tk_other").is_none());

        bridge.release("c1");
        assert!(bridge.grant("tk_demo").is_none());
    }
}
