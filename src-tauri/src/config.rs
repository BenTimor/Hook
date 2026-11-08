use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// Everything here is baked into the binary at compile time via `include_str!`.
/// There is no runtime override by design — changing any of it requires a rebuild.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessConfig {
    pub provider: ProviderConfig,
    pub model: ModelConfig,
    /// Coding agents (pi subprocesses). Optional section.
    #[serde(default)]
    pub coding: CodingConfig,
    /// Chat-agent behaviour. Optional section.
    #[serde(default)]
    pub agent: AgentConfig,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct AgentConfig {
    /// Replaces Hook's built-in instructions when non-empty.
    #[serde(default)]
    pub system_prompt: Option<String>,
}

impl AgentConfig {
    pub fn custom_prompt(&self) -> Option<&str> {
        self.system_prompt
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct CodingConfig {
    /// Passed to pi as `--model`. Empty means "use pi's own default".
    #[serde(default)]
    pub model: Option<String>,
    /// Thinking level for coding agents, pi's `--thinking` values.
    #[serde(default)]
    pub thinking: Option<String>,
    /// How many coding agents may run at once.
    #[serde(default = "default_max_agents")]
    pub max_concurrent: usize,
    /// Context window advertised to the engine for the chat model.
    #[serde(default = "default_context_window")]
    pub context_window: u64,
    /// How often batched coding-agent progress is handed to the chat agent.
    #[serde(default = "default_update_interval")]
    pub update_interval_seconds: u64,
    /// Hard cap (seconds) for a single bash call inside a coding agent.
    #[serde(default = "default_bash_max")]
    pub bash_max_timeout: u64,
    /// Floor (seconds) for a single bash call inside a coding agent.
    #[serde(default = "default_bash_min")]
    pub bash_min_timeout: u64,
}

fn default_max_agents() -> usize {
    3
}

fn default_context_window() -> u64 {
    128_000
}

fn default_update_interval() -> u64 {
    60
}

fn default_bash_max() -> u64 {
    3600
}

fn default_bash_min() -> u64 {
    1
}

impl CodingConfig {
    pub fn model(&self) -> Option<&str> {
        self.model.as_deref().map(str::trim).filter(|m| !m.is_empty())
    }

    pub fn thinking(&self) -> Option<&str> {
        self.thinking
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ProviderConfig {
    pub base_url: String,
    pub api_key: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub reasoning_param: Option<String>,
    #[serde(default = "default_true")]
    pub stream_usage: bool,
    /// Offer the agent tools to the chat model. Disable if the endpoint
    /// rejects the `tools` field.
    #[serde(default = "default_true")]
    pub tools: bool,
    /// The model can see images. When on, attached pictures are sent as image
    /// parts (and coding-agent screenshots are visible to the chat agent);
    /// when off they are described in text instead. If the endpoint turns out
    /// to reject images anyway, Hook retries the turn without them.
    #[serde(default)]
    pub vision: bool,
    /// How assistant reasoning is echoed back in the conversation history.
    ///   "auto" (default) - the same field the provider streamed it in
    ///                     ("reasoning_content", or "reasoning"), which is what
    ///                     thinking-mode APIs such as DeepSeek require
    ///   "off"            - never send reasoning back
    ///   "<field>"        - always echo it under this field name
    #[serde(default)]
    pub reasoning_echo: Option<String>,
    #[serde(default)]
    pub headers: BTreeMap<String, String>,
    #[serde(default)]
    pub extra: BTreeMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelConfig {
    pub name: String,
    #[serde(default)]
    pub thinking: Option<String>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
}

fn default_true() -> bool {
    true
}

const RAW: &str = include_str!("../../harness.config.toml");

static CONFIG: OnceLock<Result<HarnessConfig, String>> = OnceLock::new();

pub fn get() -> Result<&'static HarnessConfig, String> {
    CONFIG
        .get_or_init(|| {
            toml::from_str::<HarnessConfig>(RAW)
                .map_err(|e| format!("Invalid harness.config.toml — {e}"))
        })
        .as_ref()
        .map_err(|e| e.to_string())
}

impl ProviderConfig {
    /// Full chat-completions URL. Tolerates a `base_url` that already includes the path.
    pub fn endpoint(&self) -> String {
        let base = self.base_url.trim_end_matches('/');
        if base.ends_with("/chat/completions") || base.ends_with("/completions") {
            return base.to_string();
        }
        let raw_path = self.path.as_deref().unwrap_or("/chat/completions");
        let path = if raw_path.starts_with('/') {
            raw_path.to_string()
        } else {
            format!("/{raw_path}")
        };
        format!("{base}{path}")
    }

    /// Host only — the UI never needs the full URL or the key.
    pub fn host(&self) -> String {
        let without_scheme = self
            .base_url
            .split_once("://")
            .map(|(_, rest)| rest)
            .unwrap_or(&self.base_url);
        without_scheme
            .split('/')
            .next()
            .unwrap_or(without_scheme)
            .to_string()
    }

    pub fn reasoning_param(&self) -> &str {
        self.reasoning_param.as_deref().unwrap_or("reasoning_effort")
    }
}

/// How reasoning from previous assistant turns is replayed to the provider.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReasoningEcho {
    Off,
    /// Use the field this message was streamed in, falling back to
    /// `reasoning_content` for messages stored before the field was recorded.
    Auto,
    Fixed(String),
}

impl ProviderConfig {
    pub fn reasoning_echo(&self) -> ReasoningEcho {
        match self.reasoning_echo.as_deref().map(str::trim) {
            Some("off") | Some("false") | Some("none") => ReasoningEcho::Off,
            Some(other) if !other.is_empty() && other != "auto" => {
                ReasoningEcho::Fixed(other.to_string())
            }
            _ => ReasoningEcho::Auto,
        }
    }
}

impl ReasoningEcho {
    /// Field name to use for one assistant message, if any.
    pub fn field_for(&self, recorded: Option<&str>) -> Option<String> {
        match self {
            ReasoningEcho::Off => None,
            ReasoningEcho::Fixed(name) => Some(name.clone()),
            ReasoningEcho::Auto => Some(
                recorded
                    .filter(|name| !name.is_empty())
                    .unwrap_or("reasoning_content")
                    .to_string(),
            ),
        }
    }
}

impl ModelConfig {
    /// `None` means "send no reasoning parameter at all".
    pub fn thinking_level(&self) -> Option<&str> {
        match self.thinking.as_deref() {
            None | Some("") => None,
            Some(level)
                if level.eq_ignore_ascii_case("off")
                    || level.eq_ignore_ascii_case("none")
                    || level.eq_ignore_ascii_case("false") =>
            {
                None
            }
            Some(level) => Some(level),
        }
    }

}
