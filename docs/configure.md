# Configure

Everything a build compiles in: `harness.config.toml`, its sections, and what each key changes.

Everything lives in **`harness.config.toml`** at the repo root. It is compiled
into the binary with `include_str!`, so the build's endpoint and model cannot be
changed at runtime. The one deliberate override is a user's own model endpoint
in Settings (see [Plans, limits and your own model](plans.md)): it replaces the
provider and model for that product only, and it is stored on the machine, never
in this config:

The production config (`harness.config.ci.toml`) points at Hook's own proxy:

```toml
[provider]
base_url = "https://hookcode.io/api/v1"
path = "/chat/completions"
api_key = ""                 # unused: the signed-in session supplies the token
reasoning_param = "reasoning_effort"
stream_usage = true
tools = true
reasoning_echo = "auto"

[model]
name = "hook"                # must match HOOK_MODEL_ID on the server
thinking = "low"

[auth]
base_url = "https://hookcode.io"
required = true              # false only for the local mock provider
```

`thinking` is sent using `reasoning_param` (mapped to `reasoning_effort` for
OpenAI-style APIs) and is never shown in the UI. Hook passes the level through
verbatim; what a level *means* is the provider's decision. DeepSeek, the
provider the proxy forwards to, has three: `minimal`/`low` are its `low`,
`medium`/`high`/`xhigh` are its `high`, and `max`/`ultra` are its `max` — so
`high` and `medium` buy the same reasoning, and only `low` or `max` changes
anything (see its [thinking mode guide](https://api-docs.deepseek.com/guides/thinking_mode/)).
Thinking-mode APIs (DeepSeek among them) reject the follow-up request unless
the assistant's `reasoning_content` is replayed on tool-calling turns — an
empty string counts.
Hook records the field each answer was streamed in and sends it back
automatically (`reasoning_echo = "auto"`).

The provider key lives on the server. The binary is built without it and sends
the signed-in user's opaque token instead, so extracting strings from the
executable no longer yields a usable model key.

Coding agents and the chat agent's instructions have their own optional
sections:

```toml
[coding]
model = ""            # passed to pi as --model; empty = the chat model
thinking = "high"       # passed to pi as --thinking; own level, not [model] thinking
max_concurrent = 3    # how many coding agents may run at once
bash_max_timeout = 3600   # seconds, enforced on every bash call
bash_min_timeout = 1

[agent]
system_prompt = ""    # empty = Hook's built-in instructions

[memory]
enabled = true
max_entries = 400        # stored entries, pinned and not
max_pinned = 40          # the ones in every prompt
pinned_budget_chars = 2400   # about 600 tokens; the block stops there
max_text_chars = 400     # longer facts are cut, not rejected
context_role = "system"  # "user" for an endpoint that rejects a trailing
                         # system message; "none" drops the live context

[compact]
enabled = true   # false leaves /compact (advanced mode) as the only way
at = 0.30        # compact once a request would spend 30% of the window
keep_turns = 3   # recent user turns kept verbatim after the summary
window = 0       # 0 = [coding] context_window; the share is measured against it
```

`[compact]` is the one place the request prefix is rewritten on purpose: a long
conversation would otherwise be replayed in full on every turn. It fires on the
first round of a turn, only when the estimate crosses the share, and it is a
model call of its own that repeats the user's message id — the free plan still
counts that message once. The share is an estimate of the window; when an
endpoint answers "too long" anyway (a model smaller than the configured window),
that turn compacts once and retries. See [Advanced mode](hook.md#advanced-mode) for how the cut is
drawn.

`harness.config.example.toml` remains a direct-provider template if you want to
build a standalone copy without the account service.

---

[Documentation](README.md) · [Hook](../README.md)
