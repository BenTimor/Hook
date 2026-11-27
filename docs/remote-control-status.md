# Remote control — what exists, what is missing, what is next

**Status:** foundation, remote chat-agent runs, remote direct coding chats and
remote project creation are implemented, committed (`a169817`), pushed to `main`
and deployed by the `Deploy waitlist` workflow. A live relay E2E passed against
`hookcode.io` on 2026-11-22: presence, `projects.create`, `coding.create` /
`fetch` / `send` / `rename` / `stop`, a live event, stub sync, the full-chat
refusal, the wildcard preview tunnel and the offline answer. The test used a
throwaway account and a scripted host, then removed both.

The desktop and phone installers have not been rebuilt or published from this
commit; the deployed part is the account service. The VPS preview certificate
and Caddy block were already live.

**Scope of this document:** the "Your machines" feature — devices, the relay,
running coding agents on another computer, live chat/agent events and remote
previews. It is a handoff, not user documentation; the user-facing copy lives in
[`machines.md`](machines.md).

---

## 1. The shape we settled on

- **A chat is not bound to a machine.** The chat agent runs wherever the user is
  typing, and it can start agents on any of the account's machines. Binding is
  per **agent run**, not per conversation.
- **Every agent operation names a machine**, even when there is only one. This is
  a required tool argument and is part of the conversation history, so a later
  turn (on any device) can see where work happened.
- **Only Hook hosts agents.** Hook Workspace and HookCode are controllers: they
  send commands to a Hook host and watch the result. Workspace is no longer a
  local `pi` host. "This computer" in Workspace is forwarded to the local Hook
  process; if Hook is not running, Workspace cannot start an agent there.
- **A direct coding chat (the user talking to `pi` themselves) is machine-bound**
  by nature. This is the one place where "choose the machine at creation" is
  visible. The host owns the folder, the engine and the session. Only a stub
  travels through the account; another device fetches the transcript over the
  relay and keeps a local, non-uploading cache.
- **Remote control is paid only and requires cloud sync ON.** The relay, the
  device endpoints and preview tickets all use the same gate. A free account
  with its own model endpoint can still run agents locally; it cannot reach
  another machine.
- **Previews are tunnelled through the account service**, on
  `<ticket>.preview.hookcode.io`. The host dials out; no inbound port, no
  forwarded port. The subdomain gives the page its own origin and makes
  root-relative asset paths work.
- **The host stays alive in the tray.** Closing Hook's window hides it while the
  tray icon keeps the machine reachable; **Quit Hook** in the tray stops the
  agents. The phone and Workspace have no tray and do not host.

The contract is `docs/relay-protocol.md`.

---

## 2. What was implemented

### 2.1 Account service (`server/`)

- **Device registry**
  - `devices` table in `server/api.mjs`: name, kind, platform, arch, app version,
    product, `can_host`, capabilities, specs, `remote_allowed`, last seen.
  - `server/devices.mjs`:
    - `GET /api/devices`
    - `PATCH /api/devices/:id` — rename, accept-remote-work switch
    - `DELETE /api/devices/:id` — forget the machine and revoke its app/git tokens
    - in-memory `presence` (online / host-online) merged into the rows at read
      time
  - `server/plans.mjs`: `remoteRefusal()` — paid plan, cloud sync on.
- **Relay**
  - `server/relay.mjs`: WebSocket at `/api/relay`.
  - Roles: **host** (Hook / headless) and **controller** (Workspace / phone).
    A command for a device goes to its host connection.
  - `hello` registration, presence broadcasts, chat subscriptions, RPC routing
    with per-caller answer mapping, 60 s timeout, per-chat fan-out.
  - 8 MB frame cap, 240 frames/minute, heartbeat, best-effort events.
  - No conversation content is stored; sync remains the durable path.
- **Direct-chat stubs**
  - `sync_remote_chats` in `server/api.mjs`: id, owning device, title, state,
    message count, timestamps, deleted.
  - `POST /api/sync/remote-chats` (in `server/sync.mjs`): the token's device is
    the only writer of a stub. Another device gets `not_owner` instead of
    overwriting it.
  - `GET /api/sync/changes` adds `kind:"remoteChat"`, with the device's current
    name joined from the registry. No message body, folder or session.
  - A full chat with `meta.kind === "coding"` is refused, so no client can turn
    a direct chat into an account conversation.
- **Preview tunnel**
  - `server/preview-tunnel.mjs`:
    - `POST /api/remote/preview/ticket` returns
      `https://<ticket>.preview.hookcode.io/<file>`.
    - The ticket is bound to (account, machine, chat), expires after 6 h.
    - Requests on `*.preview.hookcode.io` are forwarded to the machine's host
      connection as `previewRequest` frames; the host answers with a base64 body.
    - GET/HEAD only, 4 MB body cap, no-store.
  - `server/waitlist.mjs` mounts the host middleware before the site.
- **Auth/sync integration**
  - The token row's `device_id` is checked against the hello.
  - `POST /api/auth/preferences` closes the account's relay sockets when cloud
    sync is turned off.
- **Tests**
  - `server/relay.test.mjs`: paid gate, presence, host/controller roles, rename,
    RPC routing, offline/disabled answers, publish/subscribe, removal/revocation.
  - `server/preview.test.mjs`: ticket minting, tunneled request/response, free
    and offline refusal.
  - `server/sync.test.mjs`: a stub's ownership and tombstone, the refusal of a
    full coding chat, and the free-plan gate on the stub route.

### 2.2 Rust core (`crates/hook-core/`)

- `devices.rs`
  - `DeviceProfile` (what a machine sends on hello), `DeviceView` (what the UI
    reads), default name, platform/arch, capability summary, coarse specs.
  - REST helpers for rename / remote switch / remove / preview ticket.
- `relay.rs`
  - Outbound WebSocket client (`tokio-tungstenite`, rustls).
  - Reconnect with backoff; re-sends hello and subscriptions; policy re-check
    while connected.
  - Presence cache and `hook://devices`; RPC pending map; chat subscriptions;
    `publish`.
  - Inbound chat events, agent-overview events, preview open/close, preview
    request handling (serves the active preview over the tunnel).
  - Preview ticket cache per (device, chat, file) so a reloading page does not
    mint a ticket every 600 ms.
- `remote.rs`
  - Host-side RPC methods: `agent.start`, `agent.status`, `agent.list`,
    `agent.steer`, `agent.answer`, `agent.stop`, `agent.stopChat`,
    `projects.list`, `folders.browse`, `folders.pin`, `sessions.list`.
  - `coding.create`, `coding.fetch`, `coding.send`, `coding.stop`,
    `coding.answer`, `coding.rename`, `coding.delete`, `coding.compact`: the host
    half of a direct chat. `create` takes a project name or a folder path; `fetch` marks the chat
    watched so its records are mirrored from then on; `delete` removes the
    original here (and queues its stub tombstone) on behalf of any device of the
    account that can reach this one.
  - `folders.browse`: one level of this machine's folders, directories only,
    for a controller that starts a chat outside the projects list. An empty
    `path` lists the folders starred on this machine and then the places
    browsing starts from; every entry says whether it is starred. The answer is
    never a file's contents.
  - `folders.pin`: star or unstar one of those folders. The star is this
    machine's own (`settings.json`, so it survives a restart and is the same
    list for every controller), and the answer is the whole list.
  - `projects.create`: create a project folder on the host from a name and an
    optional description. The host chooses the path; the caller cannot send
    one. The folder joins the account through the normal project sync.
  - Merges a controller's chat snapshot by message id before starting, so the
    host's chat agent can answer the run's note without waiting for sync.
  - Marks the chat remote and publishes the agent overview.
- `tools.rs` / `turn.rs`
  - `list_machines` tool; **required `machine`** on every agent tool.
  - Machine resolution: exact name/id, "this computer" aliases, substring match
    only when unambiguous; clear errors for offline/not-a-host.
  - `coding::send_with_id` lets a controller choose the user message's id, so a
    message appears once on both sides of the relay. `coding::create` stamps
    the owning device; `own_coding` adopts chats written before machines
    existed.
  - Remote starts send the chat snapshot; remote status/steer/answer/stop/list/
    sessions/projects travel by RPC.
  - `execute_async` routes machine tools; local tools stay synchronous.
  - Prompt: machine selection rules, always name the machine, plain language,
    no ids/ports. A controller is told it cannot run agents itself.
  - Activity labels include the machine ("Starting work on …").
- `agent.rs`
  - `AgentInfo` / `AgentSummary` carry `deviceId` / `deviceName`.
  - `set_device_name` follows the account's rename.
- `lib.rs`
  - Relay created before the preview emitter; preview events are mirrored to the
    relay.
  - Agent overviews are mirrored to every remote chat.
  - Tray/background mode, gated by a new `tray` feature enabled only by the
    desktop chat app (so the phone does not link `tray-icon`).
- `preview.rs`
  - `PreviewManager::fetch(chat, path)` serves the active page for the tunnel
    under the same root-containment rule as the loopback server.
  - `ChatMeta.deviceId` / `deviceName` / `remote` / `stubState`: the owner's
    identity and a viewer's cache marker. A cached chat preserves its messages
    when a stub changes; the stub keeps the host's message count.
  - `show_preview` now accepts any HTML file, absolute or relative; the preview
    root is that file's folder.
- `guard` / prompt
  - `show_preview` guidance says any page on the machine.
  - The coding-agent prompt says `sync_pull` / `sync_push` only cover the folder
    the run started in; other folders are the agent's own git business.

### 2.3 UI

- `packages/chat/src/MachinesSection.tsx` (shared by Hook and HookCode):
  online dot, kind, platform, version, cores/projects, "this computer", "runs
  agents", inline rename, accept-remote-work switch, remove.
- Hook Settings → **Your machines**; HookCode Settings → **Your machines**.
- `hook://devices` event, `devices_list` / `device_rename` /
  `device_set_remote` / `device_remove`, `subscribe_chat` / `unsubscribe_chat`.
- Agent board and tree show the machine; Stop asks remote hosts in addition to
  the local one (`stop_remote_agent`).
- Remote preview URL is used by the desktop `PreviewPanel`; the phone
  `PreviewSheet` renders a page in an iframe (previously it had no page branch).
- `RemoteChatDialog` (shared): pick a host and one of its projects, or create a
  project there with **New project**. Hook's New chat menu has **Coding agent on
  another machine…**; HookCode's home screen has **Code on a machine**. Remote
  chats show the machine in the row and in the header, and the pane chip says
  **On <machine>** (with **· offline** when the relay is down). A remote chat
  hides Delete and Change folder; those belong to the host.
- `ChatTransport` (Workspace dock) subscribes to the open chat so the quick
  access sees live remote updates.
- Mock/demo data for the Machines list in both apps.

### 2.4 Infrastructure

- `infra/preview.caddy` — `*.preview.hookcode.io` with the wildcard certificate.
- `infra/hook-preview-cert.cron` — certbot Cloudflare DNS-01 renewal + Caddy
  reload, installed as `/etc/cron.d/hook-preview-cert`.
- `scripts/deploy-waitlist.sh` uploads both and reloads Caddy when changed.
- DNS: `*.preview` A record → the VPS, DNS-only.
- Cloudflare token: `/opt/hook-web/cloudflare.ini` (`0600`) and
  `~/.cloudflare.ini` locally; not in the repo. It is an **account-owned**
  token (`cfat_`); `/user/tokens/verify` 401 is expected for those. Verified
  Zone:Read + Zone:DNS:Edit by creating and deleting a TXT record.
- Wildcard certificate issued and served; `https://test.preview.hookcode.io/`
  has a valid Let's Encrypt certificate.

### 2.5 Docs

- `docs/relay-protocol.md` — frames, roles, RPC, presence, limits, REST.
- `docs/machines.md`, `docs/plans.md`, `docs/mobile.md`, `docs/tests.md` —
  user-facing copy, the free-plan/cloud-sync rule, the phone preview.
- `AGENTS.md` — new modules, `remote_agents` capability, remote-control touch
  points, preview rule.
- `infra/README.md` — devices/relay/preview routes, wildcard certificate runbook.

---

## 3. Verification performed

- `pnpm typecheck` — pass.
- `pnpm waitlist:test` — 98 passing, including `relay.test.mjs`,
  `preview.test.mjs` and the new stub test in `sync.test.mjs`.
- `cargo test -p hook-core` — 201 unit + integration tests passing, including
  the stub/cache store tests.
- `cargo check --workspace` — pass (Hook, Workspace, HookCode).
- `pnpm test:licenses` — pass (`ws`, `tokio-tungstenite`, `base64` are
  MIT/Apache-compatible).
- `git diff --check` — clean. Line endings were normalised back to LF.
- Caddy `validate` / `reload` on the VPS — valid configuration; certificate
  served.

Live E2E: a throwaway account and two tokens were created directly in the
production database, a scripted host and controller connected to
`wss://hookcode.io/api/relay`, and the deployed service was exercised end to end.
The host emulated the Rust RPC answers; this proves the wire format, auth,
routing, sync and preview tunnel, not the Tauri host handlers themselves. Those
are covered by `cargo test` and the local build. Both tokens, the account, the
device rows and the test stub were removed afterwards.

---

## 4. Remaining work and limits

### 4.1 Direct coding chats on a remote machine (implemented; limits)

A controller can now create a direct chat on a host, see it in the list from any
device, fetch its transcript over the relay, watch it live, send, steer, stop,
rename and delete. The host's project must already exist, or a folder is picked
on it through `folders.browse` (folders starred there open the list). The
implementation follows
the shape above:

1. `projects.create` on the host creates a project folder from a name and an
   optional description; `coding.create` resolves an existing project inside
   the host's projects folder and creates the chat there. Or the controller
   walks the host's folders with `folders.browse` and passes the path it
   reached, so a remote chat can start anywhere the local picker can. A
   project is still a name only: the caller never sends its path.
2. The host pushes a stub (id, title, machine, state, message count) through
   `POST /api/sync/remote-chats`. A full coding chat is refused by the server.
3. A viewing device gets the stub as a `remoteChat` change, stores a chat with
   no messages and `remote: true`, and shows it in the list.
4. Opening it calls `coding.fetch`; the host marks the chat watched and returns
   the transcript. The viewer saves it as a remote cache, which the sync engine
   treats as local-only.
5. While open, the host publishes the same coding records it uses locally, so
   the viewer draws thinking, tool calls and the plan with the existing thread.
6. Sending uses `coding.send` with a generated message id; stopping and
   answering use the matching RPCs. If the host is off, the cache still opens
   and the chip says **offline**; a new message reports the failure.
7. Deleting goes to the host: `coding.delete` removes the original there and
   queues the stub tombstone, and the controller then drops its cache. The
   viewer needs the host to be online, because the folder and the session are
   there; a viewer's delete used to be refused outright.

Known limits (do not mistake them for bugs):

- **Full transcript, not windowed.** A very large direct chat could exceed the
  relay's 8 MB frame. Windowing is the next hardening step.
- **A folder browser, one level at a time.** A remote project is a name plus
  an optional description; the host chooses the folder under its projects
  directory. A remote *folder* is a path the controller reached through
  `folders.browse`, which lists directories only and never a file's contents;
  `coding.create` accepts either. Folders starred on the host (`folders.pin`)
  come first in that list, so the picker opens on the folders a person actually
  starts chats in. Changing an existing chat's folder stays a host action.
- **Coarse durable state.** The stub records `idle`, `running` or `error` from
  the last message. `needs_input` and the live plan come from the relay while
  the chat is open; a late viewer may see `idle` until it fetches.
- **The cache is a cache.** Deleting a cached conversation asks its host to
  delete the original, and removes the copy here once that succeeded. With the
  host offline the command says so and the copy stays; there is no
  "hide it here" mode, because the next stub sync would bring it back.
- **No automatic "continue on this machine".** Opening a cached chat never
  starts a local engine; that would be a second owner.
- **The host does not need advanced mode for a remote create.** The controller's
  paid, sync-enabled account and the host's accept-remote-work switch are the
  gate; a host with advanced mode off can still be asked to run a chat.
- **The live E2E used a scripted host, not two real apps.** The server, relay,
  gates, sync and preview tunnel were exercised against production; the Rust
  host handlers were compiled and unit-tested but a real desktop-to-phone run is
  still the best final check.
- **Stub failures are non-fatal.** An older account service without the route
  logs once per cycle and ordinary chat sync continues.

### 4.2 Headless `hookd` and Linux

- **The prerequisite is done**, and not by a `hookd` binary: Hook Browser's host
  (`crates/hook-host`) needed the same thing, so the split was made for it.
  `AppState` holds `events::EventSink` instead of an `AppHandle`, `rt` owns the
  tokio handle, `boot::start(StartOptions)` builds the whole backend, `state.rs`
  and `session.rs` hold what the IPC, the channel and the relay all drive, and
  Tauri is an optional `desktop` feature (`cargo test -p hook-core
  --no-default-features` is the windowless gate). `hook-core` now runs with no
  window, and `crates/hook-host` is a working example of a windowless binary
  linking it — see `docs/browser-host.md`.
- `hookd` itself is still not written. What it needs beyond `hook-host`: a
  `Product`/`Capabilities` pair for "this machine hosts agents" (`can_host`), the
  device-flow `hookd login` printed on a terminal, `hookd run` in the foreground,
  and systemd/Docker packaging. Copying `crates/hook-host/src/main.rs` is the
  starting point, not a rewrite.
- Linux desktop (deb/AppImage) is deferred; headless first.

### 4.3 Smaller gaps

- **Workspace has no Machines settings UI.** Its chat agent can use machines;
  the user cannot see or rename them there yet.
- **The phone has no agent plan board.** It receives live chat text and can
  steer/stop through the chat agent; a compact board is not built.
- **`ChatMeta.runs` history** (a bounded list of past runs with machine and
  plan) is not implemented. Live agent state is in `agents.json`/`hook://agents`;
  durable history is the chat messages/tool calls.
- **Live mirroring is for a remote-marked chat** (an agent run or a direct
  chat). A normal chat turn on another device arrives through sync when it
  finishes, not delta by delta. Marking every turn would send all chat text over
  the relay even when nobody is watching; a subscription notice is the cleaner
  fix if normal-chat live view becomes a requirement.
- **A late viewer misses the current preview and agent board.** Events are
  ephemeral; if a device opens a chat after the host showed a preview, there is
  no snapshot request yet. The same applies to a run started before the viewer
  subscribed. A `preview.state` / `agent.list` snapshot on open would fix it.
- **Attachments in a remote start snapshot** are metadata; the host may not
  have the image bytes until sync pulls them. The wake turn may not see a very
  recent picture.
- **Two chat agents in one chat** (a controller's local turn and the host's wake
  turn) are possible; messages merge by id, but the live UI may briefly
  interleave. A per-chat turn lease is the hardening option.
- **Tray discoverability:** closing Hook now hides it; there is no
  "keep running in the background" setting or first-run hint yet. Quit is in
  the tray menu.
- **Relay is single-process and in-memory.** A deploy drops every socket;
  clients reconnect. Presence resets; `last_seen` is the fallback. Multiple
  instances would need a pub/sub layer.
- **Free-with-BYOK** still runs local agents. `list_machines` shows the paid
  refusal; "this computer" works locally. Remote stays paid.
- **`list_projects`, `create_project` and `delete_project` on the phone** name a
  machine; `create_project` travels as `projects.create` and `delete_project` as
  `projects.delete`. `update_project_description`
  and `remember_in_project` are still local-only and removed on the phone.
- **A remote direct chat can be renamed, steered and stopped from any device;
  the folder change and the delete stay on the host.** See 4.1 for why.
- **Server deployment**: the API code, Rust changes and UI are local. The relay
  endpoint does not exist on hookcode.io until deployed. Caddy already points
  the preview subdomain at the container.

---

## 5. Deployment runbook (account service executed)

The account service was deployed by pushing `a169817`; the `Deploy waitlist`
workflow ran `pnpm waitlist:test`, built the site and deployed the container.
The steps below remain the complete runbook for a manual deploy and for the apps.

1. Review and commit the working tree (AGENTS.md: commit/push only when asked).
2. Deploy the account service:
   ```bash
   ./scripts/deploy-waitlist.sh
   ```
   This rebuilds the container, installs `preview.caddy` and the renewal cron,
   and reloads Caddy. It is a production deploy; do not run it casually.
3. Build and publish the apps (`pnpm app:build`, `pnpm workspace:app:build`, the
   mobile store builds). The tray feature is enabled only in `apps/chat`. These
   installers were not rebuilt from this commit.
4. Smoke test:
   - Sign in on two machines, open Settings → Your machines: both appear, named,
     with the correct online state.
   - Start a small task from the phone; the desktop's agent starts; the phone
     sees the plan/reply; Stop works from both.
   - From the phone, start a direct coding chat on the desktop in one of its
     projects; send, steer and stop it. Close the desktop's Hook window (the
     tray keeps it alive), reopen the phone chat (cache), then quit Hook and
     confirm the phone keeps the cached transcript and says **offline**.
     Delete the chat on the desktop and confirm it disappears from the phone.
   - Point `show_preview` at a page on the desktop; the phone's preview sheet
     loads it over `*.preview.hookcode.io`.
   - Turn the desktop's "accept remote work" off; the phone gets a clear error.
   - Turn cloud sync off; both relay sockets close and the UI shows the refusal.

Certificate renewal is already installed. Check it with:
`docker exec scout-caddy-1 caddy validate --config /etc/caddy/Caddyfile` and
`openssl s_client -connect test.preview.hookcode.io:443`.

---

## 6. Recommended next step

**Headless `hookd`**, because the direct-chat path demonstrates that a host does
not need a window — and because the split it used to be blocked on is now real:

1. ~~Split the Tauri-specific parts of `hook-core` behind a small runtime trait:
   event sink, data directory, tray/window, and the IPC surface.~~ Done in
   `crates/hook-host`'s change: `events.rs`, `rt.rs`, `state.rs`, `session.rs`,
   `boot.rs`, and Tauri behind the `desktop` feature. `SyncEngine`,
   `RelayClient`, `AgentManager`, `PreviewManager` and `coding` needed no change
   beyond the event sink.
2. Add a `hookd` binary with `hookd login` (device flow, printing the code),
   `hookd run` and a foreground mode for systemd/Docker. It registers the same
   `DeviceProfile` with `product: "headless"` and `can_host`. `crates/hook-host`
   is the template: a `tokio` runtime, `rt::set`, `product_data_dir`, `start`,
   `shutdown` on ctrl-c.
3. Run the same relay host, sync engine, agent manager and direct-chat handlers.
   No tray, no window, no installer; closing the terminal stops it.
4. Package it (systemd unit and a tiny Docker image), then smoke-test the phone
   starting a run and opening a direct chat on it.
5. Linux desktop (deb/AppImage) follows once the headless split is real.

After that, hardening: preview/agent snapshots for late viewers, windowed
transcript fetches, a per-chat turn lease, and an end-to-end relay test.
