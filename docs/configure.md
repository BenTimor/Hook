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

[image]
base_url = "https://openrouter.ai/api/v1"
api_key = "sk-or-v1-..."   # empty = the picture tools are not offered at all
model = "meta/muse-image"  # any model OpenRouter lists at GET /images/models
max_per_call = 4           # ceiling on `count` in one call
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

## Pictures

`[image]` is where Hook gets a picture it did not have. It posts to OpenRouter's
Image API (`POST {base_url}/images`, `response_format: "b64_json"`) and keeps the
bytes like any other attachment: in the chat's own image folder, uploaded by the
sync engine, drawn by the same strip and opened by the same lightbox as a
screenshot. The key is compiled into the binary exactly like `[provider]
api_key`, so treat it as extractable; `HOOK_IMAGE_KEY` in the environment
overrides it, which is how a dev build tries a key without a rebuild. An empty
key is a supported state: the two tools are never advertised, the prompt loses
its "Pictures" section, and nothing else changes.

One endpoint serves three callers, and they differ in what they can do with the
result:

| Caller | What it gets |
| --- | --- |
| the chat agent | `generate_image` (in the conversation, optionally saved to a folder or file) and `attach_image` (a file on this computer, put in front of the user) |
| a direct coding agent | the same two, over the loopback bridge — its conversation *is* the chat |
| a coding agent the chat agent relays | `generate_image` only, and only to a file: nothing relays its pictures into a conversation |

A picture Hook made or one an agent attached is a message of role `picture`: the
thread draws it with its caption, and `build_history` replays it as a user frame
where it sits, so the model reads it on the next turn. `look_at_picture` is the
other half — it opens a picture for the model without claiming anything about it.

---

[Documentation](README.md) · [Hook](../README.md)
