//! Reading a browser tab, from wherever the question was asked.
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
//! (`GET /browser/tasks`), reads the page in its own process, and answers
//! (`POST /browser/tasks/<id>`). That is the whole protocol, and it is why a
//! read works whether the question came from the dock, the app, or a phone.
//!
//! What travels is the page's *text*, and only when a tool asked for it: the
//! message a browser sends carries the address, the title and the highlight,
//! never the page. A model that received a page with every message would spend
//! the conversation's budget on pages nobody asked about — and the text would
//! be in the history and the sync payload forever.

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

        match tokio::time::timeout(ANSWER_WAIT, receiver).await {
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
}

impl Op {
    pub fn parse(method: &str) -> Option<Op> {
        match method {
            "list_tabs" | "browser.tabs" => Some(Op::Tabs),
            "read_page" | "browser.read" => Some(Op::Read),
            "find_in_page" | "browser.find" => Some(Op::Find),
            _ => None,
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
                Op::Tabs => unreachable!(),
            }
        }
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
        assert_eq!(Op::parse("start_coding_agent"), None);
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
