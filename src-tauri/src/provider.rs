use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt;

use crate::config::HarnessConfig;
use crate::store::{ToolCallRecord, Usage};

/// Cooperative cancellation shared between the command layer and the stream loop.
#[derive(Clone)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<tokio::sync::Notify>,
}

impl CancelToken {
    pub fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(tokio::sync::Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        // `notify_one` stores a permit when nobody is waiting, so a cancel that
        // lands before the loop starts awaits is still observed.
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    async fn wait(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

pub enum Chunk {
    Text(String),
    Reasoning(String),
}

/// One finished assistant response, tool calls included.
pub struct Completion {
    pub text: String,
    pub reasoning: String,
    /// Field the reasoning streamed in, so it can be replayed verbatim.
    pub reasoning_field: Option<String>,
    pub tool_calls: Vec<ToolCallRecord>,
    pub usage: Option<Usage>,
}

pub enum Outcome {
    Completed(Completion),
    Cancelled,
}

/// Accumulates streamed `tool_calls` fragments by index.
#[derive(Default)]
struct ToolCallAccumulator {
    slots: Vec<(String, String, String)>,
}

impl ToolCallAccumulator {
    fn push(&mut self, value: &serde_json::Value) {
        let index = value
            .get("index")
            .and_then(|i| i.as_u64())
            .unwrap_or(0) as usize;
        while self.slots.len() <= index {
            self.slots.push((String::new(), String::new(), String::new()));
        }
        let slot = &mut self.slots[index];
        if let Some(id) = value.get("id").and_then(|v| v.as_str()) {
            if !id.is_empty() {
                slot.0 = id.to_string();
            }
        }
        if let Some(function) = value.get("function") {
            if let Some(name) = function.get("name").and_then(|v| v.as_str()) {
                if !name.is_empty() {
                    slot.1.push_str(name);
                }
            }
            if let Some(args) = function.get("arguments").and_then(|v| v.as_str()) {
                slot.2.push_str(args);
            }
        }
    }

    fn finish(self) -> Vec<ToolCallRecord> {
        self.slots
            .into_iter()
            .filter(|(_, name, _)| !name.is_empty())
            .map(|(id, name, arguments)| ToolCallRecord {
                id: if id.is_empty() {
                    format!("call_{}", uuid::Uuid::new_v4().simple())
                } else {
                    id
                },
                name,
                arguments,
            })
            .collect()
    }
}

pub async fn stream_chat<F>(
    cfg: &HarnessConfig,
    messages: &[serde_json::Value],
    tools: Option<&serde_json::Value>,
    cancel: CancelToken,
    mut on_chunk: F,
) -> Result<Outcome, String>
where
    F: FnMut(Chunk) + Send,
{
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut request = client
        .post(cfg.provider.endpoint())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .bearer_auth(&cfg.provider.api_key)
        .json(&build_body(cfg, messages, tools));

    for (name, value) in &cfg.provider.headers {
        request = request.header(name, value);
    }

    let response = request.send().await.map_err(|e| {
        if e.is_connect() {
            format!("Could not connect to {}. Check the endpoint in the build config.", cfg.provider.host())
        } else if e.is_timeout() {
            "The provider took too long to respond.".to_string()
        } else {
            format!("Request failed: {e}")
        }
    })?;

    let status = response.status();
    if !status.is_success() {
        let raw = response.text().await.unwrap_or_default();
        return Err(provider_error(status.as_u16(), &raw));
    }

    let is_sse = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.contains("event-stream"))
        .unwrap_or(true);

    if !is_sse {
        let raw = response.text().await.unwrap_or_default();
        let value: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| format!("Unexpected response: {}", truncate_for_error(&raw)))?;
        if let Some(err) = value.get("error") {
            return Err(error_text(err));
        }
        let content = value
            .pointer("/choices/0/message/content")
            .and_then(|c| c.as_str())
            .or_else(|| value.pointer("/choices/0/text").and_then(|c| c.as_str()))
            .unwrap_or_default();
        if !content.is_empty() {
            on_chunk(Chunk::Text(content.to_string()));
        }
        let usage = value.get("usage").filter(|u| !u.is_null()).map(parse_usage);
        let tool_calls = value
            .pointer("/choices/0/message/tool_calls")
            .and_then(|c| c.as_array())
            .map(|calls| {
                calls
                    .iter()
                    .filter_map(|call| {
                        let name = call.pointer("/function/name")?.as_str()?.to_string();
                        Some(ToolCallRecord {
                            id: call
                                .get("id")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                            name,
                            arguments: call
                                .pointer("/function/arguments")
                                .and_then(|v| v.as_str())
                                .unwrap_or_default()
                                .to_string(),
                        })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let reasoning_field = if value
            .pointer("/choices/0/message/reasoning_content")
            .and_then(|c| c.as_str())
            .map(|c| !c.is_empty())
            .unwrap_or(false)
        {
            Some("reasoning_content".to_string())
        } else {
            None
        };
        let reasoning = value
            .pointer("/choices/0/message/reasoning_content")
            .or_else(|| value.pointer("/choices/0/message/reasoning"))
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string();
        return Ok(Outcome::Completed(Completion {
            text: content.to_string(),
            reasoning,
            reasoning_field,
            tool_calls,
            usage,
        }));
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut usage: Option<Usage> = None;
    let mut text = String::new();
    let mut reasoning = String::new();
    let mut reasoning_field: Option<String> = None;
    let mut tool_calls = ToolCallAccumulator::default();

    'outer: loop {
        let next = tokio::select! {
            _ = cancel.wait() => return Ok(Outcome::Cancelled),
            next = stream.next() => next,
        };

        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| format!("Stream interrupted: {e}"))?;
        buffer.extend_from_slice(&chunk);

        while let Some(event) = take_sse_event(&mut buffer) {
            for line in event.lines() {
                let Some(data) = line.trim_start().strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim();
                if data.is_empty() {
                    continue;
                }
                if data == "[DONE]" {
                    break 'outer;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                    continue;
                };
                if let Some(err) = value.get("error").filter(|e| !e.is_null()) {
                    return Err(error_text(err));
                }
                if let Some(u) = value.get("usage").filter(|u| !u.is_null()) {
                    usage = Some(parse_usage(u));
                }
                let Some(choice) = value
                    .get("choices")
                    .and_then(|c| c.as_array())
                    .and_then(|c| c.first())
                else {
                    continue;
                };
                let Some(delta) = choice.get("delta") else {
                    continue;
                };
                if let Some(calls) = delta.get("tool_calls").and_then(|c| c.as_array()) {
                    for call in calls {
                        tool_calls.push(call);
                    }
                }
                // A single delta may carry visible text and reasoning at once,
                // so both are read independently.
                if let Some(part) = delta.get("content").and_then(|c| c.as_str()) {
                    if !part.is_empty() {
                        text.push_str(part);
                        on_chunk(Chunk::Text(part.to_string()));
                    }
                }
                let reasoning_part = delta
                    .get("reasoning_content")
                    .map(|value| ("reasoning_content", value))
                    .or_else(|| delta.get("reasoning").map(|value| ("reasoning", value)));
                if let Some((field, value)) = reasoning_part {
                    if let Some(piece) = value.as_str().filter(|piece| !piece.is_empty()) {
                        reasoning_field.get_or_insert_with(|| field.to_string());
                        reasoning.push_str(piece);
                        on_chunk(Chunk::Reasoning(piece.to_string()));
                    }
                }
            }
        }

        if cancel.is_cancelled() {
            return Ok(Outcome::Cancelled);
        }
    }

    Ok(Outcome::Completed(Completion {
        text,
        reasoning,
        reasoning_field,
        tool_calls: tool_calls.finish(),
        usage,
    }))
}

fn build_body(
    cfg: &HarnessConfig,
    messages: &[serde_json::Value],
    tools: Option<&serde_json::Value>,
) -> serde_json::Value {
    let mut body = serde_json::Map::new();
    body.insert("model".into(), serde_json::json!(cfg.model.name));
    body.insert("messages".into(), serde_json::json!(messages));
    body.insert("stream".into(), serde_json::json!(true));

    if let Some(tools) = tools.filter(|t| !t.as_array().map(|a| a.is_empty()).unwrap_or(true)) {
        body.insert("tools".into(), tools.clone());
        body.insert("tool_choice".into(), serde_json::json!("auto"));
    }

    if cfg.provider.stream_usage {
        body.insert(
            "stream_options".into(),
            serde_json::json!({ "include_usage": true }),
        );
    }

    if let Some(level) = cfg.model.thinking_level() {
        let key = cfg.provider.reasoning_param();
        if !key.eq_ignore_ascii_case("none") {
            body.insert(key.to_string(), serde_json::json!(level));
        }
    }

    if let Some(temperature) = cfg.model.temperature {
        body.insert("temperature".into(), serde_json::json!(temperature));
    }
    if let Some(max_tokens) = cfg.model.max_tokens {
        body.insert("max_tokens".into(), serde_json::json!(max_tokens));
    }
    for (key, value) in &cfg.provider.extra {
        body.insert(key.clone(), value.clone());
    }

    serde_json::Value::Object(body)
}

/// Pull one complete SSE frame out of the buffer, handling both LF and CRLF.
fn take_sse_event(buffer: &mut Vec<u8>) -> Option<String> {
    let mut i = 0;
    while i + 1 < buffer.len() {
        if buffer[i] == b'\n' && buffer[i + 1] == b'\n' {
            let event = String::from_utf8_lossy(&buffer[..i]).into_owned();
            buffer.drain(..i + 2);
            return Some(event);
        }
        if i + 3 < buffer.len() && &buffer[i..i + 4] == b"\r\n\r\n" {
            let event = String::from_utf8_lossy(&buffer[..i]).into_owned();
            buffer.drain(..i + 4);
            return Some(event);
        }
        i += 1;
    }
    None
}

fn parse_usage(value: &serde_json::Value) -> Usage {
    Usage {
        prompt_tokens: value
            .get("prompt_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
        completion_tokens: value
            .get("completion_tokens")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32,
    }
}

fn error_text(err: &serde_json::Value) -> String {
    if let Some(message) = err.get("message").and_then(|m| m.as_str()) {
        return message.to_string();
    }
    if let Some(message) = err.as_str() {
        return message.to_string();
    }
    truncate_for_error(&err.to_string())
}

fn provider_error(status: u16, raw: &str) -> String {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) {
        if let Some(err) = value.get("error") {
            return format!("{status} · {}", error_text(err));
        }
        if let Some(message) = value.get("message").and_then(|m| m.as_str()) {
            return format!("{status} · {message}");
        }
    }
    format!("{status} · {}", truncate_for_error(raw))
}

fn truncate_for_error(raw: &str) -> String {
    let clean = raw.trim().replace('\n', " ");
    if clean.is_empty() {
        return "Empty response".into();
    }
    crate::store::truncate(&clean, 320)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{HarnessConfig, ModelConfig, ProviderConfig};

    fn mock_config() -> HarnessConfig {
        HarnessConfig {
            provider: ProviderConfig {
                base_url: "http://127.0.0.1:8787/v1".to_string(),
                api_key: "test-key".to_string(),
                path: None,
                reasoning_param: None,
                stream_usage: true,
                tools: true,
                reasoning_echo: None,
                vision: false,
                headers: Default::default(),
                extra: Default::default(),
            },
            model: ModelConfig {
                name: "hook-mock-1".to_string(),
                thinking: Some("medium".to_string()),
                temperature: None,
                max_tokens: None,
            },
            coding: Default::default(),
            agent: Default::default(),
        }
    }

    fn messages() -> Vec<serde_json::Value> {
        vec![serde_json::json!({ "role": "user", "content": "hello" })]
    }

    #[test]
    fn endpoint_is_built_from_base_and_path() {
        let cfg = mock_config();
        assert_eq!(
            cfg.provider.endpoint(),
            "http://127.0.0.1:8787/v1/chat/completions"
        );
    }

    #[test]
    fn body_carries_thinking_level_and_usage_flag() {
        let cfg = mock_config();
        let body = build_body(&cfg, &messages(), None);
        assert_eq!(body["reasoning_effort"], "medium");
        assert_eq!(body["model"], "hook-mock-1");
        assert_eq!(body["stream"], true);
        assert_eq!(body["stream_options"]["include_usage"], true);
    }

    #[test]
    fn thinking_off_is_not_sent() {
        let mut cfg = mock_config();
        cfg.model.thinking = Some("off".to_string());
        let body = build_body(&cfg, &messages(), None);
        assert!(body.get("reasoning_effort").is_none());
    }

    #[test]
    fn sse_frames_split_on_lf_and_crlf() {
        let mut buffer = b"data: a\n\ndata: b\r\n\r\ndata: par".to_vec();
        assert_eq!(take_sse_event(&mut buffer).as_deref(), Some("data: a"));
        assert_eq!(take_sse_event(&mut buffer).as_deref(), Some("data: b"));
        assert_eq!(take_sse_event(&mut buffer), None);
        assert_eq!(buffer, b"data: par");
    }

    #[test]
    fn multi_byte_characters_survive_split_chunks() {
        // "🙂" is 4 bytes; the buffer must not be decoded until a frame is whole.
        let mut buffer: Vec<u8> = b"data: \xf0\x9f\x99".to_vec();
        assert_eq!(take_sse_event(&mut buffer), None);
        buffer.extend_from_slice(b"\x82\n\n");
        let frame = take_sse_event(&mut buffer).unwrap();
        assert!(frame.contains('🙂'), "got {frame:?}");
    }

    // Requires the local mock provider:  pnpm mock
    #[tokio::test]
    #[ignore = "hits the local mock provider on 127.0.0.1:8787"]
    async fn streams_text_from_an_openai_compatible_endpoint() {
        let cfg = mock_config();
        let mut text = String::new();
        let outcome = stream_chat(&cfg, &messages(), None, CancelToken::new(), |chunk| {
            if let Chunk::Text(part) = chunk {
                text.push_str(&part);
            }
        })
        .await
        .expect("stream failed");

        assert!(text.len() > 100, "expected a real reply, got {text:?}");
        assert!(text.contains("One seam") || text.contains("seam"));
        match outcome {
            Outcome::Completed(done) => {
                assert_eq!(done.text, text);
                assert!(done.tool_calls.is_empty());
                assert!(done.usage.map(|u| u.completion_tokens > 0).unwrap_or(false));
            }
            Outcome::Cancelled => panic!("unexpected cancel"),
        }
    }

    #[tokio::test]
    #[ignore = "hits the local mock provider on 127.0.0.1:8787"]
    async fn cancel_interrupts_an_in_flight_stream() {
        let cfg = mock_config();
        let token = CancelToken::new();
        let handle = token.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(400)).await;
            handle.cancel();
        });
        let outcome = stream_chat(&cfg, &messages(), None, token, |_| {})
            .await
            .expect("stream failed");
        assert!(matches!(outcome, Outcome::Cancelled));
    }
}
