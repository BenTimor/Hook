# Tests

What each suite proves, and which commands run them.

```bash
cargo test                                      # the whole workspace: no engine, no network
cargo test -p hook-core --no-default-features    # the backend without Tauri: what `hook-host` links
cargo test -p hook-core -- --ignored             # live tests against `pnpm mock`
pnpm typecheck                                  # the only static gate: every package + the site
pnpm waitlist:test                              # API, auth, proxy, download, sync, git, devices, relay, preview, workspace
pnpm test:release                               # "is this tree already published?"
pnpm test:markdown                              # the document dialect: parser, live editor, renderer, reference
pnpm test:greetings                             # greeting windows, boundaries, shuffle rotation and the first-name rule
pnpm test:licenses                              # every dep still fits AGPL-3.0-only
pnpm release                                    # build + publish the installers
```

GitHub Actions runs the checks on every push to `main` that can change a desktop
product, and on every pull request (`.github/workflows/checks.yml`): a `verify`
job (landing-page tests and build, the release-gate tests, the document and
greeting suites, `pnpm typecheck`, both window builds) and a `rust-test` job
(`cargo test -p hook-core`), in parallel.
Nothing there builds an installer — `pnpm release` does that, locally, when you
decide to ship (see [Releasing](releasing.md)). The release profile is
`lto = "thin"` with parallel codegen units, and a product ships one `rlib` plus
its binary — not the
mobile `staticlib`/`cdylib` as well. `--no-default-features` is the windowless
build: it compiles out `commands.rs`, `update.rs` and every Tauri type, which is
what `crates/hook-host` ships, so a change that reaches for an `AppHandle` below
`lib.rs` fails there instead of in a review. `cargo test` covers SSE framing, UTF-8 splits, reasoning echo (the exact request
shapes thinking-mode APIs reject), image parts and the base64/header helpers,
path containment, the project and agent stores, progress batching, the chat-agent
tool loop, the guard policy (a Node harness feeds it bad `bash` calls, force-push
commands and the checklist/sync tools), the sync engine against a local HTTP
server (push+merge, pull+announce), a second machine's git clone/push, the git
size hook, the RPC handshake (spawns the real engine, asks `get_state`, never
calls a model) and a full agent lifecycle against a fake one that speaks the
protocol, the update policy (version ordering, the minimum floor, and a
manifest whose floor is ahead of its newest build), and the two export readers
(ChatGPT's `mapping` tree and Claude's parent chain, citations, hidden messages,
RFC 3339 dates, and a re-import that updates, skips or keeps a locally edited
chat). Tests skip themselves when the engine or `node` is missing.

The workspace suite (`server/workspace.test.mjs`) drives the real router against a
temporary SQLite file: the role table, an invitation accepted in the product,
viewer/editor/manager limits, ownership transfer and its permanence, a removed
member's tombstone in the changes feed, flexible property types (select,
multi-select, checkbox, timeline and hidden properties) and a board's default
view, several assignees on one task, comment editing and deletion by author or
manager, an agent comment
that carries the conversation it came from, a stale document write that is refused
with the current copy, folder nesting and deletion that keeps its contents, and
account deletion that removes owned projects but not other people's.
`server/relay.test.mjs` drives two real WebSocket clients against the hub:
presence, host/controller roles, RPC routing and timeout, per-chat fan-out,
removal and the paid gate. `server/preview.test.mjs` mints a ticket, tunnels a
request over the host's socket and checks the response. `server/releases.test.mjs`
covers the second product's index and its "not published yet" answer.

---

[Documentation](README.md) · [Hook](../README.md)
