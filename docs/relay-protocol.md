# Hook relay protocol (v1)

The relay is how one of the user's devices drives work on another one. It is a
WebSocket hub at `/api/relay` on the account service. It routes **ephemeral**
frames: presence, commands, live chat/agent events and preview requests. It is
not a second store: conversations still travel through `/api/sync`, and a viewer
that missed frames catches up by reloading the chat.

The machine that actually runs an agent is the **host**. Every other device is a
**controller**. Hook (the chat app) and `hookd` are hosts; HookCode on a phone
and Hook Workspace are controllers. A machine can have one host connection and
any number of controller connections — Hook and Workspace on the same computer
share one device id, and a command for that machine always goes to the host.

## Connecting

```
wss://hookcode.io/api/relay
Authorization: Bearer <app token>
x-hook-device: <device id from account.json>
```

The server resolves the token with `apiUser` (scope `app`), checks the account
may use remote control (`plan != free`, `cloud_sync != 0`), and verifies the
device id matches the token row when one is recorded. A refused connection is
answered before the upgrade with the usual JSON error shape.

The first frame must be `hello`:

```json
{
  "v": 1,
  "kind": "hello",
  "device": {
    "id": "dev_...",
    "name": "Ben's PC",
    "kind": "desktop",
    "platform": "windows",
    "arch": "x86_64",
    "appVersion": "0.4.0",
    "product": "chat",
    "role": "host",
    "canHost": true,
    "capabilities": { "codingAgents": true, "projects": true, "previewPages": true },
    "specs": { "cpuCores": 16, "projects": 4 }
  }
}
```

`role` is `host` only when the product can run agents (`chat` or `headless`).
Anything else is a controller. `name` is used only when the account has never
seen this device; after that the server is authoritative and the UI reads it
from `GET /api/devices`. A host that has remote control switched off is present
but refuses commands.

## Frames

Every frame is one JSON object, tagged by `kind`. The server caps a frame at
512 KB, a controller at 240 frames per minute and a host at 1200: a host is the
connection that mirrors a running turn, and it coalesces deltas (`turn::emit`,
one relay frame per 400 ms) so a fast model cannot outrun that budget. A
connection over its cap is closed with `1008` and the frames it never sent are
gone — the host reconnects, but the gap is not replayed.

Client → server:

| kind | shape | meaning |
| --- | --- | --- |
| `hello` | above | Register this connection. Must be first. |
| `subscribe` | `{chatId}` | Watch live events for one chat. Idempotent. |
| `unsubscribe` | `{chatId}` | Stop watching it. |
| `rpc` | `{id, to, method, params}` | Ask a device's host to do something. |
| `rpcResult` | `{id, ok, result?, error?}` | Answer an RPC addressed to this host. |
| `publish` | `{chatId, payload}` | Fan out a live event to this chat's subscribers. Hosts only. |

Server → client:

| kind | shape | meaning |
| --- | --- | --- |
| `ready` | `{device}` | The account and the row are accepted. |
| `presence` | `{devices:[...]}` | The account's devices changed, or one's state did. |
| `event` | `{chatId, payload}` | A live event from the chat's host. |
| `rpc` | `{id, from, method, params}` | A controller asks this host to act. |
| `rpcResult` | `{id, ok, result?, error?}` | The answer to an RPC this device sent. |
| `error` | `{code, message, id?}` | A frame was refused. `id` names the RPC when one exists. |

`payload` inside `event` is owned by the app, not the relay. It is the same
`StreamEvent` / coding record / agent update the local supervisor emits, so the
renderer does not learn that the run is remote.

### RPC

- `to` is the target **device id**, not a connection. The server routes it to
  that device's host connection. If no host is online the caller gets
  `rpcResult {ok:false, error:{code:"device_offline"}}` immediately; v1 does not
  queue a command for a machine that is off.
- The server adds `from` (the caller's device id). The host answers with the
  same `id`; the server remembers which connection called and routes the result
  back there, so two controllers sharing a device id cannot see each other's
  answers.
- An unanswered RPC expires after 60 seconds and the caller gets `rpc_timeout`.
- `agent.start`, `agent.steer`, `agent.answer`, `agent.stop`, `agent.status`,
  `agent.list`, `projects.list`, `folders.browse`, `folders.pin`,
  `sessions.list`, `coding.create`,
  `coding.fetch`, `coding.send`, `coding.stop`, `coding.answer`,
  `coding.rename`, `coding.delete`, `coding.compact`, `projects.create`,
  `projects.delete`, `preview.open` are the method names v1 uses.
- `browser.tabs`, `browser.read`, `browser.find`, `browser.eval` and
  `browser.cdp` are answered by a machine running Hook Browser. The first three
  read a tab; `browser.eval` runs a script there with the page helpers installed,
  and `browser.cdp` sends one raw DevTools protocol command. They target a device
  by *browser*, not by `can_host`, because a browser is a controller rather than
  a place agents run. Their own budgets are set to fit under the 60-second RPC
  timeout below: a protocol call waits 50 seconds, and a script is stopped at 40.
- A `coding.*` method is handled by the machine that owns the direct coding
  chat. `coding.fetch` returns the whole conversation and marks the chat as
  watched, so its records are mirrored from then on. `coding.compact` asks the
  host to fold the engine's session into a summary (`instructions` is optional
  free text for what to keep); a run in progress is refused, because pi aborts
  it before compacting. `coding.create` accepts
  either a `project` (resolved inside the host's projects folder) or a `folder`
  (a full path the controller reached through `folders.browse`): the host
  resolves and validates the folder in both cases, and a folder outside the
  projects directory is allowed. `coding.delete` removes the original on the
  host — an owner's delete also queues the stub tombstone, which is what takes
  the chat off every other device. `projects.create` creates a folder there from
  a name and an optional description; the host chooses the path.
  `projects.delete` takes `{project}` — the name `projects.list` showed — and
  removes the account's row and the folder. The host refuses a folder that still
  holds files: work in a folder is the user's, and Hook deletes it only when it
  is an empty clone.
- `folders.browse` walks the host's directories one level per call, so a
  controller can start a chat in a folder that is not one of the account's
  projects. `{path}` is a full path; an empty or missing `path` answers the
  places browsing starts from: the host's starred folders, then `Home`,
  `Projects`, and on Windows the drives. The answer is directories only:

  ```json
  {
    "path": "C:\\Users\\me",
    "parent": "C:\\Users",
    "entries": [
      { "name": "Documents", "path": "C:\\Users\\me\\Documents", "pinned": true }
    ],
    "truncated": false
  }
  ```

  `truncated` says the level held more folders than one answer carries, and
  `pinned` says the host has starred that folder. No method returns a file's
  contents, and the caller never has to build a path: `parent` and each entry's
  `path` are the host's own canonical strings.
- `folders.pin` stars one directory so every controller sees it first next
  time: `{path, pinned}` answers `{ "pinned": ["C:\\Users\\me\\work", …] }`,
  the host's whole list in its own order. The star is stored on the host (in its
  `settings.json`, at most 12), never on the account, because a folder exists on
  one machine or nowhere.

### Presence

`devices` is the account's device rows, merged with the live connection map:

```json
{
  "id": "dev_...",
  "name": "Ben's PC",
  "kind": "desktop",
  "platform": "windows",
  "arch": "x86_64",
  "appVersion": "0.4.0",
  "product": "chat",
  "canHost": true,
  "online": true,
  "hostOnline": true,
  "role": "host",
  "remoteAllowed": true,
  "lastSeen": "2026-11-22T09:45:14.000Z",
  "capabilities": { "codingAgents": true },
  "specs": { "cpuCores": 16, "projects": 4 }
}
```

`online` means any connection for that device is open; `hostOnline` means the
machine can accept agent commands right now. A machine that is only running
Workspace is online but not a host, and the UI must not offer it as a target.

## REST

All routes are under `/api`, need an app token, and use the same paid + sync-on
gate as the socket.

| route | meaning |
| --- | --- |
| `GET /api/devices` | `{devices:[...]}` — online and offline, newest first. |
| `PATCH /api/devices/:id` | `{name?, remoteAllowed?}` — rename, or stop this machine accepting remote commands. |
| `DELETE /api/devices/:id` | Forget the device and revoke every token it held. |

The server never stores chat content in these routes. A device row is a name, a
shape, a version, a capability summary and a last-seen time.

## Direct coding-chat stubs

A direct coding chat is a conversation with an engine, not with Hook. Its
transcript, folder and session stay on the machine that runs it. The account
only needs to know that the chat exists, which host owns it, what it is called
and whether it is running:

| route | meaning |
| --- | --- |
| `POST /api/sync/remote-chats` | `{chats:[{id,title,createdAt,updatedAt,state,messageCount,deleted}]}`. The device on the token is the owner. A different device may not overwrite an existing stub. |
| `GET /api/sync/changes` | Adds `kind:"remoteChat"` records with `deviceId`, `deviceName`, `title`, `state`, `messageCount`, `createdAt`, `updatedAt` and `deleted`. No `chat` body. |

The stub is not a second copy of anything: it holds no message, no `projectPath`
and no `sessionId`. The server refuses a full chat whose `meta.kind` is
`"coding"`, so that rule cannot be forgotten by a client. A viewer asks the
owner for the transcript with `coding.fetch` over the socket, caches it locally
and never pushes it back. The cache is marked `remote`, which is also why the
sync engine treats it as local-only.

A stub push is best-effort: an account service that predates the route must not
stop ordinary chats from syncing. The client logs the failure and tries again on
the next cycle.

## Limits and failure

- A deploy restarts the process and drops every socket. Clients reconnect with
  jitter, re-send `hello` and their subscriptions, and re-fetch presence.
- Presence is in memory; `lastSeen` is in SQLite. A restart shows devices
  offline until they reconnect.
- Live frames are best-effort. A viewer that falls behind reloads the chat from
  `store`/sync instead of trying to replay a gap. That is also why a finished
  turn is never inferred from silence: the owner's transcript decides whether
  anything is still streaming.
- Nothing in a frame is logged. The relay logs connection counts and error
  codes only.
