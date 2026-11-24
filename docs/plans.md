# Plans, limits and your own model

The free plan, the account-wide sync switch, a personal model endpoint, and the analytics around them.

One column decides what an account may do: `waitlist_signups.plan`, one of
`free`, `plus` or `pro`. The waitlist itself is unchanged: a row that has not
been approved has **no plan** and cannot sign in. Approval is what assigns one,
and with no choice made that plan is `free`; every account that was already
approved before plans existed starts free on the migration. Assigning a plan
is a single row:

```bash
./scripts/waitlist-admin.sh --plan someone@example.com pro
./scripts/waitlist-admin.sh --plan someone@example.com free
./scripts/waitlist-admin.sh --plans
```

The app learns the plan from `/api/auth/me` and re-checks it every minute while
it is open (and when the window gains focus), so a change takes effect without a
restart. The server is the authority on every request; the client-side checks
exist so the user reads a sentence instead of an HTTP error.

## The free plan

- **No cloud sync.** Conversations, projects, memories, pictures and code
  repositories stay on the computer. The sync and git endpoints refuse the
  account (`sync_not_included`), and the sidebar marks each chat as not in the
  cloud. `DELETE /api/sync/account` still
  works, so someone who moved to free can delete what was already stored.
- **100 messages per rolling 24 hours.** Counts user messages, not model
  requests: every call of one turn (tool round-trips included) carries the same
  `X-Hook-Message-Id`, and the proxy counts distinct ids. Regenerating or editing
  a message does not spend a second slot. The window rolls, so nothing resets at
  a wall-clock hour; `/api/auth/me` reports `quota.resetAt`.
- **No coding agents or remote control.** The backend refuses to create one, the
  chat agent's toolset omits the agent tools, and the proxy refuses
  `X-Hook-Surface: coding`. Running work on another machine is also paid-only,
  and needs cloud sync on.
- **Normal chats, Hook Workspace and integrations are unaffected.** Workspace
  data lives on the account by design; the free plan does not restrict it.

A free account that sets its own model endpoint (below) is not metered by Hook
and may use coding agents.

## Cloud sync is an account switch

A paid account may turn sync off in **Settings → Advanced** (Hook), the Settings
sheet (HookCode) or the Settings dialog (Hook Workspace). The switch is stored on
the account, not in a product's settings file, so turning it off in one product
turns it off in all of them. While it is off the sync endpoints refuse that
account (`sync_disabled`), nothing new is uploaded, and every conversation is
marked **not in the cloud** — the mark explains why when clicked. Already-synced
data stays on the account until it is deleted. While it is off the live relay
refuses the account too, so no other device can reach this machine's agents.
`DELETE /api/sync/account` remains available.

The personal model endpoint follows the same switch: while sync is off (or on
the free plan) `/api/provider` refuses the account and the key stays on the
device that typed it. See [Your own model endpoint](plans.md#your-own-model-endpoint-all-plans).

## Your own model endpoint (all plans)

Settings has a **Model access** section: an OpenAI-compatible base URL (for
example `https://api.openai.com/v1`), an API key and a model name. **Load models**
asks `GET <base>/models`, and the model field is a searchable list that still
accepts a typed name, because a gateway may not implement `/models` or may return
the wrong set.

- **Stored locally, then shared if the account may sync.** The key is written to
  that product's `settings.json` (`%APPDATA%\app.hook.chat\settings.json`, the
  Workspace folder, or the phone's app container). A **paid account with cloud
  sync on** also gets one copy on the account
  (`account_provider`, `server/provider.mjs`), so the phone and Hook Workspace
  use the endpoint without the key being typed again. The other two cases — the
  free plan and an account whose sync switch is off — keep it on the device that
  typed it: those routes answer `sync_not_included` / `sync_disabled`, exactly
  as the sync routes do.
- **Encrypted at rest.** The account never stores the key in the clear. It is
  AES-256-GCM ciphertext whose additional data is the account subject, with the
  key derived (HKDF-SHA256) from the deployment's `HOOK_PROVIDER_SECRET`; a
  database row is useless without that secret, and a row copied to another
  account cannot be opened. Without the secret the service refuses to store one
  and every app keeps its key local. It is never logged, never attached to an
  analytics event, and `GET /api/provider` returns metadata only — the key has
  its own `no-store` route, read only by a device that is adopting it.
- **Last write wins, and a clear travels.** The changing device sends the
  timestamp it recorded when the endpoint was saved or removed; an older stamp
  never overwrites a newer one, and removing it on one device removes it on the
  others (the row keeps a tombstone with its fields emptied). Syncing follows
  `sync.json`'s cycle: save on the phone, and the next cycle adopts it on the
  computer and asks the new endpoint what its models can see.
- **A key belongs to the account that typed it.** `settings.json` records which
  account the endpoint was entered or adopted under. If someone else signs in on
  the same computer, the endpoint keeps working there — it always has — but it is
  neither uploaded to that account nor replaced by it. A key written before this
  was recorded is claimed by the first account that syncs it, so an endpoint
  someone already had still reaches their phone.
- **The app talks to it directly.** Chat turns and coding agents send the model
  request to that endpoint with that key. Hook's proxy never sees them, which is
  why the free message limit does not apply and why coding agents become
  available to a free account.
- **Hooked in everywhere it matters.** `ProviderTarget` in `provider.rs` resolves
  one destination per turn: Hook's service or the personal endpoint. The chat
  turn, the coding engine's `models.json` (`$HOOK_PROVIDER_TOKEN`, no Hook
  headers), the capability probe and the model list all use the same resolution.
  Removing the provider goes back to Hook's models.
- **Disclosed where it is entered.** The Settings copy states where the key is
  stored, whether the account is sharing it, that it only goes to that endpoint,
  and what turning cloud sync off means for it.
- **On Unix the settings file is `0600`**, because a key is a secret. On Windows
  `%APPDATA%` is already per-user, and on a phone the file is in the app's own
  container.

## Analytics

`usage_events` records the plan in force with each proxied request, so usage can
be read by plan. A personal endpoint never reaches the proxy, so the app reports
the facts the proxy cannot see to `POST /api/events` as one of a fixed set of
kinds — `byok_saved`, `byok_removed`, `byok_turn`, `byok_models_loaded`,
`quota_blocked`, `coding_blocked_free`, `sync_enabled`, `sync_disabled` — plus
the product and the app version. No message, path, endpoint or key is stored. To
see it:

```bash
./scripts/waitlist-admin.sh --events       # counts by kind and plan, then the last 20
./scripts/waitlist-admin.sh --plans        # accounts per plan, and how many turned sync off
./scripts/waitlist-admin.sh --usage        # token usage, now with PLAN
./scripts/waitlist-admin.sh --usage-plans  # usage grouped by the plan stored per request
```

---

[Documentation](README.md) · [Hook](../README.md)
