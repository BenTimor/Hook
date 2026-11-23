# Hook Browser — POC plan

> **Status: tooling, the seam, and the first real surface.**
> `browser/` holds the pinned tag, the dev args and the sync/build/verify/patch
> tools. Step 0 is done on Windows, and so is the rebuild it gated: `out/Dev` is
> a ninja build (`use_siso = false`, because siso cannot read the overlay
> junction). Step 1's seam is in — `chrome://hook` renders from the overlay, and
> the page reads the live tab list over mojom through the binder registered by
> the fourth patch. The signed-out navigation throttle is what is left of Step 1.
> Step 2's first surface is in too: `ChatDock` from `packages/chat`, at 380px,
> beside the seam page, built by Vite and served from our pak. It is a pane in
> `chrome://hook` rather than a Views side-panel entry, which is the next piece,
> together with the New Tab page. It is built against the real host only so far:
> there is still no channel to the backend, and no mock panel was ever written.
> The rebuild and the surface are verified, not just built: `pnpm browser:smoke`
> launches `out/Dev/chrome.exe` with a throwaway profile, opens `chrome://hook`,
> and asserts the live tab list, the dock at 380px, the composer and one send
> round trip — it passes on Windows.
> `docs/browser-architecture.md` holds the standing decisions about the fork
> itself; this file holds the order of work for the first proof of concept, and
> why it is that order.

The POC answers one question: **does our overlay reach Chromium, and can the Hook
chat surface live inside it?** It is not a browser you can daily-drive, and it is
not the product surface — it is the seam.

## Decisions taken

| Decision | Choice | Why |
| --- | --- | --- |
| Name | **Hook Browser** | Product directory `apps/browser` stays reserved until the fork builds; the engine work lives in `browser/` (see below). |
| Engine | **Chromium** | Chrome Web Store, and BSD-3 lets a closed fork ship without publishing its changes. Gecko builds in tens of minutes and has the better web-tech chrome layer, but MPL-2.0 is file-level copyleft — a closed binary obliges us to publish our changes to covered files, and "open source later" does not cover today. Extension store was the user's stated preference; the licence is the harder constraint. |
| Precursor shell | **No** | A WebView2/Electron shell that browses today would diverge from the fork and pull Tauri into a UI that must not have it. The UX questions are cheap to answer after the seam works, and expensive to answer twice. |
| Order of work | **Seam first, UI second** | The risky part is the overlay reaching the browser (GN wiring, WebUI resources, mojom, a navigation throttle). Components written against a mock contract are written against a guess. |
| Surface prototypes | **No** | A panel prototyped against mocked mojo, auth and chat is written twice: once against the mock, then again against the real host. The one-time rebuild is the smaller cost, so the panel and its host are built once. |
| Panel UI build | **Vite bundle served from the overlay** | `packages/chat` is React; Chromium's WebUI pipeline is Lit/TypeScript and ships no React. The browser builds the shared packages with Vite and packs the output as a static resource. Rewriting `ChatDock` in Lit would fork the surface all three products share. For the POC the bundle is committed (`browser/ui/` → `overlay/src/hook/resources/panel.mjs`); a build-time action is the follow-up. |
| Where the tree lives | **Outside the repo**, overlay junctioned in | See "Where things live". |
| Sign-in gate | **Blocks the whole browser** | Matches Hook and Hook Workspace: signed out means the window is the sign-in card and navigation is refused. Implemented as a `ContentBrowserClient` throttle, not a `//content` patch. |
| Browser tools | **None** | No tab or navigation tools in `tools.rs` or `bridge.rs`. The agent is told the page it is looking at; it cannot act on it. |

Working identifier for the data folder: `app.hook.browser` (`%APPDATA%\app.hook.browser`).
The account file stays shared at `%APPDATA%\app.hook\account.json`.

## What "done" means

A Chromium built on this machine, from a pinned tag, with our overlay:

1. opens a `chrome://hook` page that is ours;
2. shows the live tab list, read over mojom from the browser process (the
   probe; the product contract is the active tab);
3. refuses to navigate until an account is signed in;
4. shows the Hook chat dock in a side surface.

Then, and only then, is a styled browser shell worth building.

## Where things live

The checkout is a build environment, not a product: it is 100 GB with its own
`.git`, it must never be committed, and `git clean -xfd` (which wipes ignored
paths) would destroy a multi-hour fetch. It therefore sits outside the repo, at
a short path — Chromium's own guidance, because `third_party/...` paths hit
`MAX_PATH` under a deep root.

```
C:\Dev\cr\                        local only, never pushed (~100 GB)
  depot_tools\
  src\                            Chromium's own repo, detached at the tag
  src\hook\                        junction -> Hook\browser\overlay\src\hook
  out\Dev\

Hook\browser\                     committed
  VERSION                         the one pinned tag; the sync script reads it
  README.md                       dev loop, traps, rebase ritual
  .gclient.in                     gclient config with the overlay as a dep
  args.gn                         dev args (symbol levels set before build 1)
  patches/series + *.patch        the only edits to upstream files
  overlay/src/hook/               new paths only; this is what `//hook` resolves to
  ui/                             the dock bundle's Vite project (panel.tsx, transport)
  tools/{sync,patch,verify,build}.mjs
```

The junction points the other way, so editing `Hook/browser/overlay/src/hook/...`
edits the bytes Chromium compiles. Nothing is copied or stashed; a re-sync is
needed only when upstream moves.

`tools/verify.mjs` enforces the overlay rule mechanically: it fails if an overlay
path also exists upstream (a file copied instead of patched), and fails if a
patch in `series` does not apply to a clean tree.

The four tools are the whole interface — `browser/README.md` holds the dev loop,
the prerequisites and the traps:

```bash
node browser/tools/sync.mjs      # fetch/refresh the tree at browser/VERSION
node browser/tools/build.mjs     # gn gen + autoninja -C out/Dev chrome
node browser/tools/verify.mjs    # tag, overlay rule, patch stack, junction
node browser/tools/patch.mjs     # list | add <slug> [-- paths] | apply
pnpm browser:ui                  # rebuild the dock bundle (overlay/.../panel.mjs)
```

## The steps

### Step 0 — the tree (background, ~2–4 h of machine time)

Fetch depot_tools, `gclient sync` at the pinned tag, build the stock `chrome`
target with the dev `args.gn`.

Done when: a stock Chromium runs, and `out/Dev` is warm enough that a later
WebUI change is a repack rather than a rebuild.

Nothing in the repo depends on this finishing, but Steps 1–4 all wait on it.

**Done on Windows.** `sync.mjs` and `build.mjs` produced `out/Dev/chrome.exe`
from tag `159.0.8154.13`: 27 GB of tree, 3 h 43 m of build on 28 cores, 12 GB of
output, and the binary opens a window. The estimate that was wrong was the
toolchain, not the build: M159 pins Windows SDK 10.0.28000 *including the
Debugging Tools feature*, and `build/vs_toolchain.py` cannot see a VS 2022
BuildTools install unless `vs2022_install` is set. Both are prerequisites in
`browser/README.md` now, and `sync.mjs` checks the SDK before a build wastes an
evening.

**The switch to ninja cost what the README predicted.** Moving `out/Dev` from a
siso build to `use_siso = false` recompiled the tree — about 3 h 30 m wall clock
for 58,308 steps on 28 cores — and the second attempt, after launching the old
binary out of `out/Dev` and locking two DLLs, is the reason `browser/README.md`
says to run the built browser only after a build. The tree is now a ninja one:
a C++ change is minutes, a resource change is seconds.

### Step 1 — prove the seam (the only POC that matters)

The whole overlay, kept deliberately disposable:

- one `chrome://hook` WebUI page (renders a title and the wordmark);
- one `build_webui` target, which generates the `.grd` and the resource map, plus
  a repack entry and a reserved resource-id range so it loads from our bundle;
- one `BUILD.gn` dependency, registered where Chromium looks for new surfaces;
- one mojom method returning the live tab list (index, id, title, domain);
- one `ChromeContentBrowserClient::CreateThrottlesForNavigation` that cancels
  the navigation while signed out;
- small patch hunks in registration and resource lists, only where the overlay
  cannot be reached another way.

Done when: the built browser opens `chrome://hook`, lists the tabs actually open,
and a typed URL does nothing but return to the sign-in card.

Cost: tens of lines of C++, one `build_webui` target, and four patch files
(registration, repack, resource ids, binder). **In:** the page, its stylesheet,
the mojom method behind the tab list (`hook/common/hook.mojom`,
`ReadTabs` in `browser/tabs/`) and the binder line in
`chrome_browser_interface_binders_webui.cc`. **Left:** the throttle.

### Step 2 — the surfaces, against a browser that exists

- New Tab page becomes Hook's: wordmark, greeting, chips.
- Side panel becomes `ChatDock` at 380px, unchanged (`packages/chat`), on
  `packages/ui` tokens. **In, as a pane in `chrome://hook`:** `browser/ui/` builds
  the bundle, `resources/panel.mjs` carries it, and the page draws it beside the
  seam proof. The Views side-panel entry that hosts the same page in the browser
  UI is the next piece of C++.
- Sign-in becomes the shared card.

One fix that the surface turned out not to need yet: `packages/chat/src/open.ts`
and `packages/ui/src/window.ts` import `@tauri-apps/api` at module scope, but both
guard every call with `isTauri()`/`__TAURI_INTERNALS__`, so the bundle loads and
runs in the browser as it is. Turning them into an injected opener is still the
right shape — it is what makes `packages/chat` and `packages/ui` host-agnostic as
the architecture doc claims — and it is now a refactor with no browser work
blocked behind it.

The panel is React, not Lit. It is built with Vite into a static bundle that the
overlay serves from its pak; `build_webui` packages the output instead of
compiling the components. Chromium's own WebUI pipeline has no React, and
rewriting `ChatDock` in Lit would fork the surface Hook and Hook Workspace
already share. `browser/README.md`, "The dock bundle", holds the details
(`.mjs`, inlined stylesheet, committed output, and why each).

Tabstrip restyling comes last, after the WebUI surfaces work: it is Views, so it
is C++, and it is the most expensive and least informative part.

### Step 3 — the chat backend

Cheap proof: the chat app already runs a loopback listener (`bridge.rs`) with a
per-chat token. A token-scoped chat endpoint on a *running* Hook proves the
browser ↔ backend channel in a day, with no refactor.

The shipping shape is the sidecar from the architecture doc. Its cost is bounded:
`AppState.app: AppHandle` plus ~28 references across four files, plus the
`generate_handler!` list moving into the Tauri crates behind an `Events` trait.
A focused change, not a rewrite — and it replaces the transport without changing
the contract the WebUI sees.

## After the rebuild

The one-time rebuild gates every C++ change: the side panel, the mojom tab read,
the binder-map line, the navigation throttle. It does not by itself make sign-in
or chat real — those live in `hook-core` (`auth.rs`, `turn.rs`) and the browser
has no channel to them yet. With no mock panel, the order is:

1. **Finish Step 1.** ~~The mojom probe (the live tab list) plus the binder-map
   line~~ — done: `chrome://hook` lists the tabs actually open. The navigation
   throttle still rejects nothing; it is the last piece of Step 1, and it reads
   the shared `account.json` (never writes it).
2. **The channel (Step 3).** The shipping shape is the Tauri-free sidecar, which
   owns auth and the chat turn. The loopback endpoint on a running Hook app is a
   real, smaller channel and may land first; either way the panel's
   `ChatTransport` is the same contract. Sign-in and sign-out go through
   `auth.rs`, so the browser is never a second writer of the account file.
3. **The surfaces (Step 2).** ~~The Vite bundle and the dock at 380px~~ — done,
in `chrome://hook`. Still to come: the Views side-panel host that puts the same
page beside the tabstrip, the shared sign-in card and the New Tab page. The
active-tab context is a `TabContext` implementation over the mojom interface;
there is no mock version to replace.
4. **Tabstrip restyling**, last, as before.

The first version of the throttle needs somewhere to send a signed-out
navigation. A minimal signed-out state on `chrome://hook` is enough until the
shared card arrives with the surfaces.

## Page context

The channel already exists: `set_chat_context` (`commands.rs`) is read by
`context_frame` (`turn.rs`) and appended as one trailing message, which is the
append-only-safe place for per-request state. Workspace uses it; the browser will
too, with the same command and no prompt changes.

The browser sends the inner lines only — `context_frame` supplies the heading:

```
Browser: Hook Browser
Tab: 3 of 7 (id: 7)
Title: Writing a GN build file
Domain: chromium.googlesource.com
Selected text: "is_component_build"
```

Rules:

- Built at **send time**, inside `transport.send`, and awaited before the turn is
  requested — not on a 1.5 s tick like Workspace, where "this page" can be stale.
- Recomputed on tab activation, navigation, title change and selection change, so
  a message typed long after a switch still describes the right tab.
- Selection is capped like Workspace's (800 chars); the whole block is capped by
  `set_chat_context` at 4000.
- The active tab only, plus its position and the tab count. A whole-tab-list
  summary is a later feature, not this one.

Note the consequence: the model learns the page's *identity*, not its contents.
It has no browser tools in this POC, so an answer that needs the page text will
say so. That is the intended boundary.

## Not in this POC

Feature parity with Chrome; extensions; downloads, bookmarks, history, settings;
profiles; password manager and autofill; ad blocking; memory policy; Widevine;
update channel; MSIX; `products.mjs`, release scripts and version bumps; any new
chat-agent tool.

## First run

Prerequisites are in `browser/README.md`: depot_tools, a Visual Studio the tag's
toolchain accepts, the SDK version it pins (with the Debugging Tools feature),
and Defender/indexing exclusions for both trees. Then:

```bash
node browser/tools/sync.mjs      # ~30-90 min cold, ~27 GB, retries the rate limit
node browser/tools/verify.mjs    # tag, overlay rule, patch stack, junction
node browser/tools/build.mjs     # ~4 h on 28 cores, once
```

Both default to `C:\Dev\cr` and take `--root` (or `HOOK_CHROMIUM_ROOT`) for
another short path. `build.mjs --gen-only` is what a WebUI-only iteration needs.

`args.gn` pins `use_siso = false`: siso cannot read the overlay junction, so the
tree builds with ninja (`browser/README.md`, "Traps"). A fresh `out/Dev` is
unaffected; a directory already built by siso recompiles once on the switch.

Traps that cost a night the first time, in the order they bit. The tools handle
all of them now; `browser/README.md` has the detail.

- **Exclude `C:\Dev\cr` and `C:\Dev\depot_tools` from Defender and from Windows
  indexing before the build.** The difference is multiples, not percent.
- **`gclient sync --no-history` trips Google's anonymous rate limit** (`429
  RESOURCE_EXHAUSTED`) when it shallow-fetches ~100 deps in parallel. Throttle to
  `--jobs 2` and retry; the first attempt will fail.
- **A dep that loses that race keeps a `.git` with no checkout**, is then
  considered healthy by gclient forever, and breaks the build hours later with
  "missing and no known rule to make it". Delete that directory and re-sync —
  that is the only in-place recovery.
- **`DEPOT_TOOLS_WIN_TOOLCHAIN=0` and `vs2022_install` are both required** off
  Google's network and with BuildTools under `Program Files (x86)`; without the
  second, `gn gen` reports "No supported Visual Studio can be found".
- **The SDK installer's `/features` switch replaces the default feature set.** A
  debuggers-only run marks the bundle installed, and every later plain run becomes
  a silent no-op "modify". Uninstall, then a plain `/q`.
- **Never run `gclient sync -D`** once `src\hook` is a junctioned overlay: it can
  remove unmanaged directories. Plain `gclient sync` recreates the junction.
- **Build `chrome`, never `all`.** Set the symbol levels before the first build;
  changing them forces a full recompile.

Stop points, if the night runs short: after `sync.mjs` the tree exists and nothing
is lost; after `build.mjs` a stock browser runs. Step 1 of the plan can happen on
any later evening.

## Still open

- Widevine: licence it, or ship without DRM playback.
- Vault scope: local-only, or synced — and on which construction.
- Chromium release channel, and how security patch releases are tracked.
- Whether the tabstrip is restyled in Views or left close to upstream.
- Which surfaces ship as WebUI beyond New Tab, the dock and sign-in.
