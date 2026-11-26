//! Reading a browser tab — and, through the DevTools protocol, doing something
//! to it — from wherever the question was asked.
//!
//! A page lives in a browser, and a browser lives on one machine. Any chat on
//! the account may ask for one: the phone names a desktop, a desktop names
//! itself, and the machine that actually has the browser answers. That rail is
//! the relay (`remote.rs::handle`), the same one the coding agents use, because
//! a browser is a thing a machine has, not a thing a chat has.
//!
//! The half in this file is the machine's side of it. The browser is a *client*
//! of the channel (`channel.rs`), so the host cannot reach into it; what it can
//! do is leave a task in a queue and wait. The browser asks for work
//! (`GET /browser/tasks`), runs it in its own process, and answers
//! (`POST /browser/tasks/<id>`). That is the whole protocol, and it is why a
//! read works whether the question came from the dock, the app, or a phone.
//!
//! What travels with a message is the page's *identity* — address, title, the
//! highlight — and never the page: a model that received every page would spend
//! the conversation's budget on pages nobody asked about, and the text would be
//! in the history and the sync payload forever. A tool asks for the part it
//! wants and gets it as a slice.
//!
//! Two of those tools are not slices at all. `run_js` evaluates a script the
//! model wrote, with [`AGENT_RUNTIME`] installed in the page so that a handful
//! of lines does something useful; `browser_cdp` sends one raw DevTools protocol
//! command. They are the seam the rest of the tool set can be built on, which is
//! why a new capability is a change here and not a change in Chromium.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::state::{lock, AppState};

/// How much of a page the browser sends back in one read. A long documentation
/// page fits; a feed does not, which is what `offset` is for.
pub const MAX_PAGE_CHARS: usize = 200_000;

/// How much of it one tool call shows the model unless it asks for more, and
/// the most it may ask for. A page is paged, not pasted.
pub const SLICE_CHARS: usize = 8_000;
pub const MAX_SLICE_CHARS: usize = 40_000;

/// How many hits a search reports, and how many it looks at to say how many
/// there were.
const MAX_HITS: usize = 10;
const COUNTED_HITS: usize = 50;

/// How long a tool waits for a browser. Long enough for a big page to be read,
/// short enough that a closed browser fails the tool instead of hanging a turn.
const ANSWER_WAIT: Duration = Duration::from_secs(20);

/// How long a protocol call may take. A script the model wrote can wait on the
/// page's own network. Everything here is kept under the relay's 60-second RPC
/// budget (`server/relay.mjs`, RPC_TIMEOUT_MS) so a controller on another machine
/// gets the browser's answer rather than a timeout from the server.
const CDP_WAIT: Duration = Duration::from_secs(50);

/// The budget a script gets when it does not ask for one, and the most it may
/// ask for. The protocol's own timeout is what actually stops a runaway loop.
const EVAL_BUDGET_MS: u64 = 20_000;
const EVAL_MAX_MS: u64 = 40_000;

/// A script is written by hand in a tool call: long enough for a real query,
/// short enough that the request stays a message and not a file.
const MAX_JS_CHARS: usize = 12_000;

/// How much of a script's answer the model reads. A whole document is a file,
/// not a chat message.
const MAX_RESULT_CHARS: usize = 60_000;

/// How long a navigation waits for the page to say it has loaded. A page that
/// takes longer is answered as still loading, which is the truth and is the
/// model's next question rather than a reason to hold the call open.
const SETTLE_WAIT: Duration = Duration::from_secs(15);

/// How long after its last poll a browser still counts as attached. The poller
/// asks every few seconds; this is what "it is running" means to a tool.
const ATTACHED_FOR: Duration = Duration::from_secs(12);

struct Queued {
    id: String,
    task: Value,
}

#[derive(Default)]
struct Inner {
    queue: VecDeque<Queued>,
    /// Tools waiting on an answer, by task id.
    waiting: HashMap<String, tokio::sync::oneshot::Sender<Value>>,
    last_poll: Option<Instant>,
}

///
/// The queue a browser polls, and the tools that wait on it.
#[derive(Default)]
pub struct BrowserTasks {
    inner: Mutex<Inner>,
    next_id: AtomicU64,
    wake: tokio::sync::Notify,
}

impl BrowserTasks {
    pub fn new() -> Self {
        Self::default()
    }

    /// Leaves a task for the browser and waits for its answer. The reply is the
    /// browser's own JSON: `{"ok": true, ...}` or `{"ok": false, "error": "…"}`.
    pub async fn ask(&self, op: Value) -> Result<Value, String> {
        self.ask_with(op, ANSWER_WAIT).await
    }

    /// `ask`, with a budget of its own: reading a page is quick, and a script
    /// the model wrote is not.
    pub async fn ask_with(&self, op: Value, wait: Duration) -> Result<Value, String> {
        let id = format!("page{}", self.next_id.fetch_add(1, Ordering::Relaxed) + 1);
        let mut task = op;
        if let Some(object) = task.as_object_mut() {
            object.insert("id".into(), json!(id));
        }
        let (sender, receiver) = tokio::sync::oneshot::channel();
        {
            let mut inner = lock(&self.inner);
            inner.waiting.insert(id.clone(), sender);
            inner.queue.push_back(Queued {
                id: id.clone(),
                task,
            });
        }
        self.wake.notify_one();

        match tokio::time::timeout(wait, receiver).await {
            Ok(Ok(answer)) => Ok(answer),
            Ok(Err(_)) => Err("The browser dropped that request.".into()),
            Err(_) => {
                self.forget(&id);
                Err(if self.attached() {
                    "Hook Browser did not answer in time. Try again, or check that its window is not frozen.".into()
                } else {
                    "Hook Browser is not running on that machine.".into()
                })
            }
        }
    }

    /// The next task for the browser, or none. Called by the poll route, which
    /// is also what tells us a browser is alive: an idle poll is the heartbeat.
    pub fn next(&self) -> Option<Value> {
        let mut inner = lock(&self.inner);
        inner.last_poll = Some(Instant::now());
        inner.queue.pop_front().map(|row| row.task)
    }

    /// `next`, held open for up to `wait` so an idle browser is one request per
    /// `wait` instead of a busy loop. A task enqueued meanwhile wakes it.
    pub async fn next_waiting(&self, wait: Duration) -> Option<Value> {
        let deadline = Instant::now() + wait;
        loop {
            if let Some(task) = self.next() {
                return Some(task);
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return None;
            }
            // A notify that lands between the pop and this call is kept by the
            // permit, so the wait cannot miss a task that just arrived.
            let _ = tokio::time::timeout(left, self.wake.notified()).await;
        }
    }

    /// The browser's answer to one task. An unknown id is a browser answering a
    /// request that already timed out, which is not an error worth logging.
    pub fn answer(&self, id: &str, body: Value) {
        if let Some(sender) = lock(&self.inner).waiting.remove(id) {
            let _ = sender.send(body);
        }
    }

    /// Whether a browser has polled recently.
    pub fn attached(&self) -> bool {
        lock(&self.inner)
            .last_poll
            .map(|at| at.elapsed() < ATTACHED_FOR)
            .unwrap_or(false)
    }

    fn forget(&self, id: &str) {
        let mut inner = lock(&self.inner);
        inner.waiting.remove(id);
        inner.queue.retain(|row| row.id != id);
    }
}

/// What a tool asks the browser for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Op {
    Tabs,
    Read,
    Find,
    /// A script the model wrote, run with [`AGENT_RUNTIME`] installed.
    Eval,
    /// One raw DevTools protocol command.
    Cdp,
    /// A new foreground tab, beside the one the call names.
    OpenTab,
    CloseTab,
    /// Select a tab and bring its window forward.
    FocusTab,
    Navigate,
}

impl Op {
    pub fn parse(method: &str) -> Option<Op> {
        match method {
            "list_tabs" | "browser.tabs" => Some(Op::Tabs),
            "read_page" | "browser.read" => Some(Op::Read),
            "find_in_page" | "browser.find" => Some(Op::Find),
            "run_js" | "browser.eval" => Some(Op::Eval),
            "browser_cdp" | "browser.cdp" => Some(Op::Cdp),
            "open_tab" | "browser.open" => Some(Op::OpenTab),
            "close_tab" | "browser.close" => Some(Op::CloseTab),
            "switch_tab" | "browser.focus" => Some(Op::FocusTab),
            "navigate" | "browser.navigate" => Some(Op::Navigate),
            _ => None,
        }
    }

    /// The relay method a controller asks for this op. One name per op, so a
    /// phone and the dock cannot disagree about what they are asking for.
    pub fn method(self) -> &'static str {
        match self {
            Op::Tabs => "browser.tabs",
            Op::Read => "browser.read",
            Op::Find => "browser.find",
            Op::Eval => "browser.eval",
            Op::Cdp => "browser.cdp",
            Op::OpenTab => "browser.open",
            Op::CloseTab => "browser.close",
            Op::FocusTab => "browser.focus",
            Op::Navigate => "browser.navigate",
        }
    }

    /// How long this op gets. A page read is milliseconds; a script the model
    /// wrote may wait on the page's own network. A controller on another machine
    /// uses this to decide how long to hold its own request open.
    pub fn budget(self) -> Duration {
        match self {
            Op::Tabs | Op::Read | Op::Find | Op::CloseTab | Op::FocusTab => ANSWER_WAIT,
            Op::Eval | Op::Cdp | Op::OpenTab | Op::Navigate => CDP_WAIT,
        }
    }
}

/// One tab, as the model sees it: a number it can pass back, never a handle.
fn tab_row(row: &Value) -> Value {
    json!({
        "tab": row.get("tab").cloned().unwrap_or(Value::Null),
        "title": row.get("title").cloned().unwrap_or(Value::Null),
        "url": row.get("url").cloned().unwrap_or(Value::Null),
        "active": row.get("active").cloned().unwrap_or(json!(false)),
    })
}

/// Runs a page tool on the machine that has the browser. Shared by the local
/// path in `tools.rs` and the relay path in `remote.rs`, so a phone and the dock
/// ask the same questions and get the same answers.
pub async fn perform(state: &AppState, op: Op, params: &Value) -> Result<Value, String> {
    if !state.capabilities.browser {
        return Err(
            "Hook Browser is not running in this process. Name a machine that has it."
                .to_string(),
        );
    }

    match op {
        Op::Tabs => {
            let answer = state.browser.ask(json!({ "op": "tabs" })).await?;
            if answer.get("ok").and_then(Value::as_bool) != Some(true) {
                return Err(say(&answer, "The browser could not list its tabs."));
            }
            let rows: Vec<Value> = answer
                .get("tabs")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().map(tab_row).collect())
                .unwrap_or_default();
            let named = params.get("tab").and_then(Value::as_u64).filter(|n| *n > 0);
            if let Some(tab) = named {
                let row = rows
                    .iter()
                    .find(|row| row.get("tab").and_then(Value::as_u64) == Some(tab))
                    .cloned()
                    .ok_or_else(|| {
                        format!("There is no tab {tab}. The browser has {} open.", rows.len())
                    })?;
                let mut out = row;
                if let Some(selection) = answer.get("selection").and_then(Value::as_str) {
                    if out.get("active").and_then(Value::as_bool) == Some(true) {
                        out["selection"] = json!(selection);
                    }
                }
                return Ok(out);
            }
            if rows.is_empty() {
                return Ok(json!({
                    "tabs": [],
                    "message": "The browser has no tabs open.",
                }));
            }
            let active = rows
                .iter()
                .find(|row| row.get("active").and_then(Value::as_bool) == Some(true))
                .and_then(|row| row.get("tab").cloned());
            Ok(json!({
                "tabs": rows,
                "count": rows.len(),
                "active": active,
                "hint": "read_page reads one of these by number; find_in_page looks for words in one.",
            }))
        }
        Op::Read | Op::Find => {
            let tab = params
                .get("tab")
                .and_then(Value::as_u64)
                .filter(|n| *n > 0)
                .ok_or("Name the tab to read, by number from list_tabs.")?;
            let answer = read(state, tab).await?;
            match op {
                Op::Read => Ok(slice_answer(&answer, tab, params)),
                Op::Find => {
                    let query = params
                        .get("query")
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|q| !q.is_empty())
                        .ok_or("Search for what? Pass the words to look for.")?;
                    let pattern = params
                        .get("regex")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let text = answer.get("text").and_then(Value::as_str).unwrap_or("");
                    find_answer(&answer, tab, text, query, pattern)
                }
                _ => unreachable!(),
            }
        }
        Op::Eval => eval(state, params).await,
        Op::Cdp => cdp(state, params).await,
        Op::OpenTab => open_tab(state, params).await,
        Op::CloseTab => close_tab(state, params).await,
        Op::FocusTab => focus_tab(state, params).await,
        Op::Navigate => navigate(state, params).await,
    }
}

/// The browser's words for why it could not answer.
fn say(answer: &Value, fallback: &str) -> String {
    answer
        .get("error")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|error| !error.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| fallback.to_string())
}

/// Reads one tab's text. No cache on purpose: the page may have changed since
/// the last call (that is usually why the model is asking again), and an
/// extraction costs a few milliseconds, not a round trip to a server.
async fn read(state: &AppState, tab: u64) -> Result<Value, String> {
    let answer = state
        .browser
        .ask(json!({ "op": "read", "tab": tab, "chars": MAX_PAGE_CHARS }))
        .await?;
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(say(&answer, "That page could not be read."));
    }
    Ok(answer)
}

fn slice_answer(answer: &Value, tab: u64, params: &Value) -> Value {
    let text = answer.get("text").and_then(Value::as_str).unwrap_or("");
    let total = text.chars().count();
    let offset = params
        .get("offset")
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize;
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(SLICE_CHARS)
        .clamp(1, MAX_SLICE_CHARS);
    let offset = offset.min(total);
    let slice: String = text.chars().skip(offset).take(limit).collect();
    let end = offset + slice.chars().count();
    json!({
        "tab": tab,
        "title": answer.get("title").cloned().unwrap_or(Value::Null),
        "url": answer.get("url").cloned().unwrap_or(Value::Null),
        "total": total,
        "offset": offset,
        "length": end - offset,
        "text": slice,
        "headings": answer.get("headings").cloned().unwrap_or(json!([])),
        "truncated": answer.get("truncated").cloned().unwrap_or(json!(false)),
        // The model can page without doing arithmetic, and a page that fits
        // says so by leaving this out.
        "next": if end < total { json!(end) } else { Value::Null },
    })
}

fn find_answer(answer: &Value, tab: u64, text: &str, query: &str, pattern: bool) -> Result<Value, String> {
    let source = if pattern {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let compiled = regex::RegexBuilder::new(&source)
        .case_insensitive(true)
        .build()
        .map_err(|error| format!("“{query}” is not a valid pattern: {error}"))?;

    let mut hits = Vec::new();
    let mut total = 0usize;
    for found in compiled.find_iter(text) {
        total += 1;
        if hits.len() >= MAX_HITS || total > COUNTED_HITS {
            continue;
        }
        // Offsets are characters, because they are handed back to `read_page`'s
        // `offset` and to a person counting.
        let start = text[..found.start()].chars().count();
        let end = text[..found.end()].chars().count();
        let from = start.saturating_sub(150);
        let to = (end + 150).min(text.chars().count());
        let snippet: String = text.chars().skip(from).take(to - from).collect();
        hits.push(json!({
            "offset": start,
            "text": snippet.trim(),
        }));
    }

    Ok(json!({
        "tab": tab,
        "title": answer.get("title").cloned().unwrap_or(Value::Null),
        "url": answer.get("url").cloned().unwrap_or(Value::Null),
        "query": query,
        "regex": pattern,
        "total": total,
        "hits": hits,
        "message": if total == 0 {
            "No match on that page. Try a shorter word, or read it from the top."
        } else if total > hits.len() {
            "More matches than are shown; narrow the words or read around a hit's offset."
        } else {
            ""
        },
    }))
}

/// The helpers `run_js` installs into the page.
///
/// One file, embedded here, so the script a model writes is a handful of lines
/// against a documented object instead of a DOM recipe rebuilt every turn — and
/// so the recipes live somewhere they can be read, reviewed and changed without
/// a browser rebuild. It installs itself as `globalThis.__hook` once per
/// document; its element refs survive between calls, which is what makes
/// `__hook.snapshot()` followed by `__hook.click('e3')` work.
pub const AGENT_RUNTIME: &str = include_str!("../resources/browser-agent.js");

/// The version marker the runtime installs into `__hook.version`. A document
/// that already carries an older copy is upgraded in place; the unit test below
/// keeps this number and the file from drifting apart.
const RUNTIME_VERSION: u32 = 1;

/// The tab every page tool names: one numbering for a person, a model and a
/// tool call (`hook_tabs.h`), and the reason a read is keyed on a number.
fn tab_arg(params: &Value) -> Result<u64, String> {
    params
        .get("tab")
        .and_then(Value::as_u64)
        .filter(|number| *number > 0)
        .ok_or_else(|| "Name the tab to use, by number from list_tabs.".to_string())
}

/// What `run_js` actually evaluates: the helpers when this document has none,
/// then the model's code inside an async function, so `await` and `return` both
/// work and the protocol waits for the promise.
fn eval_expression(code: &str) -> String {
    format!(
        "(function () {{\n\
         if (!globalThis.__hook ||\n\
             globalThis.__hook.version !== {RUNTIME_VERSION}) {{\n\
         {AGENT_RUNTIME}\n\
         }}\n\
         return (async () => {{\n\
         {code}\n\
         }})();\n\
         }})()"
    )
}

/// `run_js`: the page's own JavaScript, with the helpers installed.
async fn eval(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    let code = params
        .get("code")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|code| !code.is_empty())
        .ok_or("Pass the JavaScript to run in `code`.")?;
    let chars = code.chars().count();
    if chars > MAX_JS_CHARS {
        return Err(format!(
            "That script is {chars} characters; the limit is {MAX_JS_CHARS}. Send the part you need, and use read_page for the rest of the page."
        ));
    }
    let budget = params
        .get("timeout_ms")
        .and_then(Value::as_u64)
        .unwrap_or(EVAL_BUDGET_MS)
        .clamp(1_000, EVAL_MAX_MS);

    let answer = cdp_call(
        state,
        tab,
        "Runtime.evaluate",
        json!({
            "expression": eval_expression(code),
            "awaitPromise": true,
            "returnByValue": true,
            // Scripts act on the page: a click, a clipboard write or a popup
            // only works when the browser counts the call as the user's.
            "userGesture": true,
            // The protocol stops a loop that never ends; the host's own wait is
            // only the backstop for a tab that stops answering entirely.
            "timeout": budget,
        }),
        Op::Eval.budget(),
    )
    .await
    .map_err(|error| {
        if error.contains("did not answer") {
            format!(
                "{error} A script that navigates the page, or one that never finishes, is the usual reason."
            )
        } else {
            error
        }
    })?;
    shape_eval(answer)
}

/// `browser_cdp`: one raw protocol command, for the corners the tools above do
/// not cover (pixels, emulation, downloads, trusted input events).
async fn cdp(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    let method = params
        .get("method")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|method| !method.is_empty())
        .ok_or("Name the DevTools protocol method, like `Page.captureScreenshot`.")?;
    let given = params
        .get("params")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !given.is_object() {
        return Err("`params` has to be an object of protocol parameters.".to_string());
    }
    let result = cdp_call(state, tab, method, given, Op::Cdp.budget()).await?;
    Ok(shape_cdp(result))
}

/// `open_tab`: a new foreground tab, beside the one the call names.
///
/// The browser creates it through the protocol's own `Target.createTarget`,
/// which is the same thing the browser's "+" button does and the only way to
/// open one from here without the overlay reaching into //chrome/browser. Its
/// number is the strip's, so the answer waits for the strip to show it: the new
/// tab is the selected one, and it carries the address that was asked for.
async fn open_tab(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let created = cdp_call(
        state,
        tab,
        "Target.createTarget",
        json!({ "url": url, "background": false, "newWindow": false }),
        Op::OpenTab.budget(),
    )
    .await?;
    let target = created
        .get("targetId")
        .and_then(Value::as_str)
        .unwrap_or("");
    match opened_tab(state, url).await {
        Some(row) => Ok(json!({
            "tab": row.get("tab").cloned().unwrap_or(Value::Null),
            "title": row.get("title").cloned().unwrap_or(Value::Null),
            "url": row.get("url").cloned().unwrap_or(Value::Null),
            "active": true,
            "target": target,
        })),
        None => Ok(json!({
            "target": target,
            "opened": url,
            "note": "The tab is open. list_tabs shows the number it was given if this answer arrived before the strip drew it.",
        })),
    }
}

/// The row of the tab that was just opened, once the strip has drawn it.
async fn opened_tab(state: &AppState, url: &str) -> Option<Value> {
    for _ in 0..20 {
        if let Ok(answer) = state.browser.ask(json!({ "op": "tabs" })).await {
            if let Some(rows) = answer.get("tabs").and_then(Value::as_array) {
                let found = rows.iter().find(|row| {
                    row.get("active").and_then(Value::as_bool) == Some(true)
                        && same_page(row.get("url").and_then(Value::as_str).unwrap_or(""), url)
                });
                if let Some(row) = found {
                    return Some(row.clone());
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    None
}

/// Whether a just-opened tab is already showing `wanted`. A tab that has not
/// committed yet reports its address as empty or `about:blank`, and that is still
/// the new tab: it is the selected one.
fn same_page(found: &str, wanted: &str) -> bool {
    let found = found.trim();
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return found.is_empty() || found == "about:blank";
    }
    if found.is_empty() || found == "about:blank" {
        return true;
    }
    found == wanted || found.starts_with(wanted)
}

/// `switch_tab`: select a tab and bring its window to the front.
async fn focus_tab(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    cdp_call(
        state,
        tab,
        "Page.bringToFront",
        json!({}),
        Op::FocusTab.budget(),
    )
    .await?;
    Ok(json!({ "tab": tab, "active": true }))
}

/// `close_tab`: close one. A link that opened a second tab is not a reason to
/// leave it behind.
async fn close_tab(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    cdp_call(state, tab, "Page.close", json!({}), Op::CloseTab.budget()).await?;
    Ok(json!({
        "closed": tab,
        "note": "The strip has renumbered: list_tabs is the current numbering.",
    }))
}

/// `navigate`: send a tab somewhere and wait for it to arrive.
async fn navigate(state: &AppState, params: &Value) -> Result<Value, String> {
    let tab = tab_arg(params)?;
    let url = params
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .ok_or("Pass the address to open in `url`.")?;
    cdp_call(
        state,
        tab,
        "Page.navigate",
        json!({ "url": url }),
        Op::Navigate.budget(),
    )
    .await?;
    settle(state, tab).await
}

/// Waits for a tab to finish loading and answers where it landed.
///
/// A navigation destroys the page's execution context, so a probe that fails is a
/// step of the loop and not an error.
async fn settle(state: &AppState, tab: u64) -> Result<Value, String> {
    let deadline = Instant::now() + SETTLE_WAIT;
    let mut last = json!({});
    loop {
        if let Ok(value) = probe(state, tab).await {
            if value.get("ready").and_then(Value::as_str) == Some("complete") {
                return Ok(value);
            }
            last = value;
        }
        if Instant::now() >= deadline {
            let mut answer = last;
            if let Some(object) = answer.as_object_mut() {
                object.insert(
                    "note".into(),
                    json!(
                        "Still loading after a few seconds. run_js with __hook.waitFor('sel:…') is how to wait for the rest."
                    ),
                );
            }
            return Ok(answer);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
}

/// One plain protocol question about the page: where it is, and whether it is
/// ready. No helpers are installed and no promise is awaited, so this still
/// answers while a document is being replaced.
async fn probe(state: &AppState, tab: u64) -> Result<Value, String> {
    let answer = cdp_call(
        state,
        tab,
        "Runtime.evaluate",
        json!({
            "expression": "({ ready: document.readyState, url: location.href, title: document.title })",
            "returnByValue": true,
        }),
        // Short on purpose: a probe that hangs must not eat the settle budget.
        Duration::from_secs(5),
    )
    .await?;
    if answer.get("exceptionDetails").is_some() {
        return Err("That page could not be read yet.".to_string());
    }
    Ok(answer
        .get("result")
        .and_then(|remote| remote.get("value"))
        .cloned()
        .unwrap_or_else(|| json!({})))
}

/// One protocol command through the queue, answered with its `result` object.
async fn cdp_call(
    state: &AppState,
    tab: u64,
    method: &str,
    params: Value,
    wait: Duration,
) -> Result<Value, String> {
    let answer = state
        .browser
        .ask_with(
            json!({ "op": "cdp", "tab": tab, "method": method, "params": params }),
            wait,
        )
        .await?;
    if answer.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(say(&answer, "The browser could not run that request."));
    }
    Ok(answer.get("result").cloned().unwrap_or_else(|| json!({})))
}

/// What a script's answer looks like to the model.
fn shape_eval(answer: Value) -> Result<Value, String> {
    if let Some(exception) = answer.get("exceptionDetails") {
        return Err(describe_exception(exception));
    }
    let remote = answer.get("result").cloned().unwrap_or_else(|| json!({}));
    let kind = remote
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let value = match remote.get("value") {
        Some(value) => value.clone(),
        // A node, a function or a promise has no JSON value: the protocol sends
        // a one-line description instead, which is the useful half.
        None => remote
            .get("description")
            .or_else(|| remote.get("unserializableValue"))
            .cloned()
            .unwrap_or(Value::Null),
    };
    Ok(json!({ "type": kind, "value": capped(value) }))
}

/// A thrown script is an error the model can fix, not a failed tool call with no
/// explanation.
fn describe_exception(details: &Value) -> String {
    let text = details
        .get("exception")
        .and_then(|exception| exception.get("description"))
        .and_then(Value::as_str)
        .filter(|text| !text.trim().is_empty())
        .or_else(|| details.get("text").and_then(Value::as_str))
        .map(str::to_string);
    match text {
        Some(text) => text,
        None => "The script threw and the page gave no reason. A navigation, or a syntax error, ends a call like this.".to_string(),
    }
}

/// What a protocol result looks like to the model.
///
/// A screenshot or a PDF arrives as a base64 string of megabytes. Handing the
/// model the first 60,000 characters of it is worse than saying no: it cannot
/// look at the picture and cannot do anything with half of one. The field is
/// dropped and the answer says so, which is a sentence it can act on.
fn shape_cdp(mut result: Value) -> Value {
    let mut omitted = None;
    if let Some(object) = result.as_object() {
        for key in ["data", "screenshot"] {
            if let Some(text) = object.get(key).and_then(Value::as_str) {
                let characters = text.chars().count();
                if characters > MAX_RESULT_CHARS {
                    omitted = Some(characters);
                }
            }
        }
    }
    if let Some(characters) = omitted {
        if let Some(object) = result.as_object_mut() {
            object.remove("data");
            object.remove("screenshot");
            object.insert(
                "omitted".into(),
                json!({
                    "base64_characters": characters,
                    "note": "A picture or a document, which one answer cannot carry. Capture a smaller region, or read the page with run_js instead.",
                }),
            );
        }
    }
    result
}

/// A script can return a document. The model reads a bounded answer, because the
/// rest of it is a file, not a message.
fn capped(value: Value) -> Value {
    let text = value.to_string();
    let characters = text.chars().count();
    if characters <= MAX_RESULT_CHARS {
        return value;
    }
    let preview: String = text.chars().take(MAX_RESULT_CHARS).collect();
    json!({
        "truncated": true,
        "characters": characters,
        "preview": preview,
        "note": "The value was larger than one answer. Return less from the script, or narrow the query.",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn page() -> Value {
        json!({
            "ok": true,
            "title": "Pricing — Example",
            "url": "https://example.com/pricing",
            "text": "Intro line.\n\nPro plan costs 20 dollars a month.\n\nEnterprise is custom.\n",
            "headings": [{ "level": 2, "text": "Pro" }],
            "truncated": false,
        })
    }

    #[test]
    fn a_read_is_a_slice_with_the_way_onward() {
        let answer = slice_answer(&page(), 2, &json!({ "offset": 0, "limit": 10 }));
        assert_eq!(answer["tab"], 2);
        assert_eq!(answer["text"], "Intro line");
        assert_eq!(answer["total"], 71);
        assert_eq!(answer["next"], 10);
        assert_eq!(answer["title"], "Pricing — Example");

        let middle = slice_answer(&page(), 2, &json!({ "offset": 60, "limit": 50 }));
        assert_eq!(middle["length"], 11);
        assert_eq!(middle["next"], Value::Null);
    }

    #[test]
    fn a_read_past_the_end_is_empty_rather_than_an_error() {
        let answer = slice_answer(&page(), 1, &json!({ "offset": 9999 }));
        assert_eq!(answer["text"], "");
        assert_eq!(answer["offset"], 71);
    }

    #[test]
    fn find_returns_offsets_and_a_snippet_around_each_hit() {
        let text = page()["text"].as_str().unwrap().to_string();
        let answer = find_answer(&page(), 1, &text, "pro", false).unwrap();
        assert_eq!(answer["total"], 1);
        assert_eq!(answer["hits"][0]["offset"], 13);
        assert!(answer["hits"][0]["text"].as_str().unwrap().contains("Pro plan"));

        let none = find_answer(&page(), 1, &text, "zebra", false).unwrap();
        assert_eq!(none["total"], 0);
        assert!(none["message"].as_str().unwrap().contains("No match"));
    }

    #[test]
    fn find_can_be_a_pattern() {
        let text = page()["text"].as_str().unwrap().to_string();
        let answer = find_answer(&page(), 1, &text, r"\d+ dollars", true).unwrap();
        assert_eq!(answer["total"], 1);
        assert_eq!(answer["regex"], true);

        let bad = find_answer(&page(), 1, &text, "([", true);
        assert!(bad.is_err());
    }

    #[test]
    fn a_task_carries_an_id_and_comes_back_to_its_caller() {
        let tasks = BrowserTasks::new();
        assert!(!tasks.attached());

        // A poll is the heartbeat even when there is nothing to do: an idle
        // browser is how a tool knows one is there before it asks for a page.
        assert!(tasks.next().is_none());
        assert!(tasks.attached());
    }

    #[test]
    fn op_names_are_the_tool_names_and_the_relay_methods() {
        assert_eq!(Op::parse("list_tabs"), Some(Op::Tabs));
        assert_eq!(Op::parse("browser.read"), Some(Op::Read));
        assert_eq!(Op::parse("find_in_page"), Some(Op::Find));
        assert_eq!(Op::parse("run_js"), Some(Op::Eval));
        assert_eq!(Op::parse("browser.cdp"), Some(Op::Cdp));
        assert_eq!(Op::parse("open_tab"), Some(Op::OpenTab));
        assert_eq!(Op::parse("browser.navigate"), Some(Op::Navigate));
        assert_eq!(Op::parse("start_coding_agent"), None);
    }

    #[test]
    fn every_op_has_one_relay_name_and_the_relay_name_parses_back() {
        for op in [
            Op::Tabs,
            Op::Read,
            Op::Find,
            Op::Eval,
            Op::Cdp,
            Op::OpenTab,
            Op::CloseTab,
            Op::FocusTab,
            Op::Navigate,
        ] {
            assert_eq!(Op::parse(op.method()), Some(op));
        }
    }

    #[test]
    fn a_just_opened_tab_is_the_selected_one_at_the_address_it_was_given() {
        assert!(same_page("https://example.com/pricing", "https://example.com/pricing"));
        assert!(same_page("https://example.com/pricing#top", "https://example.com/pricing"));
        // Still starting: the address is not committed yet, and the tab is the
        // selected one either way.
        assert!(same_page("", "https://example.com"));
        assert!(same_page("about:blank", "https://example.com"));
        assert!(same_page("about:blank", ""));
        // Somebody else's page is not it.
        assert!(!same_page("https://other.example", "https://example.com"));
        assert!(!same_page("https://example.com", "https://example.com/pricing"));
    }

    #[test]
    fn a_script_is_wrapped_with_the_runtime_and_stays_awaitable() {
        let expression = eval_expression("return await __hook.text('h1');");
        assert!(expression.contains("return await __hook.text('h1');"));
        assert!(expression.contains("globalThis.__hook"));
        assert!(expression.contains("async ()"));
        // The whole runtime travels with the call, so a page that just
        // navigated has the helpers the moment the first script runs.
        assert!(expression.contains(AGENT_RUNTIME));
        assert!(AGENT_RUNTIME.contains("snapshot"));
    }

    #[test]
    fn the_runtime_declares_the_version_this_file_checks() {
        // The wrapper installs the helpers only when the document's copy is a
        // different version; a marker that drifts would either reinstall on
        // every call or never upgrade an old copy.
        assert!(AGENT_RUNTIME.contains(&format!("version: {RUNTIME_VERSION},")));
    }

    #[test]
    fn a_script_answer_is_its_value_and_its_type() {
        let shaped = shape_eval(json!({
            "result": { "type": "object", "value": { "price": 20 } }
        }))
        .unwrap();
        assert_eq!(shaped["type"], "object");
        assert_eq!(shaped["value"]["price"], 20);

        // `undefined` has no value and no description: it is not an error.
        let shaped = shape_eval(json!({ "result": { "type": "undefined" } })).unwrap();
        assert_eq!(shaped["type"], "undefined");
        assert_eq!(shaped["value"], Value::Null);

        // A node is described, never serialized.
        let shaped = shape_eval(json!({
            "result": { "type": "object", "subtype": "node", "description": "h1.title" }
        }))
        .unwrap();
        assert_eq!(shaped["value"], "h1.title");
    }

    #[test]
    fn a_thrown_script_is_the_page_s_own_sentence() {
        let error = shape_eval(json!({
            "result": { "type": "object" },
            "exceptionDetails": {
                "text": "Uncaught",
                "exception": { "description": "TypeError: x is null\n    at <anonymous>:1:1" }
            }
        }))
        .unwrap_err();
        assert!(error.contains("TypeError: x is null"));
    }

    #[test]
    fn a_big_answer_becomes_a_preview_that_says_so() {
        let big = Value::String("x".repeat(MAX_RESULT_CHARS));
        let capped_value = capped(big);
        // A JSON string of N characters is N + 2 with its quotes.
        assert_eq!(capped_value["truncated"], true);
        assert_eq!(capped_value["characters"], MAX_RESULT_CHARS + 2);
        assert_eq!(
            capped_value["preview"].as_str().unwrap().chars().count(),
            MAX_RESULT_CHARS
        );

        // Small values are handed through untouched.
        assert_eq!(capped(json!({ "a": 1 })), json!({ "a": 1 }));
    }

    #[test]
    fn a_picture_arrives_as_a_sentence_and_not_as_base64() {
        let big = "A".repeat(MAX_RESULT_CHARS + 1);
        let shaped = shape_cdp(json!({ "data": big }));
        assert!(shaped.get("data").is_none());
        assert_eq!(shaped["omitted"]["base64_characters"], MAX_RESULT_CHARS + 1);

        // Everything else is handed through exactly as the protocol sent it.
        let small = shape_cdp(json!({ "result": { "value": 3 } }));
        assert_eq!(small, json!({ "result": { "value": 3 } }));
    }

    #[test]
    fn a_tab_is_numbered_from_one() {
        assert_eq!(tab_arg(&json!({ "tab": 2 })).unwrap(), 2);
        assert!(tab_arg(&json!({ "tab": 0 })).is_err());
        assert!(tab_arg(&json!({})).is_err());
    }

    #[tokio::test]
    async fn an_ask_is_answered_by_the_next_poll() {
        let tasks = std::sync::Arc::new(BrowserTasks::new());
        let asked = tasks.clone();
        let waiting = tokio::spawn(async move { asked.ask(json!({ "op": "tabs" })).await });

        let mut task = None;
        for _ in 0..50 {
            if let Some(found) = tasks.next() {
                task = Some(found);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let task = task.expect("the task reached the queue");
        let id = task["id"].as_str().unwrap().to_string();
        assert_eq!(task["op"], "tabs");
        tasks.answer(&id, json!({ "ok": true, "tabs": [] }));
        assert_eq!(waiting.await.unwrap().unwrap()["ok"], true);
    }
}
