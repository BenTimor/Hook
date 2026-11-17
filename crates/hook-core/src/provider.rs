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

/// Which part of Hook is making the request. These values travel as headers
/// so the proxy can attribute usage to a conversation or a coding-agent run.
#[derive(Debug, Clone)]
pub struct RequestContext {
    pub chat_id: String,
    pub agent_id: Option<String>,
    pub surface: &'static str,
}

impl RequestContext {
    pub fn chat(chat_id: impl Into<String>) -> Self {
        Self {
            chat_id: chat_id.into(),
            agent_id: None,
            surface: "chat",
        }
    }
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
    token: &str,
    context: &RequestContext,
    messages: &[serde_json::Value],
    tools: Option<&serde_json::Value>,
    cancel: CancelToken,
    on_chunk: F,
) -> Result<Outcome, String>
where
    F: FnMut(Chunk) + Send,
{
    stream_chat_with(
        cfg,
        token,
        context,
        messages,
        tools,
        cancel,
        on_chunk,
        RESPONSE_TIMEOUT,
        IDLE_TIMEOUT,
    )
    .await
}

/// A reply that never starts, or starts and then goes silent, must not leave the
/// window thinking forever: both are turned into an error the user can retry.
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

#[allow(clippy::too_many_arguments)]
async fn stream_chat_with<F>(
    cfg: &HarnessConfig,
    token: &str,
    context: &RequestContext,
    messages: &[serde_json::Value],
    tools: Option<&serde_json::Value>,
    cancel: CancelToken,
    mut on_chunk: F,
    response_timeout: Duration,
    idle_timeout: Duration,
) -> Result<Outcome, String>
where
    F: FnMut(Chunk) + Send,
{
    if token.trim().is_empty() {
        return Err("Sign in to Hook to send messages.".into());
    }
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .pool_idle_timeout(Duration::from_secs(90))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    let mut request = client
        .post(cfg.provider.endpoint())
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "text/event-stream")
        .bearer_auth(token)
        .header("X-Hook-Client", "hook-desktop")
        .header("X-Hook-Surface", context.surface)
        .header("X-Hook-Chat-Id", &context.chat_id)
        .header("X-Hook-App-Version", env!("CARGO_PKG_VERSION"))
        .json(&build_body(cfg, messages, tools));
    if let Some(agent_id) = &context.agent_id {
        request = request.header("X-Hook-Agent-Id", agent_id);
    }

    for (name, value) in &cfg.provider.headers {
        request = request.header(name, value);
    }

    let response = tokio::time::timeout(response_timeout, request.send())
        .await
        .map_err(|_| {
            "The model did not answer in time. Check your connection and try again.".to_string()
        })?
        .map_err(|e| {
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
            // The timer restarts after every chunk, so this only fires when the
            // server has gone quiet — not when a reply is simply long.
            _ = tokio::time::sleep(idle_timeout) => {
                return Err("The model stopped sending data. Try again.".to_string())
            }
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

/// What the endpoint says the model can do, read from `GET /models` at
/// startup. Capabilities are a property of the model, not of a build flag:
/// the config carries none.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Capabilities {
    /// The endpoint answered and our model was in the list.
    pub known: bool,
    /// The model accepts image parts.
    pub vision: bool,
}

/// Ask the provider what our model can do. Never fails: a provider without a
/// usable `/models` simply reports nothing, and pictures are then described in
/// text instead of being sent as image parts.
pub async fn fetch_capabilities(cfg: &HarnessConfig, token: &str) -> Capabilities {
    if token.trim().is_empty() {
        return Capabilities::default();
    }
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(6))
        .timeout(Duration::from_secs(12))
        .build()
    else {
        return Capabilities::default();
    };
    let mut request = client
        .get(cfg.provider.models_endpoint())
        .header(reqwest::header::ACCEPT, "application/json")
        .header("X-Hook-Client", "hook-desktop")
        .header("X-Hook-Surface", "chat")
        .bearer_auth(token);
    for (name, value) in &cfg.provider.headers {
        request = request.header(name, value);
    }
    let Ok(response) = request.send().await else {
        return Capabilities::default();
    };
    if !response.status().is_success() {
        return Capabilities::default();
    }
    let Ok(body) = response.json::<serde_json::Value>().await else {
        return Capabilities::default();
    };
    match find_model(&body, &cfg.model.name) {
        Some(card) => Capabilities {
            known: true,
            vision: supports_vision(card),
        },
        None => Capabilities::default(),
    }
}

/// The model's card from a `/models` listing. Most providers use `data`;
/// a few use `models`.
fn find_model<'a>(body: &'a serde_json::Value, name: &str) -> Option<&'a serde_json::Value> {
    let list = body.get("data").or_else(|| body.get("models"))?.as_array()?;
    let matches = |v: &&serde_json::Value| {
        v.get("id")
            .and_then(|id| id.as_str())
            .map(|id| id.eq_ignore_ascii_case(name))
            .unwrap_or(false)
    };
    if let Some(card) = list.iter().find(matches) {
        return Some(card);
    }
    // One model listed and none of them named like ours: it is still the only
    // thing the endpoint serves.
    if list.len() == 1 {
        return list.first();
    }
    None
}

fn lists_image(value: &serde_json::Value) -> bool {
    value
        .as_array()
        .map(|items| {
            items.iter().any(|m| {
                m.as_str()
                    .map(|s| s.eq_ignore_ascii_case("image"))
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false)
}

fn is_true(value: &serde_json::Value) -> bool {
    value.as_bool().unwrap_or(false)
}

/// Best effort across the shapes providers actually use:
/// - `input_modalities: ["text", "image"]` (DeepSeek, newer OpenAI-compatible)
/// - `architecture.input_modalities` / `architecture.modality` (OpenRouter)
/// - `modalities.input` (some gateways)
/// - `capabilities.vision`, `vision`, `supports_vision` boolean flags
pub fn supports_vision(card: &serde_json::Value) -> bool {
    if lists_image(&card["input_modalities"])
        || lists_image(&card["architecture"]["input_modalities"])
        || lists_image(&card["modalities"]["input"])
    {
        return true;
    }
    if card["architecture"]["modality"]
        .as_str()
        .map(|m| m.to_ascii_lowercase().contains("image"))
        .unwrap_or(false)
    {
        return true;
    }
    is_true(&card["capabilities"]["vision"])
        || is_true(&card["capabilities"]["image_input"])
        || is_true(&card["vision"])
        || is_true(&card["supports_vision"])
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
                max_images: 3,
                reasoning_echo: None,
                headers: Default::default(),
                extra: Default::default(),
            },
            model: ModelConfig {
                name: "hook-mock-1".to_string(),
                thinking: Some("medium".to_string()),
                temperature: None,
                max_tokens: None,
            },
            auth: Default::default(),
            coding: Default::default(),
            agent: Default::default(),
            update: Default::default(),
        }
    }

    fn messages() -> Vec<serde_json::Value> {
        vec![serde_json::json!({ "role": "user", "content": "hello" })]
    }

    #[test]
    fn vision_comes_from_the_model_card() {
        assert!(supports_vision(&serde_json::json!({
            "id": "deepseek-flash",
            "input_modalities": ["text", "image"],
        })));
        assert!(supports_vision(&serde_json::json!({
            "id": "x",
            "architecture": {"input_modalities": ["image", "text"]},
        })));
        assert!(supports_vision(&serde_json::json!({
            "id": "x",
            "architecture": {"modality": "text+image->text"},
        })));
        assert!(supports_vision(&serde_json::json!({
            "id": "x",
            "capabilities": {"vision": true},
        })));
        assert!(!supports_vision(&serde_json::json!({
            "id": "x",
            "input_modalities": ["text"],
        })));
        assert!(!supports_vision(&serde_json::json!({"id": "x"})));
    }

    #[test]
    fn the_card_is_matched_by_name_even_with_different_case() {
        let body = serde_json::json!({
            "data": [
                {"id": "other-model", "input_modalities": ["text"]},
                {"id": "DeepSeek-Flash", "input_modalities": ["text", "image"]},
            ]
        });
        let card = find_model(&body, "deepseek-flash").expect("card");
        assert!(supports_vision(card));
        assert!(find_model(&body, "missing").is_none());
    }

    #[test]
    fn the_models_url_is_the_chat_url_without_its_path() {
        let mut cfg = mock_config();
        assert_eq!(
            cfg.provider.models_endpoint(),
            "http://127.0.0.1:8787/v1/models"
        );
        cfg.provider.base_url = "https://api.deepseek.com".into();
        cfg.provider.path = None;
        assert_eq!(
            cfg.provider.models_endpoint(),
            "https://api.deepseek.com/models"
        );
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
        let outcome = stream_chat(
            &cfg,
            "test-token",
            &RequestContext::chat("chat_test"),
            &messages(),
            None,
            CancelToken::new(),
            |chunk| {
                if let Chunk::Text(part) = chunk {
                    text.push_str(&part);
                }
            },
        )
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
        let outcome = stream_chat(
            &cfg,
            "test-token",
            &RequestContext::chat("chat_test"),
            &messages(),
            None,
            token,
            |_| {},
        )
        .await
        .expect("stream failed");
        assert!(matches!(outcome, Outcome::Cancelled));
    }

    /// The other half of the same report: the reply starts and then stalls. A
    /// long reply must keep streaming, a dead one must fail.
    #[tokio::test(flavor = "multi_thread")]
    async fn a_stream_that_goes_silent_errors_out() {
        use std::io::{Read, Write};

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        std::thread::spawn(move || {
            if let Ok((mut socket, _)) = listener.accept() {
                // Read the request head before answering, like a real server.
                let mut request = [0u8; 4096];
                let _ = socket.read(&mut request);
                let head = "HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\n\r\n";
                let _ = socket.write_all(head.as_bytes());
                let _ = socket.flush();
                std::thread::sleep(Duration::from_secs(5));
            }
        });

        let mut cfg = mock_config();
        cfg.provider.base_url = format!("http://{address}/v1");
        let error = stream_chat_with(
            &cfg,
            "test-token",
            &RequestContext::chat("chat_test"),
            &messages(),
            None,
            CancelToken::new(),
            |_| {},
            Duration::from_millis(300),
            Duration::from_millis(300),
        )
        .await
        .err()
        .expect("a stalled stream is an error");
        assert!(error.contains("stopped sending"), "{error}");
    }
}
