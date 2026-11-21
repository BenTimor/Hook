# Hook Browser — POC plan

> **Status: plan only.** Nothing here is implemented. `docs/browser-architecture.md`
> holds the standing decisions about the fork itself; this file holds the order of
> work for the first proof of concept, and why it is that order.

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
| Where the tree lives | **Outside the repo**, overlay junctioned in | See "Where things live". |
| Sign-in gate | **Blocks the whole browser** | Matches Hook and Hook Workspace: signed out means the window is the sign-in card and navigation is refused. Implemented as a `ContentBrowserClient` throttle, not a `//content` patch. |
| Browser tools | **None** | No tab or navigation tools in `tools.rs` or `bridge.rs`. The agent is told the page it is looking at; it cannot act on it. |

Working identifier for the data folder: `app.hook.browser` (`%APPDATA%\app.hook.browser`).
The account file stays shared at `%APPDATA%\app.hook\account.json`.

## What "done" means

A Chromium built on this machine, from a pinned tag, with our overlay:

1. opens a `chrome://hook` page that is ours;
2. shows the live tab list, read over mojom from the browser process;
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

Hook\browser\                     committed (~20-50 MB)
  VERSION                         the one pinned tag; the sync script reads it
  README.md                       dev loop, traps, rebase ritual
  .gclient.in                     gclient config with the overlay as a dep
  args.gn                         dev args (symbol levels set before build 1)
  patches/series + *.patch        the only edits to upstream files
  overlay/src/hook/               new paths only; this is what `//hook` resolves to
  tools/{sync,patch,verify,build}.mjs
```

The junction points the other way, so editing `Hook/browser/overlay/src/hook/...`
edits the bytes Chromium compiles. Nothing is copied or stashed; a re-sync is
needed only when upstream moves.

`tools/verify.mjs` enforces the overlay rule mechanically: it fails if an overlay
path also exists upstream (a file copied instead of patched), and fails if a
patch in `series` does not apply to a clean tree.

## The steps

### Step 0 — the tree (background, ~2–4 h of machine time)

Fetch depot_tools, `gclient sync` at the pinned tag, build the stock `chrome`
target with the dev `args.gn`.

Done when: a stock Chromium runs, and `out/Dev` is warm enough that a later
WebUI change is a repack rather than a rebuild.

Nothing in the repo depends on this finishing, but Steps 1–4 all wait on it.

### Step 1 — prove the seam (the only POC that matters)

The whole overlay, kept deliberately disposable:

- one `chrome://hook` WebUI page (renders a title and the wordmark);
- one `.grd` + resources entry so it loads from our bundle;
- one `BUILD.gn` dependency, registered where Chromium looks for new surfaces;
- one mojom method returning the live tab list (index, id, title, domain);
- one `ChromeContentBrowserClient::CreateThrottlesForNavigation` that cancels
  the navigation while signed out;
- one patch hunk, only if a registration list cannot be reached another way.

Done when: the built browser opens `chrome://hook`, lists the tabs actually open,
and a typed URL does nothing but return to the sign-in card.

Cost: tens of lines of C++, one `.grd`, one GN entry, at most one hunk.

### Step 2 — the surfaces, against a browser that exists

- New Tab page becomes Hook's: wordmark, greeting, chips.
- Side panel becomes `ChatDock` at 380px, unchanged (`packages/chat`), on
  `packages/ui` tokens.
- Sign-in becomes the shared card.

Two small fixes land first, because both engines need them and both packages
depend on Tauri today: `packages/chat/src/open.ts` and `packages/ui/src/window.ts`
import `@tauri-apps/api` at module scope. They become an injected opener, so
`packages/chat` and `packages/ui` are host-agnostic as the architecture doc claims.

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

## Night-run checklist

Run from `C:\Dev`. Order matters only where noted.

```bash
# 1. depot_tools (~1 min)
git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git C:\Dev\depot_tools
#    then put C:\Dev\depot_tools first on PATH for this shell:
export PATH="/c/Dev/depot_tools:$PATH"
export DEPOT_TOOLS_WIN_TOOLCHAIN=0

# 2. the tree (~30-90 min, ~60-90 GB)
mkdir -p /c/Dev/cr && cd /c/Dev/cr
gclient config --name src https://chromium.googlesource.com/chromium/src.git@<TAG>
gclient sync --no-history

# 3. build the stock target (~2-3 h on 28 cores)
cd src
gn gen out/Dev --args='is_debug=false is_component_build=true symbol_level=0 blink_symbol_level=0 v8_symbol_level=0'
autoninja -C out/Dev chrome
```

Traps, in the order they bite:

- **Exclude `C:\Dev\cr` and `C:\Dev\depot_tools` from Defender and from Windows
  indexing before step 3.** The difference is multiples, not percent.
- **Never run `gclient sync -D`** once `src\hook` is a junctioned overlay: it can
  remove unmanaged directories. Use plain `gclient sync`.
- **Recreate the junction after any re-sync**, and keep `hook/` in
  `src/.git/info/exclude` so Chromium's `git status` stays clean:
  `cmd //c mklink //J "C:\Dev\cr\src\hook" "<repo>\browser\overlay\src\hook"`
- **Build `chrome`, never `all`.**
- Set the symbol levels **before** the first build; changing them forces a full
  recompile.

Stop points, if the night runs short: after step 2 the tree exists and nothing is
lost; after step 3 a stock browser runs. Step 1 of the plan can happen on any
later evening.

## Still open

- Widevine: licence it, or ship without DRM playback.
- Vault scope: local-only, or synced — and on which construction.
- Chromium release channel, and how security patch releases are tracked.
- Whether the tabstrip is restyled in Views or left close to upstream.
- Which surfaces ship as WebUI beyond New Tab, the dock and sign-in.
