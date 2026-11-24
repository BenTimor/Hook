# The model proxy

The OpenAI-compatible proxy that keeps the provider key server-side, what it meters, and the search tool behind it.

## Proxy and usage

`/api/v1/chat/completions` is OpenAI-compatible, so the chat agent and pi use it
unchanged. The app does not send a provider or a meaningful model: the proxy
injects `DEEPSEEK_MODEL`, the server key and `stream_options.include_usage`, then
relays the SSE stream byte-for-byte. `/api/v1/models` describes the single
`HOOK_MODEL_ID` model (with the configured model's context, output and image
capabilities) so the app's capability probe works.

A reply is not cut short by a clock. There is no overall or idle deadline on a
turn and no limit on how many tool round-trips it may take: a model that thinks
for minutes before its first token, or an agent working through a long job, runs
until it answers or you press Stop. The window still cannot be left waiting by a
turn that died — `finish()` turns a reply that never completed into a visible
error — but the decision to stop is yours, not a timeout's.

Every request is tagged with headers from the client:

| Header | Meaning |
|---|---|
| `X-Hook-Surface` | `chat` or `coding` |
| `X-Hook-Chat-Id` | Conversation id, so usage can be grouped per chat |
| `X-Hook-Agent-Id` | Coding-agent run id, set per spawned process |
| `X-Hook-Message-Id` | The user message this request belongs to; repeated by every call of one turn |
| `X-Hook-Client` / `X-Hook-App-Version` | Client build |

A `free` account is refused before the upstream request: `coding_not_included`
for a coding surface, and `message_limit` once 100 distinct message ids have been
seen in the last 24 hours. `usage_events` also records the plan in force, so a
later plan change does not rewrite history. A request to a personal endpoint
carries none of these headers and never reaches this service.

`usage_events` stores input/output tokens, `prompt_cache_hit_tokens`,
`prompt_cache_miss_tokens`, reasoning tokens, duration, time-to-first-token and
the status for each request. The cache hit rate is computed from the hit/miss
pair, not from a guess. Analyse it with:

```bash
./scripts/waitlist-admin.sh --usage          # per account
./scripts/waitlist-admin.sh --usage-plans    # per plan (the plan stored on each request)
./scripts/waitlist-admin.sh --usage-chats    # per conversation
./scripts/waitlist-admin.sh --usage-agents   # per coding-agent run
```

Rows are stored with UTC timestamps; the tables print them in Israel time
(`Asia/Jerusalem`, DST included).

The proxy also enforces a small per-account concurrency and requests-per-minute
limit. Revocation is checked on every request, so `--revoke` takes effect without
restarting anything.

## Web search

Both agents have a `web_search` tool. It calls `/api/v1/search` on Hook's proxy,
which forwards to DeepSeek's standalone Search API (`/v1/tools/search`) with the
server key. DeepSeek's built-in `deepseek_web_search` **server tool** cannot be
combined with the agents' own function tools yet, so this uses the same search
engine behind an ordinary tool instead.

The tool returns titles, URLs, snippets and summaries, and tells the model to
cite the URLs it uses. The chat agent calls it directly; coding agents get it
from `hook-guard.mjs` using `HOOK_API_BASE` and `HOOK_API_TOKEN`. Queries support
DeepSeek's operators (`site:`, `-site:`, `"exact phrase"`, `lang:`, `after:`,
`before:`, `-term`).

Search is billed by DeepSeek per successful request, independently of token
usage. It is not included in the token/cache totals; the proxy logs only that a
search happened and how many results came back, not the query text. The
per-account search limit is 4 in flight and 60 per minute.

---

[Documentation](README.md) · [Hook](../README.md)
