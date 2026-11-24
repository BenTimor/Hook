# Hook Browser — POC plan

> **Status: the POC's question is answered, and the browser talks to Hook.**
> `browser/` holds the pinned tag, the dev args and the sync/build/verify/patch/
> smoke tools. Step 0 is done on Windows, and so is the rebuild it gated: `out/Dev`
> is a ninja build (`use_siso = false`, because siso cannot read the overlay
> junction), so a C++ change is minutes again.
>
> **Step 1 is complete.** `chrome://hook` renders from the overlay, reads the live
> tab list over mojom through the binder registered by the fourth patch, and a
> navigation to the web is cancelled and replaced by the page while the machine
> has no account (`hook_sign_in_throttle.cc`, the fifth patch). `--hook-signin-state`
> exists so the refusal is provable on a machine that *is* signed in.
>
> **Step 2 is complete.** The dock from `packages/chat` at 380px, built by Vite
> and served from our pak, is both a pane of `chrome://hook` and a Views
> side-panel entry of its own (`chrome://hook-panel`, pinned action id and all);
> the signed-out page is the shared `SignInCard`, driven through the channel's
> `/auth/*` routes; Ctrl+T, the plus button and a first window land on
> `chrome://hook-newtab`; and the tabstrip is restyled (patch 0010).
>
> **Step 3's cheap proof is in, and so is page context.** A *running* Hook app
> publishes a loopback channel (`crates/hook-core/src/channel.rs`) beside the
> account file; the browser process reads the descriptor and asks it for the
> chat list, a conversation, and to send a message. The page cannot: Chromium
> terminates a `chrome://` renderer for a cross-scheme request ("Incorrect
> scheme"), which is why the call is made in the browser process and handed over
> mojom, and why the token never reaches the page.
>
> **The browser now starts the host it talks to.** When no channel answers it
> launches `hook --headless` itself, once per run, from a path fixed at build
> time, and only accepts a descriptor naming its own child
> (`browser/host/hook_host.cc`; `docs/browser-host.md`, step 1). `--hook-no-host`
> turns that off and every other smoke flag passes it, so no check leaves a
> process behind. The shipping shape — a Tauri-free sidecar that owns auth and
> the turn — is still steps 2–3 of that document, and `browser/ui/transport.ts`
> is the only file that changes when it lands.
>
> Everything above is verified, not just built: `pnpm browser:smoke` launches
> `out/Dev/chrome.exe` with a throwaway profile and asserts the live tab list, the
> dock at 380px, one send round trip, the sign-in gate in both directions, the
> side panel, and — with `--channel` and Hook running — a real chat list, a real
> transcript, and the backend refusing an empty message. `--host` asserts the
> launch; `--codecs` asserts H.264 and AAC decode.
>
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
| Codecs | **The OS decoders, for anything shipped** | H.264 and AAC are what the web's MP4s are made of, and both pools charge whoever distributes a build that contains a decoder. Windows already has both in Media Foundation, so the shipped browser calls the OS's decoder instead of shipping one (the Firefox position since 2013, sized in `docs/browser-os-decoders.md`). The **dev build keeps FFmpeg's** (`proprietary_codecs`, `ffmpeg_branding = "Chrome"`) so the seam and the panel are tested against a browser that plays everything; stages 1–2 of the decoder document land before a public download, and the release `args.gn` then drops those two flags. `pnpm browser:smoke --codecs` asserts the capability, whichever half provides it. |
| Panel UI build | **Vite bundle served from the overlay** | `packages/chat` is React; Chromium's WebUI pipeline is Lit/TypeScript and ships no React. The browser builds the shared packages with Vite and packs the output as a static resource. Rewriting `ChatDock` in Lit would fork the surface all three products share. The bundle is generated by `browser/tools/build.mjs` (Vite before ninja) and gitignored: `build_webui` resolves `static_files` against the source tree, and GN cannot declare `node_modules` as an input. |
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

Cost: tens of lines of C++, one `build_webui` target, and five patch files
(registration, repack, resource ids, binder, throttle). **All of it is in:** the
page, its stylesheet, the mojom method behind the tab list
(`hook/common/hook.mojom`, `ReadTabs` in `browser/tabs/`), the binder line in
`chrome_browser_interface_binders_webui.cc`, and the gate in
`navigation/hook_sign_in_throttle.cc` — which reads the shared account file on a
thread pool (never writes it), allows every internal scheme so the card itself is
reachable, and is provable with `--hook-signin-state=out`.

### Step 2 — the surfaces, against a browser that exists

- New Tab page becomes Hook's: wordmark, greeting, chips.
- Side panel becomes `ChatDock` at 380px, unchanged (`packages/chat`), on
  `packages/ui` tokens. **In, twice:** `browser/ui/` builds the bundle,
  `resources/panel.mjs` carries it, and `chrome://hook` draws it beside the seam
  proof; `chrome://hook-panel` is the same document as a *top-chrome* WebUI, so
  it is a real side-panel entry of every window (`ui/views/hook_side_panel.cc`,
  the sixth and seventh patches: the entry's id and the action item the pinning
  controller insists on). `--hook-side-panel` opens it; the toolbar's pin makes
  it stick.
- Sign-in becomes the shared card. **Done.** The card is one component
  (`packages/ui/src/SignInCard.tsx`): three states, one voice, and the chat
  window, Hook Workspace, the phone and `chrome://hook` all draw it. The browser
  is the one host that does not own the credential, so it starts the device flow
  through the running app's channel (`/auth/start`), shows the code, polls
  `/auth/status`, and reloads when the account file appears; with no app it says
  so and links to hookcode.io. `--hook-signin-state=out` puts the card on the page
  for a screenshot, and `pnpm browser:smoke --signin-state out` asserts it.
- New Tab page becomes Hook's. **Done.** `chrome://hook-newtab` draws the
  wordmark, a greeting and three chips, and `ChromeUINewTabURLAsGURL()` returns it,
  so Ctrl+T, the plus button and the first window land there. `--newtab` asserts
  the page and a fresh profile's first tab.
- Tabstrip restyle. **Done, minimally.** Patch 0010: narrower tabs, rounder
  corners, an opaque selected tab (214 DIP, 13/15, 100% instead of 75%). Views,
  two files, and the least ambitious of the six on purpose.

The two shared packages no longer carry a module-scope Tauri dependency:
`packages/chat/src/open.ts` and `packages/ui/src/window.ts` load
`@tauri-apps/api` lazily behind `isTauri()`, and the browser bundle aliases it to
`browser/ui/tauri-stub.ts` so a host that has no Tauri never carries one.

The panel is React, not Lit. It is built with Vite into a static bundle that the
overlay serves from its pak; `build_webui` packages the output instead of
compiling the components. Chromium's own WebUI pipeline has no React, and
rewriting `ChatDock` in Lit would fork the surface Hook and Hook Workspace
already share. `browser/README.md`, "The dock bundle", holds the details
(.mjs`, inlined stylesheet, generated output, and why each).

Tabstrip restyling came last, after the WebUI surfaces worked, and it is the
smallest change of the six: two constants and a colour blend. It is Views, so it
is C++, and every further step there costs a rebuild.

### Step 3 — the chat backend

**The cheap proof is in.** `crates/hook-core/src/channel.rs` publishes a loopback
HTTP surface from a running Hook app — `/health`, the chat list, one conversation,
create, send, stop — guarded by a per-process token it writes beside the account
file (`%APPDATA%\app.hook\browser-channel.json`). The browser process reads that
descriptor on a thread pool and calls the channel with `SimpleURLLoader`; the page
sees the answers over mojom (`hook_channel.{h,cc}`, `hook_page_handler.cc`).

Two constraints shaped it, and both are worth keeping:

* a `chrome://` renderer may not make the request itself — Chromium terminates it
  for "Incorrect scheme" — so the call belongs in the browser process, which also
  keeps the token out of the page;
* the descriptor outlives a killed app, so "available" means `/health` answered,
  not "a file exists".

Streaming is polling while a turn runs (`busy` on the chat, one `getChat` per
~350 ms, deltas synthesised from the text that grew). It reads as live, costs a
route less than SSE, and the dock's event contract does not change when a real
stream arrives.

**The browser also starts the host itself** when nothing answers
(`browser/host/hook_host.cc`): one launch per browser run, `hook --headless`, from
a path fixed at build time — beside `chrome.exe` for a packaged build, the
repository's debug binary for a dev tree, which `browser/tools/build.mjs` writes
into `out/Dev/args.gn` (`hook_host_path`) so no machine-specific path is
committed and nothing a page or the environment says can name an executable. It
accepts the descriptor only when its `pid` is the child's, so a host another
product started is never mistaken for ours, and it terminates the child on an
orderly exit. `--hook-no-host` turns the whole thing off; so does
`--hook-signin-state`, in either direction, because a check must not leave a
process behind. `pnpm browser:smoke --host` is the assertion.

The shipping shape is the sidecar from `docs/browser-host.md`. Its cost is bounded:
`AppState.app: AppHandle` plus ~28 references across four files, plus the
`generate_handler!` list moving into the Tauri crates behind an `Events` trait.
A focused change, not a rewrite — and it replaces the transport without changing
the contract the WebUI sees.

## After the rebuild

The one-time rebuild gated every C++ change: the side panel, the mojom tab read,
the binder-map line, the navigation throttle. All four are in, and so is the
channel that makes them useful. The list below is what was left after that
rebuild; three of the four items are now closed:

1. ~~**Finish Step 1.**~~ Done: the tab list over mojom, the binder line, and the
   throttle that turns a signed-out navigation into the sign-in card.
2. ~~**The channel (Step 3).**~~ Done as the cheap proof, and the browser now
   starts its own host when nothing answers (`browser/host/hook_host.cc`;
   `docs/browser-host.md`, step 1). Left: the sidecar, so the browser stops
   borrowing the chat product's process and data folder.
3. ~~**The surfaces (Step 2).**~~ Done: the dock (twice), the shared sign-in card,
   the New Tab page, and the tabstrip restyling.
4. **Before a public download:** the OS decoders (`docs/browser-os-decoders.md`,
   stages 1–2) and the release plumbing — not surfaces, and not the seam.

## Page context

**In.** `set_chat_context` (`commands.rs`, now also a method on `AppState`) is read
by `context_frame` (`turn.rs`) and appended as one trailing message, which is the
append-only-safe place for per-request state. The browser's transport builds the
block inside `send`, from the live tab list the page already has, and the channel
route sets it before the turn is kicked — so a message typed long after a tab
switch describes the right tab. Workspace uses the same command.

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

## What shipping needs

Steps 1–3 are code that a session can finish, and all three now are (the browser
starts its own host). This list is what stands between the POC and a browser
someone installs, split by what only a decision can unblock.

**Decisions (yours, not the code's):**

- **Codecs.** Decided: the shipped browser decodes through the OS's Media
  Foundation, not through a decoder we ship — so the dev build's `args.gn` flags
  (`proprietary_codecs`, `ffmpeg_branding = "Chrome"`) come off for a release
  build, and `docs/browser-os-decoders.md`'s stages 1–2 are the work item. Until
  they land, the FFmpeg build is what a tester runs, and the release build does
  not exist. A build that ever keeps both is the licensed configuration with
  extra steps, which is the one thing the decision rules out.
- **Widevine.** A separate licence from Google. Without it, Netflix, Disney+ and
  Spotify web do not work; licensing it is a contract, not a patch.
- **The vault.** Local-only with the OS keychain, or synced — and if synced, on
  which construction and with which review.
- **The tabstrip.** Restyle it in Views (expensive, C++) or keep it close to
  upstream.
- **Which surfaces ship as WebUI** beyond New Tab, the dock and sign-in.
- **The release channel**, and how security patch releases are tracked. Chromium
  moves every four weeks; falling a quarter behind means shipping a known-vulnerable
  browser.

**Work, once the decisions exist:**

- **Google API keys** for Safe Browsing, geolocation, timezone and translate.
  Shipping without Safe Browsing is not acceptable.
- **The sidecar** (Step 3's shipping shape): auth and the turn out of process, so
  the browser does not need the Hook app running and the window stack stays out
  of the browser process.
- **Ad and tracker blocking**, if it ships: `adblock-rust` at the network seam,
  EasyList/EasyPrivacy bundled (CC BY-SA attribution), not a home-grown engine.
- **Release plumbing:** a `scripts/products.mjs` entry, `msix/<product>/`, and
  `pnpm release` building the browser — today all three deliberately ignore it.
- **Default-browser registration**, which is fiddly and fiddlier under MSIX.
- **CI:** Chromium's `browser_tests` and `content_browsertests` on a self-hosted
  runner with a persistent `out/`; they are inherited for free and are the reason
  a fork stays affordable.
- **The dock bundle as a build step.** It is generated by the build now
  (`browser/tools/build.mjs` runs Vite before ninja, and the file is gitignored),
  but not *inside* GN: `build_webui` resolves `static_files` against the source
  tree, so a `$root_gen_dir` output cannot be one, and GN cannot declare
  `node_modules`. The wrapper step is the compromise; the history is that the
  file was committed before, with the silent failure mode that a change under
  `packages/chat` nobody re-bundled shipped the old surface.

## Still open

- Widevine: licence it, or ship without DRM playback.
- Vault scope: local-only, or synced — and on which construction.
- Chromium release channel, and how security patch releases are tracked.
- ~~Whether the tabstrip is restyled in Views or left close to upstream.~~
  Restyled, minimally (patch 0010); it can go further or stay where it is.
- ~~How H.264 and AAC reach a shipped build.~~ Decided: through Windows' Media
  Foundation (`docs/browser-os-decoders.md`), not through FFmpeg we ship. The dev
  build keeps FFmpeg until stages 1–2 land.
- ~~Whether the browser can run without another product's daemon.~~ It starts its
  own host now (step 1); what is left is the host *being* the browser's —
  `Product::Browser`, its own data folder, no Tauri — which is
  `docs/browser-host.md`, steps 2–3.
- Which surfaces ship as WebUI beyond New Tab, the dock and sign-in.
