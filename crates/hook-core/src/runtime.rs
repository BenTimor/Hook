//! Locating and configuring the coding engine that runs inside Hook.
//!
//! Hook ships its own runtime: a `node.exe` plus the pi coding agent's JS
//! bundle, both copied next to the app at build time. Nothing else on the
//! machine is consulted, so the coding agents behave the same on a clean
//! Windows install as they do on a developer box — and the user never learns
//! that pi exists.
//!
//! The engine also gets its own configuration directory. Pi normally reads
//! `~/.pi/agent`; pointing `PI_CODING_AGENT_DIR` elsewhere means Hook's agents
//! use exactly the chat agent's endpoint, key and model, and never pick up the
//! user's own pi setup (extensions, skills, MCP servers, logins).

use std::fs;
use std::path::{Path, PathBuf};

use crate::config::HarnessConfig;

/// How to launch the engine.
#[derive(Debug, Clone)]
pub struct PiRuntime {
    /// Absolute path to the executable to spawn (`node.exe` when bundled).
    pub program: PathBuf,
    /// The pi JS bundle, when running on the bundled Node runtime.
    pub cli: Option<PathBuf>,
    /// Isolated `PI_CODING_AGENT_DIR` holding Hook's `models.json`.
    pub agent_home: PathBuf,
}

impl PiRuntime {
    /// Arguments that must precede the command line (`node <cli>`).
    pub fn prefix_args(&self) -> Vec<String> {
        self.cli
            .as_ref()
            .map(|cli| vec![cli.to_string_lossy().to_string()])
            .unwrap_or_default()
    }

    pub fn describe(&self) -> String {
        match &self.cli {
            Some(cli) => format!("{} {}", self.program.display(), cli.display()),
            None => self.program.display().to_string(),
        }
    }
}

/// Folder name inside the app's resources.
const RUNTIME_DIR: &str = "pi-runtime";

/// Locate the engine, preferring the copy that ships with the app.
///
/// `resource_dir` is the app's resource folder; the fallbacks exist so
/// `cargo test` and `tauri dev` keep working without a packaged build.
pub fn resolve(resource_dir: Option<&Path>, data_dir: &Path) -> Result<PiRuntime, String> {
    let agent_home = data_dir.join("agent-home");
    fs::create_dir_all(&agent_home)
        .map_err(|e| format!("Could not create the agent home at {}: {e}", agent_home.display()))?;

    // The exact resource layout differs between a bundled install, a portable
    // build and `tauri dev`, so try the plausible roots instead of guessing.
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = resource_dir {
        roots.push(dir.to_path_buf());
        roots.push(dir.join("resources"));
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            roots.push(dir.to_path_buf());
            roots.push(dir.join("resources"));
        }
    }
    roots.push(Path::new(env!("CARGO_MANIFEST_DIR")).join("resources"));

    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in roots {
        candidates.push(root.join(RUNTIME_DIR));
    }

    for dir in candidates {
        let node = dir.join(node_exe());
        let cli = dir.join("pi").join("dist").join("bundle").join("cli.js");
        if node.is_file() && cli.is_file() {
            // Tauri hands out verbatim paths (`\\?\C:\...`). Node cannot load a
            // script through one — it reads the `?` as a path segment — so strip
            // the prefix before anything is executed with it.
            let program = crate::store::strip_verbatim(&node);
            let cli = crate::store::strip_verbatim(&cli);
            eprintln!("hook: coding engine at {}", program.display());
            return Ok(PiRuntime {
                program,
                cli: Some(cli),
                agent_home: crate::store::strip_verbatim(&agent_home),
            });
        }
    }

    // Last resort: a pi binary the developer has on PATH. Release builds always
    // take the branch above, so users never end up here.
    if let Some(pi) = which_pi() {
        return Ok(PiRuntime {
            program: crate::store::strip_verbatim(&pi),
            cli: None,
            agent_home: crate::store::strip_verbatim(&agent_home),
        });
    }

    Err(format!(
        "Hook's coding engine is missing (expected {RUNTIME_DIR}/{}/pi/dist/bundle/cli.js). Reinstall Hook to restore it.",
        node_exe()
    ))
}

fn node_exe() -> &'static str {
    if cfg!(windows) {
        "node.exe"
    } else {
        "node"
    }
}

fn which_pi() -> Option<PathBuf> {
    let candidates: &[&str] = if cfg!(windows) {
        &["pi.cmd", "pi.exe", "pi"]
    } else {
        &["pi"]
    };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        for name in candidates {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Write the agent's provider configuration so coding agents authenticate with
/// the same credentials as the chat agent.
///
/// Pi reads this once per launch; rewriting it on every start means a rebuilt
/// app always drives the engine with the config compiled into it.
/// The per-turn output ceiling advertised to pi. pi clamps it to whatever room
/// is left in the context window (`contextWindow - prompt - 4096`), so a very
/// large number simply means "think as long as you need"; a small one makes a
/// thinking model burn the budget on reasoning and stop with nothing written.
fn output_budget(cfg: &HarnessConfig) -> u64 {
    match cfg.coding.max_output_tokens {
        0 => 393_216,
        n => n.max(1024),
    }
}

pub fn write_agent_home(rt: &PiRuntime, cfg: &HarnessConfig, vision: bool) -> Result<(), String> {
    fs::create_dir_all(&rt.agent_home)
        .map_err(|e| format!("Could not create {}: {e}", rt.agent_home.display()))?;
    let base = base_url_for_pi(&cfg.provider.endpoint());
    let model = cfg.coding.model().unwrap_or(&cfg.model.name);

    let mut entry = serde_json::json!({
        "id": model,
        "name": model,
        // The card says whether the engine may pass a thinking level at all.
        // Either side can want one: the chat model and the coding agent have
        // separate levels now, so one of them asking is enough.
        "reasoning": cfg.model.thinking_level().is_some() || cfg.coding.thinking().is_some(),
        "input": if vision { serde_json::json!(["text", "image"]) } else { serde_json::json!(["text"]) },
        "contextWindow": cfg.coding.context_window,
        "maxTokens": output_budget(cfg),
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
        // Hook's proxy lives on hookcode.io, which pi cannot recognise as a
        // DeepSeek endpoint from the URL alone. Pin the wire format so coding
        // agents send the same reasoning_effort field as the chat agent.
        "compat": {
            "thinkingFormat": "openai",
            "supportsReasoningEffort": true,
            "supportsUsageInStreaming": true,
        },
    });

    // The token itself stays in the process environment. models.json only
    // carries `$HOOK_API_TOKEN`, and the per-run env is set when the agent is
    // spawned, so the key is not duplicated into every agent directory.
    if let Some(obj) = entry.as_object_mut() {
        let mut headers = cfg.provider.headers.clone();
        headers.insert("X-Hook-Client".into(), "hook-desktop".into());
        headers.insert("X-Hook-Surface".into(), "coding".into());
        headers.insert("X-Hook-Chat-Id".into(), "$HOOK_CHAT_ID".into());
        headers.insert("X-Hook-Agent-Id".into(), "$HOOK_AGENT_ID".into());
        headers.insert("X-Hook-App-Version".into(), crate::version::current());
        obj.insert(
            "headers".into(),
            serde_json::to_value(headers).unwrap_or_default(),
        );
    }

    let models = serde_json::json!({
        "providers": {
            "hook": {
                "baseUrl": base,
                "api": "openai-completions",
                "apiKey": "$HOOK_API_TOKEN",
                "authHeader": true,
                "models": [entry],
            }
        }
    });

    let models_path = rt.agent_home.join("models.json");
    let raw = serde_json::to_string_pretty(&models).map_err(|e| e.to_string())?;
    // Temp + rename: two agents can start at once without one reading a
    // truncated models.json from the other's write.
    let tmp = models_path.with_extension("json.tmp");
    fs::write(&tmp, raw)
        .map_err(|e| format!("Could not write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, &models_path)
        .map_err(|e| format!("Could not replace {}: {e}", models_path.display()))?;

    // Keep the engine quiet: no install pings from an app the user thinks is local.
    let settings_path = rt.agent_home.join("settings.json");
    let settings = serde_json::json!({
        "enableInstallTelemetry": false,
        "enableAnalytics": false,
    });
    let settings_tmp = settings_path.with_extension("json.tmp");
    fs::write(
        &settings_tmp,
        serde_json::to_string_pretty(&settings).unwrap_or_default(),
    )
    .map_err(|e| format!("Could not write {}: {e}", settings_tmp.display()))?;
    fs::rename(&settings_tmp, &settings_path)
        .map_err(|e| format!("Could not replace {}: {e}", settings_path.display()))?;

    Ok(())
}

/// Model reference the engine understands: `<provider>/<model>`.
pub fn model_ref(cfg: &HarnessConfig) -> String {
    format!("hook/{}", cfg.coding.model().unwrap_or(&cfg.model.name))
}

/// Pi appends `/chat/completions` to whatever base URL it is given, so peel
/// the endpoint back down to its root.
fn base_url_for_pi(endpoint: &str) -> String {
    let trimmed = endpoint.trim_end_matches('/');
    for suffix in ["/chat/completions", "/completions"] {
        if let Some(base) = trimmed.strip_suffix(suffix) {
            return base.to_string();
        }
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{AuthConfig, CodingConfig, ModelConfig, ProviderConfig};

    fn config() -> HarnessConfig {
        HarnessConfig {
            provider: ProviderConfig {
                base_url: "https://hookcode.io/api/v1".into(),
                api_key: String::new(),
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
                name: "hook".into(),
                thinking: Some("medium".into()),
                temperature: None,
                max_tokens: None,
            },
            auth: AuthConfig::default(),
            coding: CodingConfig::default(),
            agent: Default::default(),
            memory: Default::default(),
            update: Default::default(),
        }
    }

    #[test]
    fn endpoint_is_reduced_to_a_base_url() {
        assert_eq!(
            base_url_for_pi("https://api.deepseek.com/chat/completions"),
            "https://api.deepseek.com"
        );
        assert_eq!(
            base_url_for_pi("https://api.deepseek.com/v1/chat/completions"),
            "https://api.deepseek.com/v1"
        );
        assert_eq!(
            base_url_for_pi("https://gateway.example.com/openai/completions"),
            "https://gateway.example.com/openai"
        );
        assert_eq!(
            base_url_for_pi("https://gateway.example.com/v1"),
            "https://gateway.example.com/v1"
        );
    }

    #[test]
    fn agent_models_json_uses_the_env_token_and_usage_headers() {
        let dir = std::env::temp_dir().join(format!("hook-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let rt = PiRuntime {
            program: PathBuf::from("node"),
            cli: Some(PathBuf::from("cli.js")),
            agent_home: dir.clone(),
        };
        write_agent_home(&rt, &config(), false).unwrap();
        let raw = std::fs::read_to_string(dir.join("models.json")).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        let provider = &parsed["providers"]["hook"];
        assert_eq!(provider["baseUrl"], "https://hookcode.io/api/v1");
        assert_eq!(provider["apiKey"], "$HOOK_API_TOKEN");
        assert_eq!(provider["authHeader"], true);
        let headers = &provider["models"][0]["headers"];
        assert_eq!(headers["X-Hook-Surface"], "coding");
        assert_eq!(headers["X-Hook-Chat-Id"], "$HOOK_CHAT_ID");
        assert_eq!(headers["X-Hook-Agent-Id"], "$HOOK_AGENT_ID");
        assert_eq!(provider["models"][0]["compat"]["thinkingFormat"], "openai");
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn verbatim_paths_are_stripped_before_use() {
        // Node rejects `\\?\C:\...` as a script path; Tauri's resource dir is
        // verbatim, so the prefix must never reach the engine.
        let verbatim = Path::new(r"\\?\C:\Users\me\AppData\Local\Hook\pi-runtime");
        let stripped = crate::store::strip_verbatim(verbatim);
        assert_eq!(stripped, Path::new(r"C:\Users\me\AppData\Local\Hook\pi-runtime"));
        assert!(!stripped.to_string_lossy().starts_with(r"\\?\"));

        let unc = Path::new(r"\\?\UNC\server\share\pi-runtime");
        assert_eq!(
            crate::store::strip_verbatim(unc),
            Path::new(r"\\server\share\pi-runtime")
        );
    }

    #[test]
    fn prefix_args_are_empty_for_a_path_binary() {
        let rt = PiRuntime {
            program: PathBuf::from("pi.cmd"),
            cli: None,
            agent_home: PathBuf::from("."),
        };
        assert!(rt.prefix_args().is_empty());
    }

    #[test]
    fn prefix_args_carry_the_bundle() {
        let rt = PiRuntime {
            program: PathBuf::from("node.exe"),
            cli: Some(PathBuf::from("cli.js")),
            agent_home: PathBuf::from("."),
        };
        assert_eq!(rt.prefix_args(), vec!["cli.js".to_string()]);
    }
}
