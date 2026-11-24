# One account, several products

One sign-in, one device id, one relay — and how a device proves who it is.

## What the products share

Hook is a family of products that share one account, and the account is the
family's centre of gravity:

- **One sign-in.** `%APPDATA%\app.hook\account.json` holds the session and this
  installation's device id. Any product reads it at launch, so installing the
  second one does not ask again. Signing out writes an empty session back, which
  signs out every product — it is an account decision, not a product one.
- **One device id per machine.** The server rotates a git token per
  `(account, device)` pair, so two products sharing an id look like one computer
  rather than two. Only the chat app mints git tokens; Workspace never does, so
  they cannot revoke each other. The account also keeps a small **machine
  registry** (`/api/devices`): the name, platform, app version, capabilities and
  last-seen time. No conversation or project content lives there.
- **One relay.** Every running product holds an outbound WebSocket to
  `/api/relay`. Hook and a headless install are hosts; Hook Workspace, the phone
  and Hook Browser's host are controllers. The phone can start and watch work on
  a computer without that computer accepting an inbound connection.
- **Capabilities, not forks.** The backend is a single crate (`hook-core`). A
  window passes `Product` and `Capabilities` to `hook_core::builder`; a product
  with no window — Hook Browser's host, `crates/hook-host` — links the same crate
  with `default-features = false` and calls `hook_core::start`. Either way the
  chat agent's prompt and toolset are trimmed to what that product can honour.
  Hook Workspace, for example, has no preview panel, so its agent is never told
  about one; the browser's host has no project folder, so it is never told about
  one either.
- **Capability behind the API first.** Anything a product can do is an endpoint
  before it is a button, which is what makes a second product usable through
  the chat agent alone — even when it is not installed.

Products share `packages/ui` (tokens, chrome, primitives) and `packages/chat`
(the chat surface), so "the same family" is enforced by the build.

## Desktop sign-in

Hook uses the OAuth device flow, which keeps the Google client secret on the
server and needs no custom URL scheme or local callback listener:

1. the app calls `POST /api/auth/device/start` and gets a secret device code plus
   a short code like `ABCD-EFGH`;
2. it opens `https://hookcode.io/authorize?code=ABCD-EFGH` in the system browser;
3. the user signs in with Google and approves the device — only an approved
   waitlist account can do this;
4. the app polls `POST /api/auth/device/poll` and receives an opaque `hk_…` token
   once. Only its SHA-256 hash is stored in SQLite.

The token lives in `%APPDATA%\app.hook\account.json`, which every Hook product on
the machine shares: signing in to one signs in all of them, and signing out of
one signs out all of them. Each product keeps its own `auth.json` mirror so a
downgrade still starts signed in. The chat agent sends the token
as a bearer token; the bundled pi runtime receives it through `HOOK_API_TOKEN`
and references it from its `models.json`. Signing out revokes the token on the
server and closes live coding agents.

A phone signs in with its **own account sheet** instead. `GET /api/auth/config`
answers the web client id (public, and it is in every page of the site), Android
Credential Manager shows the Google accounts on the device, and
`POST /api/auth/google` checks the ID token it returns against the same
`waitlist_signups` approval the device flow uses before minting the same kind of
`hk_…` token. Nothing leaves the app for the browser, and the app asks the
server for the client id rather than carrying one build's. The device flow stays
in the phone as "Use a code instead", and it is still the only path on desktop.

---

[Documentation](README.md) · [Hook](../README.md)
