use std::collections::BTreeMap;
use std::sync::OnceLock;

use serde::Deserialize;

/// Everything here is baked into the binary at compile time via `include_str!`.
/// There is no runtime override by design — changing any of it requires a rebuild.
#[derive(Debug, Clone, Deserialize)]
pub struct HarnessConfig {
    pub provider: ProviderConfig,
    pub model: ModelConfig,
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
