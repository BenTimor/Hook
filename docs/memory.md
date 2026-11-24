# Memory

What the chat agent remembers, how it reaches a conversation without rewriting the request prefix, and what it costs.

The chat agent remembers things across conversations. Memory is **account**
data, not product data: it lives in `%APPDATA%\app.hook\memory\`, one file per
account, so the chat inside Hook Workspace knows what the chat inside Hook knows
and a different account on the same machine reads a different file.

Two shapes, on purpose:

- **Pinned** entries are in the prompt of every conversation. They are the
  things that should always be known: how the user likes to be talked to, what
  they work in, a correction that must not be repeated.
- **Everything else** is found with `memory_search` when it could change the
  answer. Nothing is retrieved automatically — see the cache note below.

All of it is editable in Settings → **Memory**: add, edit, pin, unpin, forget
one, forget everything, or switch memory off. Each row shows the kind, the age
and (from the store) the conversation it came from.

## What writes a memory

Only the turn that is already running. There is no extraction pass and no second
request: `remember`, `forget` and `memory_search` are ordinary tool calls, so
saving something costs a few tokens on a turn that was happening anyway. An
account with no extra spend is the whole reason memory is a tool and not a
background job — Hook has one model and the user pays for it.

Both writes are refused on a turn woken by a coding-agent note. A note can quote
a coding agent, and a coding agent can quote a web page; only the user's own
words become a fact about them. That is the memory-poisoning boundary, and it is
enforced in `run_tool` rather than asked for politely in the prompt.

`remember` pins `user` and `feedback` facts by default, which is what makes
"always know this" work without a second decision. `project` and `reference`
facts stay unpinned: they are found by search, so they do not tax every request.
The pinned set is capped (`max_pinned`, 40) and the block has a character budget
(`pinned_budget_chars`, 2400 ≈ 600 tokens). When it is full the tool refuses and
hands the pinned list back, so the agent merges instead of retrying.

## Why the prefix is append-only

Every provider Hook talks to caches a request by its longest common prefix with
an earlier one. Anything that rewrites the *beginning* of a request throws away
the whole cached conversation; appending keeps it.

Hook used to put the coding-agent notes, the live-agent hint and the window
context into the single leading system message. Every note that arrived
mid-conversation therefore invalidated the entire prefix — during coding
sessions, which are the expensive ones. Now:

- the leading system message is the instructions and nothing else, so it is
  byte-identical for the life of a chat;
- coding-agent notes and memory frames are ordinary hidden `system` messages,
  appended when they happen and **replayed in place** by `build_history`, so the
  sequence only ever grows;
- the live-agent hint and "what the user is looking at" are one trailing frame
  rebuilt per request, because changing the *last* thing costs nothing.

Memory follows the same rule, which is why it is told to a chat as frames rather
than injected per turn:

- The first turn of a chat appends **one** frame with everything pinned, at the
  top of the conversation.
- A later turn appends a frame with only what changed since the newest frame's
  revision — a memory added in this chat is already in the context, so normally
  there is nothing to append at all.
- A deletion cannot be appended as a fact, so it is appended as a correction
  ("no longer true"), and the later line wins by position.

`Message.kind` (`memory`) is what keeps a frame from being mistaken for a
coding-agent note when the prompt asks "is anything waiting?". The revision a
frame was written at is in its own first line (`[memory rev 12]`), so the
state travels with the conversation and syncs with it.

Two things follow, and both are load-bearing: nothing memory-shaped may be
re-retrieved per turn (that would rewrite the prefix), and the memory tools are
offered only when memory is on, so the prompt section and the toolset cannot
disagree.

There is exactly one deliberate exception: **compaction** (`compact.rs`). When a
conversation reaches its share of the window, the older turns are summarized into
one hidden `compaction` message parked where the cut happened, and every later
request starts from that summary. It is the only operation that drops the
prefix, which is why it happens rarely, once per crossing, and never mid-turn.

The trailing frame is sent as a `system` message: that is the right shape, and
every endpoint Hook has been pointed at accepts it. If one refuses, the turn is
retried with the same text as a `user` message and the refusal is remembered for
the rest of the session (`context_role_off` in `AppState`) — the same
self-healing that already exists for endpoints that reject image parts.
`[memory] context_role` sets it up front for a build that already knows.

## Project memory lives in the repository

`remember_in_project` writes a line into the project's own `AGENTS.md`, inside a
marked block:

```markdown
<!-- hook:memory Hook keeps these for coding agents; edits inside these markers are overwritten -->
- Use pnpm, not npm.
<!-- /hook:memory -->
```

`pi` already reads `AGENTS.md` from the folder it runs in, so the note reaches
every future coding agent with no new mechanism, and it travels with the code to
every computer through git. Only the block is Hook's: the rest of the file is
the user's and is left byte for byte alone. The block is capped at 40 lines,
oldest dropped. This is project knowledge ("how this repo is built and tested"),
not a fact about the person, so it is not in the account store.

## Recalling a conversation

`search_past_chats` runs the same search as the chat list over every stored
conversation on this machine and returns titles and snippets. It is the
"reference chat history" half of memory: no writes, no extra prompt, and the
agent uses it when the user refers to something from another chat. It is also
how an imported history becomes useful — ask the chat what it learned from the
import and it can search and remember the durable parts.

## What the tests cover

`crates/hook-core/src/memory.rs` covers the store (accounts are isolated, a
repeated fact updates instead of piling up, the pinned budget holds, deltas list
only what changed, a synced entry reaches an open chat). `turn.rs` covers the
frame rules (told once, then only what changed; a frame is not a pending note;
the instructions never move). `projects.rs` covers the `AGENTS.md` block
(marked, merged, capped, never touching the user's own text). `server/sync.test.mjs`
covers the sync half (newest wins, tombstones, an unshaped entry is refused,
deleting the account clears memory).

---

[Documentation](README.md) · [Hook](../README.md)
