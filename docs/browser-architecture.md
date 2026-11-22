# Hook Browser — architecture

> **Status: designed, not built.** Nothing in this document is implemented. It
> records the approach and the reasoning behind it so the decisions are not
> relitigated every few months. Feature UX is deliberately out of scope; the
> order of work for the first proof of concept is `docs/browser-poc-plan.md`.

**Hook Browser** is the third Hook product: a Chromium-based browser that is used
by the user and driven by agents, sharing the account, the backend, the design
system and the chat surface that `apps/chat` and `apps/workspace` already share.

Paths below are final, not placeholders: the overlay lives at `Hook/browser/`
and appears inside the Chromium checkout as `src/hook/`; `apps/browser` is held
for the product shell once the fork builds.

## Why Chromium

The deciding requirement is the **extension ecosystem**. Users expect their
existing extensions to work, which means `chrome.*` APIs and the Chrome Web
Store, which means shipping the real Chromium browser, not a webview.

Everything else was rejected on that ground or on maturity:

| Option | Why not |
| --- | --- |
| Tauri / WebView2 | Extensions are BYO-only, `edge://extensions` is blocked, and Google sign-in is blocked in embedded webviews. Not a browser. |
| Electron | No real extension support, plus Node in the main process. |
| CEF | Extensions are unpacked-only and partial; the whole browser UI is yours to rebuild. |
| Gecko / Firefox fork | Genuinely lighter above ~30 tabs, but no Chrome Web Store. |
| Servo / Ladybird | No extension model, not production-ready. |

Gecko was reconsidered on build speed — it builds in tens of minutes where
Chromium takes hours — and rejected on the licence. Gecko is MPL-2.0, which is
file-level copyleft: shipping a closed binary obliges us to publish our changes
to the MPL-covered files it contains. Chromium's BSD-3 asks only that notices be
kept, so Hook Browser can ship closed today and be opened on our own terms later.
Build time is a cost we pay; the licence is a constraint on the product.

The second reason is control: memory policy, ad blocking, tab lifecycle and
agent integration all live below the layer an extension can reach.

## Source architecture

Three layers. Keeping them separate is the entire maintenance strategy.

| Layer | Contents | Change policy |
| --- | --- | --- |
| **Upstream** | `chromium/src` at an exact tag | Never modified. Always pristine. |
| **Overlay** | A directory of brand-new files: our C++, mojom, WebUI, Rust, resources, tests | Ours, freely |
| **Patch surface** | Small edits to existing upstream files, only where the overlay must be reached | Minimal, reviewable, one hunk at a time |

### How the overlay is wired in

`gclient` pulls the overlay as a dependency, so after `gclient sync` it sits at
`src/hook/`. Chromium's GN build then needs to know it exists, which takes a
handful of lines in a handful of files — `chrome/browser/BUILD.gn` for deps,
`profile_keyed_service_factories.cc` to register services,
`chrome_browser_main.cc` to start them, the WebUI registration list, the `.grd`
string files, and one `ChromeContentBrowserClient` override where needed.

That is the whole patch surface: single-digit files, a few lines each. It is the
only thing that has to survive a Chromium upgrade.

### The rule

**The overlay contains new paths only. Never copy an upstream file into it.**

Copying `tab_strip.cc` into the overlay to "just tweak it" silently recreates the
merged fork we chose not to take, one file at a time, and nobody later knows
which copies are stale. If upstream behaviour must change, that is a patch —
visible, reviewable, revertable, and it fails loudly when upstream moves. The
overlay is new code; patches are edits. Do not blur them.

Corollary: build against `//chrome/browser` and `//components`, not `//content`
publics, and never patch `//content` or `//services/network`. Most of what would
be wanted there is already available as a virtual —
`ContentBrowserClient` / `ChromeContentBrowserClient`, `URLLoaderRequestInterceptor`,
`NavigationThrottle`, `WebContentsObserver`, `KeyedService`. Prefer a seam to a
patch; every patch avoided is merge surface that stops existing.

### Why a rebase and not a merge

Divergence is kept as a **small stack of commits rebased onto each new tag**,
not as one large merge. The failure mode we are avoiding is not conflict — it is
a merge that **applies cleanly and is semantically wrong**: our 40-line hook
resolves against a refactored API, compiles, and silently stops being called.
Nobody notices until a user does.

A rebase of 20 commits at 5–80 lines each is readable, individually revertable,
and bisectable. A 45,000-line merge across 1,400 files is none of those, and no
reviewer or model can meaningfully verify it.

## Repository layout

```
src/hook/
  browser/            C++ — agent controller, tab model, ad interception,
                      password store implementation
  common/             mojom IDL for the WebUI ↔ browser IPC
  app/                branding, icons, .grd strings, resources
  browser/resources/  WebUI: the React surfaces
  rust/               hook-core, Tauri-free, built as a rust_static_library
                      or run as an out-of-process binary
  tests/              our own browser tests
```

### Where the tree lives

The checkout is never committed: it is around 100 GB with its own `.git`, past
GitHub's per-file and per-push limits, and anything ignored is destroyed by
`git clean -xfd`. It sits outside the repository at a short root — Chromium's own
advice, because `third_party/…` paths hit `MAX_PATH` under a deep root — and the
overlay is a directory junction into it, so editing `Hook/browser/overlay/src/hook/…`
edits the bytes the build compiles. What is committed is the overlay, the patch
stack, the pinned tag and the scripts that materialise the tree; re-running
`browser/tools/sync.mjs` recreates the junction, which is the same wiring with
nothing to keep in step.

The overlay is expected to stay modest — tens of thousands of lines, not the
million that Brave's carries, because most product surface is WebUI and reused
packages rather than reimplemented subsystems.

## Build and dev loop

Chromium builds are slow only three times: the first build, a tag rebase, and a
release build. Everything else is seconds to a minute, if configured properly.

Dev `args.gn`:

```gn
is_debug = false
is_component_build = true   # the single biggest iteration win; dev only
symbol_level = 0
blink_symbol_level = 0
v8_symbol_level = 0
```

Notes that cost real time when discovered late:

- **Set the symbol levels before the first build.** Changing them forces a full
  recompile.
- **Build the `chrome` target, never `all`** — `all` drags in every test binary.
- **`fetch --no-history`** (or `--git-cache`) and, on an existing checkout, a
  `git repack -a -d -f` pass over `third_party`: `gclient sync` accretes thin
  packs forever and `git gc` only recovers ~13% of them. Together these take a
  one-platform checkout from ~150 GB to well under 100 GB.
- **Exclude the checkout from Windows Defender and indexing.** Chromium's own
  docs call Defender a frequent culprit; the difference is multiples, not
  percent.
- **Siso** is the build tool (it replaced Ninja for external developers). It can
  dispatch to a REAPI backend, but Google's free cluster does not cover Windows,
  so on Windows it is local Siso plus `sccache`.
- **CI needs a self-hosted runner with a persistent `out/`.** Incremental CI
  builds take minutes; ephemeral runners with no cache cannot hold a Chromium
  tree at all.
- **Rebases and releases happen on a rented many-core box**, overnight. At a
  handful of Chromium versions per quarter this is noise.

Most product work does not need a Chromium build. WebUI is TypeScript, and can
be developed against mocked mojo bindings in a normal browser — the same pattern
`apps/chat` already uses with `mock.ts`. `autoninja` after a WebUI change just
repacks resources.

## UI: Views versus WebUI

Chromium's frame, tabstrip, toolbar and omnibox dropdown are Views — native
C++/Skia. Settings, new tab, history, bookmarks, downloads and the side panel are
WebUI — TypeScript and web components in `chrome/browser/resources/`.

We take the same split: **Views for the frame, WebUI for everything that is a
surface.** Keeping the frame native avoids the permanent cost of a second UI
renderer (roughly 80–150 MB), which is what makes web-tech-UI browsers heavy. One
shared UI renderer, never one per window or per tab.

## Runtime integration with `hook-core`

`hook-core` is the backend every product links today. Two changes are needed
before the browser can use it:

1. **Split it from Tauri.** The browser has no Tauri; the crate must build
   without it.
2. **Run it out of process first.** A singleton process reached over the existing
   loopback bridge, not linked into the browser. It isolates crashes, keeps the
   tokio runtime out of the browser process, and reuses working code. Linking it
   in as a `rust_static_library` is supported — Chromium's Rust toolchain is no
   longer optional — but it is an optimisation to reach for only if latency
   demands it.

WebUI talks to the browser process over mojom bindings, which replaces the
`invoke` surface the Tauri products use. The browser process talks to `hook-core`
over the bridge.

What the user is looking at already has a channel: `set_chat_context`
(`commands.rs`) is read by `context_frame` (`turn.rs`) and appended as one
trailing message, which is the append-only-safe place for per-request state. The
browser reports the active tab's title, index, domain and highlight through the
same command; nothing about the prompt changes, and no browser tool is involved.

## Reuse

`packages/ui` (tokens, plain CSS) and `packages/chat` (`ChatDock`, `Thread`,
`MessageItem`, `Composer`) are React and are meant to have no host dependency, so
they compile into WebUI assets and render in a `chrome://` surface largely as-is.
Two module-scope imports currently break that claim — `packages/chat/src/open.ts`
and `packages/ui/src/window.ts` import `@tauri-apps/api` — and both become an
injected opener and a host check before the browser links either package. Only
the transports change behind them. Forking a chat component into the browser would
break the property that all three products look and behave alike — the same rule
AGENTS.md already states for the two existing apps.

## Memory

Chromium sets a floor of roughly 400–550 MB (browser process, GPU, network and
storage services, one live renderer). Nothing removes it. The wins are policy,
not engineering:

- Aggressive background **discard and freeze**, on by default. Chrome ships this
  off in a fresh profile; it is worth around 60% of a session.
- **Cap the back-forward cache.** Whole documents are retained otherwise.
- **Trim prerender and `NoStatePrefetch`.** Latency win, real memory cost.
- **One daemon, not one per window.**
- **One UI renderer**, shared.
- **Ad and tracker blocking**, which removes 10–25% of renderer memory on
  ad-heavy pages.

Honest target: 20–30% below Chrome at high tab counts, and it never swaps an
8 GB machine to death. Not half. A fork that does not invest deliberately in
these defaults will be *heavier* than Chrome, because Chrome has a dedicated team
and we do not.

## Ad blocking

`adblock-rust` (the `adblock` crate, MPL-2.0) — Brave's engine, and the one
Mozilla shipped in Firefox 149. It handles network rules, cosmetic filtering,
`$redirect` resource replacement, hosts and uBlock Origin syntax.

`components/subresource_filter` (already in the tree, maintained by Google) is a
smaller fallback: no cosmetic filtering, limited syntax. Bundling an MV3 blocker
is a stopgap only, and writing our own engine is not a real option — the syntax
is a decade of edge cases.

Integration is at the network seam (`URLLoaderRequestInterceptor` or the
subresource filter's plumbing), not by patching `//services/network`.

The interesting angle is one only a fork can take: **agent-aware blocking.**
Cookie banners, interstitials, chat widgets and analytics are noise for an agent,
so stripping them on agent-driven tabs makes runs faster and cheaper. No
extension can express that.

## Security boundaries

The browser ships an agent with browsing capability and, eventually, a password
manager. That combination is an active attack class: a visited page injects
instructions into the agent, and the agent reaches credentials.

The line to hold is **authenticated is not the same as holding secrets.**

- An agent needs to *operate* logged-in accounts. That is a session — revocable,
  scoped, expirable — and it is fine.
- An agent must never reach the vault or trigger autofill. That is a secret —
  permanent and reused everywhere, so the same capability has a wildly different
  blast radius.
- Practically: agent tabs run in a profile the user signed into once, so the
  agent inherits session and never secrets.
- No credential-scoped tool ever appears in `bridge.rs`. The boundary should be
  structural, not policy-dependent.
- Agent screenshots must not capture filled credential fields.

Password management is **Chromium's existing implementation, extended** — form
classification, save/update prompts, filling and generation all live in
`components/password_manager` and `components/autofill`. Our own vault belongs
behind `password_manager::PasswordStore`, so storage and sync change while the
browser-side logic does not. Cross-device sync of a vault is not invented
locally: local-only with the OS keychain, or an audited E2E design plus a review.

The agent guard currently ships as a JS extension (`hook-guard.mjs`). In the
browser it becomes a network-layer policy instead, which is strictly stronger —
one fewer thing the agent can talk its way around.

## Upgrading Chromium

Chromium moves roughly every four weeks, and security releases land in between.
Falling a quarter behind means knowingly shipping a vulnerable browser; V8
in-the-wild exploits are routine. This is an obligation, not maintenance.

Per upgrade:

1. `gclient sync` to the new tag.
2. `git rebase --onto` the commit stack.
3. Read each hunk. The stack is small on purpose.
4. Rebuild, run `browser_tests` and `content_browsertests`.
5. Spot-check the seams the stack touches — ad interception, service
   registration, WebUI bindings.

Chromium's own test suites are inherited for free and are the main reason this
stays affordable. They are also another slow loop; run them in CI, not locally.

## Distribution and compliance

- **Chromium is BSD-3-Clause.** Fork, rebrand, ship closed, keep changes private.
  Retain notices.
- **No Google trademarks.** No "Chrome", no Chrome logo. The product needs its
  own name.
- **Google API keys** are ours to obtain (Safe Browsing, geolocation, timezone,
  translate). Shipping without Safe Browsing is not acceptable.
- **Codecs are off by default** (`proprietary_codecs`, `ffmpeg_branding`). Without
  them H.264 and AAC do not play.
- **Widevine is a separate licence from Google.** Without it, Netflix, Disney+
  and Spotify web do not work. This is a decision to make consciously, not to
  discover after launch.
- **Chrome Web Store** works for non-Chrome browsers, with warnings. CWS must not
  be the only install path — the built-ins have to stand on their own.
- **Bundled filter lists** (EasyList, EasyPrivacy) are CC BY-SA; attribution is
  enough, share-alike binds the list and not the browser.
- **Windows default-browser registration** is fiddly and MSIX makes it fiddlier.
  Test it early.
- Existing release infrastructure (`scripts/release.sh`, `update.rs`, MSIX,
  `release-gate.mjs`) already covers installer, updater and gating. That is a
  significant head start and should be reused rather than rebuilt.

## Open decisions

Settled, with the reasoning, in `docs/browser-poc-plan.md`: the name (Hook
Browser), the engine (Chromium, for the extension store and for BSD-3 allowing a
closed fork), reuse of `ChatDock` rather than a browser-only chat surface, and no
thin precursor — the overlay is proven before any product surface is built.

Still open:

- Widevine: license it, or ship without DRM playback.
- Vault scope: local-only, or synced — and if synced, on which construction.
- Whether the tabstrip is restyled in Views or left close to upstream.
- Chromium release channel and how security patch releases are tracked.

## Non-goals for now

- Feature parity with Chrome.
- Independent rendering engine, or any divergence below `//chrome`.
- Extensions beyond what upstream supports.
- Any custom cryptography.
