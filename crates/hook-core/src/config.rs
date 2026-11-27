use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// Everything here is baked into the binary at compile time via `include_str!`.
/// Changing any of it requires a rebuild. The one runtime override is a user's
/// own model endpoint, chosen in this product's Settings and resolved by
/// `provider::ProviderTarget`; it is stored on the machine and never in this file.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessConfig {
    pub provider: ProviderConfig,
    pub model: ModelConfig,
    /// Where the desktop app signs in. Optional; defaults to hookcode.io.
    #[serde(default)]
    pub auth: AuthConfig,
    /// Coding agents (pi subprocesses). Optional section.
    #[serde(default)]
    pub coding: CodingConfig,
    /// Chat-agent behaviour. Optional section.
    #[serde(default)]
    pub agent: AgentConfig,
    /// When a long chat is summarized so its context stays small.
    #[serde(default)]
    pub compact: CompactConfig,
    /// What the chat agent remembers between conversations. Optional section.
    #[serde(default)]
    pub memory: MemoryConfig,
    /// Update channel details. Optional section.
    #[serde(default)]
    pub update: UpdateConfig,
    /// Making pictures. Optional section; without a key the image tools are
    /// simply not offered, and nothing else changes.
    #[serde(default)]
    pub image: ImageConfig,
}

/// Where a picture comes from.
///
/// Hook does not generate images itself: one endpoint answers with the bytes and
/// Hook stores them like any other picture in a chat. The default is OpenRouter's
/// Image API, which needs an account key. Like `[provider]`, this is compiled into
/// the build with `include_str!`, so treat the key as extractable by anyone
/// holding the binary; `HOOK_IMAGE_KEY` overrides it at runtime for a dev build.
#[derive(Debug, Clone, Deserialize)]
pub struct ImageConfig {
    #[serde(default = "default_image_base")]
    pub base_url: String,
    /// The account key for `base_url`. Empty disables the tools.
    #[serde(default)]
    pub api_key: String,
    #[serde(default = "default_image_model")]
    pub model: String,
    /// How many pictures one call may ask for. The model decides its own cap;
    /// this is the ceiling Hook passes on.
    #[serde(default = "default_image_count")]
    pub max_per_call: u8,
}

fn default_image_base() -> String {
    "https://openrouter.ai/api/v1".to_string()
}

fn default_image_model() -> String {
    "meta/muse-image".to_string()
}

fn default_image_count() -> u8 {
    4
}

impl Default for ImageConfig {
    fn default() -> Self {
        Self {
            base_url: default_image_base(),
            api_key: String::new(),
            model: default_image_model(),
            max_per_call: default_image_count(),
        }
    }
}

impl ImageConfig {
    /// The key in force: the environment wins, so a dev build can try a key
    /// without recompiling. `None` means image generation is not configured.
    pub fn key(&self) -> Option<String> {
        let from_env = std::env::var("HOOK_IMAGE_KEY").ok().unwrap_or_default();
        let key = [from_env.as_str(), self.api_key.as_str()]
            .iter()
            .map(|value| value.trim())
            .find(|value| !value.is_empty())?;
        Some(key.to_string())
    }

    pub fn enabled(&self) -> bool {
        self.key().is_some()
    }

    /// `https://host/api/v1` with no trailing slash, and `/images` appended.
    pub fn images_url(&self) -> String {
        format!("{}/images", self.base_url.trim().trim_end_matches('/'))
    }

    pub fn model(&self) -> &str {
        let model = self.model.trim();
        if model.is_empty() {
            "meta/muse-image"
        } else {
            model
        }
    }

    pub fn max_per_call(&self) -> u8 {
        self.max_per_call.clamp(1, 10)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct UpdateConfig {
    /// Microsoft Store product id. Empty opens the Store's update page.
    #[serde(default)]
    pub store_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthConfig {
    /// Origin of the Hook account service (no trailing slash needed).
    #[serde(default = "default_auth_base")]
    pub base_url: String,
    /// Mock builds can turn the account gate off; production always requires it.
    #[serde(default = "default_true")]
    pub required: bool,
}

fn default_auth_base() -> String {
    "https://hookcode.io".to_string()
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            base_url: default_auth_base(),
            required: true,
        }
    }
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

/// Compacting a chat's context. A conversation that keeps growing is replayed in
/// every request, so past a share of the window its older turns are summarized
/// into one hidden message and only the recent ones are sent whole.
#[derive(Debug, Clone, Deserialize)]
pub struct CompactConfig {
    /// Summarize automatically. Off leaves `/compact` as the only way.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Share of the context window at which a chat is compacted (0.0–1.0).
    /// 0.3 means the older turns go once a request would spend 30% of the
    /// window on them.
    #[serde(default = "default_compact_at")]
    pub at: f32,
    /// Recent user turns kept verbatim after the summary. The cut always lands
    /// on a user message, so no tool call is separated from its result.
    #[serde(default = "default_keep_turns")]
    pub keep_turns: usize,
    /// The window the share is measured against. 0 uses `[coding]
    /// context_window`, which is also what the engine is told the model takes.
    #[serde(default)]
    pub window: u64,
}

impl Default for CompactConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            at: default_compact_at(),
            keep_turns: default_keep_turns(),
            window: 0,
        }
    }
}

impl CompactConfig {
    /// The window to measure against: the build's own number unless the section
    /// overrides it. Zero is never a window.
    pub fn window(&self, coding: &CodingConfig) -> u64 {
        if self.window > 0 {
            self.window
        } else {
            coding.context_window
        }
    }

    /// The share, clamped to something that can actually fire.
    pub fn share(&self) -> f32 {
        self.at.clamp(0.05, 0.95)
    }
}

fn default_compact_at() -> f32 {
    0.30
}

fn default_keep_turns() -> usize {
    3
}

/// Long-term memory. The caps are budgets, not preferences: the pinned block is
/// paid for on every single request, so it has a hard ceiling.
#[derive(Debug, Clone, Deserialize)]
pub struct MemoryConfig {
    /// Offer the memory tools and the prompt section at all.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// How a context frame is sent: as a trailing `system` message (the default)
    /// or as a `user` message when an endpoint rejects a system message that is
    /// not the first one.
    #[serde(default)]
    pub context_role: Option<String>,
    /// Ceiling on stored entries (pinned and not), tombstones excluded.
    #[serde(default = "default_max_entries")]
    pub max_entries: usize,
    /// Ceiling on pinned entries. They ride on every request.
    #[serde(default = "default_max_pinned")]
    pub max_pinned: usize,
    /// Ceiling on the characters the pinned block may occupy in the prompt
    /// (roughly four characters per token).
    #[serde(default = "default_pinned_budget")]
    pub pinned_budget_chars: usize,
    /// Longest single memory. Longer facts are cut rather than rejected.
    #[serde(default = "default_max_text")]
    pub max_text_chars: usize,
}

impl Default for MemoryConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            context_role: None,
            max_entries: default_max_entries(),
            max_pinned: default_max_pinned(),
            pinned_budget_chars: default_pinned_budget(),
            max_text_chars: default_max_text(),
        }
    }
}

impl MemoryConfig {
    /// `"system"` unless the build says otherwise.
    pub fn context_role(&self) -> &str {
        match self.context_role.as_deref().map(str::trim) {
            Some("user") => "user",
            Some("none") | Some("off") => "",
            _ => "system",
        }
    }
}

fn default_max_entries() -> usize {
    400
}

fn default_max_pinned() -> usize {
    40
}

fn default_pinned_budget() -> usize {
    2400
}

fn default_max_text() -> usize {
    400
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
    /// How many output tokens one agent turn may use. Thinking models spend
    /// part of this budget on reasoning before they write anything, so a small
    /// cap makes them think until they are cut off and stop with nothing done.
    /// The default is the model's own ceiling, which is also an API limit: the
    /// provider rejects anything larger. pi clamps it down to whatever room is
    /// left in `context_window`, so this only ever caps a nearly empty context.
    /// `0` means "use the model ceiling".
    #[serde(default = "default_max_output")]
    pub max_output_tokens: u64,
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
    1_048_576
}

fn default_max_images() -> usize {
    3
}

fn default_update_interval() -> u64 {
    60
}

fn default_max_output() -> u64 {
    393_216
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
    /// Reserved for direct-provider development builds. The Hook proxy uses
    /// the signed-in session token instead.
    #[allow(dead_code)]
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
    /// How many pictures from the conversation go into one request. The newest
    /// ones win; older pictures stay in the chat but reach the model as a text
    /// note instead of image parts. Providers differ on how many they accept,
    /// so this stays conservative unless the endpoint says otherwise.
    #[serde(default = "default_max_images")]
    pub max_images: usize,
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

const RAW: &str = include_str!("../../../harness.config.toml");

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

    /// Where the model list lives. Derived from the chat endpoint by cutting the
    /// chat path off, so a provider that mounts its API under a prefix
    /// (`/v1`, `/openai`) gets the right `…/models` URL without extra config.
    pub fn models_endpoint(&self) -> String {
        let endpoint = self.endpoint();
        let root = endpoint
            .strip_suffix("/chat/completions")
            .or_else(|| endpoint.strip_suffix("/completions"))
            .unwrap_or_else(|| self.base_url.trim_end_matches('/'));
        format!("{}/models", root.trim_end_matches('/'))
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_is_on_with_budgets_by_default() {
        let cfg = get().expect("harness.config.toml");
        assert!(cfg.memory.enabled);
        assert!(cfg.memory.max_pinned > 0);
        assert!(cfg.memory.pinned_budget_chars > 0);
        assert_eq!(cfg.memory.context_role(), "system");
    }

    #[test]
    fn the_memory_section_is_optional_and_typed() {
        let raw = r#"
[provider]
base_url = "https://example.test/v1"
api_key = ""
[model]
name = "m"
[memory]
enabled = false
max_pinned = 5
context_role = "user"
"#;
        let cfg: HarnessConfig = toml::from_str(raw).expect("parse");
        assert!(!cfg.memory.enabled);
        assert_eq!(cfg.memory.max_pinned, 5);
        assert_eq!(cfg.memory.context_role(), "user");
        // Keys the file does not mention keep their built-in default.
        assert_eq!(cfg.memory.max_entries, 400);
    }

    #[test]
    fn an_unknown_context_role_falls_back_to_system() {
        let raw = r#"
[provider]
base_url = "https://example.test/v1"
api_key = ""
[model]
name = "m"
[memory]
context_role = "assistant"
"#;
        let cfg: HarnessConfig = toml::from_str(raw).expect("parse");
        assert_eq!(cfg.memory.context_role(), "system");
    }
}
