# Hook Browser — build tooling

The Chromium checkout is a build environment, not part of this repository. It is
~100 GB with its own `.git`, `git clean -xfd` (which wipes ignored paths) would
destroy a multi-hour fetch, and `third_party/…` paths hit `MAX_PATH` under a deep
root — so it lives at a short path outside the repository, and this directory
holds only the things that must survive a clone: the pinned tag, the dev args,
the overlay, the patch stack and the scripts that materialise the tree.

The design decisions behind the fork are in
[`docs/browser-architecture.md`](../docs/browser-architecture.md); the order of
work for the first proof of concept is in
[`docs/browser-poc-plan.md`](../docs/browser-poc-plan.md).

```
browser/
  VERSION               the one pinned tag; every tool reads it
  args.gn               the dev GN args, copied into out/Dev
  .gclient.in           gclient config template, with __TAG__ substituted
  overlay/src/hook/     new paths only — this is what //hook resolves to
  patches/series        the only edits to upstream files, in apply order
  tools/                sync, build, verify, patch
```

## Prerequisites

- **depot_tools** on `PATH`:
  `git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git C:\Dev\depot_tools`
- **Visual Studio 2022 or 2026** with the C++ desktop workload. BuildTools is
  enough. The tools find it with `vswhere` and pass the right `vs<year>_install`
  override, which is not optional: `build/vs_toolchain.py` only probes
  `%ProgramFiles%` for VS 2022, and BuildTools installs under
  `Program Files (x86)`.
- **The Windows SDK the tag pins.** M159 hard-requires `10.0.28000.0`
  (`SDK_VERSION` in `build/vs_toolchain.py`) and `base/win/windows_version.cc`
  `#error`s without `NTDDI_WIN11_BR`. It must include the **Debugging Tools for
  Windows** feature — `gn gen` runs `copy_dlls`, which needs `dbghelp.dll`.
  `sync.mjs` checks both and prints the exact `winget` line if they are missing.
- **Defender and indexing exclusions** for the checkout and depot_tools. On a
  large tree the difference is multiples, not percent.
- **The repository's `node_modules`** (`pnpm install` at the Hook root) if you
  rebuild the dock bundle: `pnpm browser:ui` runs the repository's own Vite.
- ~120 GB free: ~27 GB of tree, ~12 GB of build output, growing with the tree.

## The four commands

```bash
node browser/tools/sync.mjs      # fetch/refresh the tree at browser/VERSION (~30-90 min clean)
node browser/tools/build.mjs     # gn gen + autoninja -C out/Dev chrome (hours, once)
node browser/tools/verify.mjs    # tag, overlay rule, patch stack, junction
node browser/tools/smoke.mjs     # launch the built browser, read chrome://hook over CDP
node browser/tools/patch.mjs     # list | add <slug> [-- paths] | apply
```

`sync.mjs` also creates the `src/hook` junction, adds `hook/` to the checkout's
`git/info/exclude`, and reports a missing SDK before a build wastes time. The
tree defaults to `C:\Dev\cr`; override with `--root` or `HOOK_CHROMIUM_ROOT`.

`build.mjs --gen-only` stops after `gn gen`, which is what a WebUI-only iteration
usually needs.

One more command belongs to the panel rather than to the tree:

```bash
pnpm browser:ui                  # rebuild overlay/src/hook/resources/panel.mjs
pnpm browser:ui:dev              # the same panel in an ordinary browser, no tree
```

`smoke.mjs` is the check that the seam actually reached a window: it launches
`out/Dev/chrome.exe` with a throwaway profile and DevTools on a loopback port,
opens `chrome://hook`, and asserts the tab list, the dock at 380px and one send
round trip.

| flag | what it adds |
| --- | --- |
| `--side-panel` | opens the dock's side panel (`--hook-side-panel`) and asserts `chrome://hook-panel` drew it |
| `--signin-state in\|out` | forces the sign-in gate's answer and asserts the matching behaviour — refused and redirected, or committed |
| `--channel` | asserts the real backend: the page's mojom sees a running Hook app's channel, lists its chats, reads one transcript, and the backend refuses an empty message |
| `--host` | asserts the browser starting its own host: the descriptor that appears answers `/health`, is not the browser, and is gone once the browser is |
| `--codecs` | asserts the build decodes H.264, AAC and VP9 — the first two come from `args.gn` in the dev build, and from Media Foundation in a shipped one, so losing either is invisible until a page shows a black box |
| `--shot <png>` | saves a screenshot (`-panel.png` for the side panel) |
| `--chrome <path>` | points it at another binary |

Run it **after** a build, never during one: it maps DLLs out of `out/` and the
linker cannot overwrite a file that is mapped. `--channel` needs the installed
Hook app running on this machine (see **The channel**: a debug build publishes
its descriptor under `hook-dev` and stays invisible to the browser); every other
flag runs alone. Every run passes `--hook-no-host` unless it asks for `--host`, so
no check leaves a Hook process behind — which also means `--host` needs a machine
where none is running, and says so instead of passing quietly.

## The dock bundle

`browser/ui/` is the panel's own little Vite project: `panel.tsx` mounts
`ChatDock` from `packages/chat`, `transport.ts` is the `ChatTransport` the
browser has for now (local, until the Step 3 sidecar), and `shiki-stub.ts`
answers `highlight.ts` with Shiki's own fallback so the pak does not grow every
grammar and theme as a chunk.

The bundle is **generated, not committed**. `browser/tools/build.mjs` runs
`browser/tools/bundle.mjs` (Vite, about half a second) before it calls ninja, and
the output lands in `browser/overlay/src/hook/resources/panel.mjs`, which
`build_webui` packs into `hook_resources.pak`. `pnpm browser:ui` runs the same
bundler by hand. Three things are deliberate:

- Chromium's WebUI build compiles Lit and TypeScript and ships no React, so the
  shared surface cannot be built by `build_webui` itself. `build_webui` also
  refuses `.js` in `static_files` and lints every `.css` it is given against
  Chromium's stylelint config, which a bundle has no reason to satisfy — hence
  `.mjs` and the inlined stylesheet.
- It is not inside GN because it cannot be: `build_webui` resolves `static_files`
  against the source tree, so a `$root_gen_dir` output is not a valid input,
  and GN has no way to declare `node_modules` as inputs. A wrapper step is the
  honest place for "build the JavaScript first".
- The file is in `.gitignore`. Before this it was committed, and the failure mode
  was silent: a change to `packages/chat` that nobody re-bundled left the panel
  showing the old surface, and the diff of a 640 kB generated file is unreadable
  anyway. Now a stale checkout fails loudly — `panel.mjs` is missing until the
  build creates it — and the build always creates it.

## Codecs

`args.gn` sets `proprietary_codecs = true` and `ffmpeg_branding = "Chrome"`.
Without them Chromium decodes only the open codecs (VP8, VP9, AV1, Opus, MP3),
which is YouTube and very little else: H.264 and AAC are how nearly every MP4 on
the web is encoded, so X, Instagram, TikTok, Vimeo, Teams and every `.mp4` link
draw a black box. Turning them on rebuilds FFmpeg into `ffmpeg.dll` (1.8 MB →
3.8 MB here) and recompiles everything that includes the codec tables — about
6,600 steps, roughly 80 minutes on this machine, not a full tree rebuild.

They are not free to redistribute: the H.264 pool charges nothing below 100,000
units a year and AAC charges per unit. **The decision is therefore to decode
through the OS, not through FFmpeg we ship**: the dev build keeps these flags
because a browser tested against half the web is not a browser, a *release* build
has neither, and Windows' Media Foundation supplies both decoders — the Firefox
position since 2013. `docs/browser-os-decoders.md` is the staged plan (stage 1:
advertise the hardware H.264 the GPU process already decodes; stage 2: AAC through
Media Foundation), and stages 1–2 are the work item before a public download.

A release build must also keep `is_component_ffmpeg = true` while it still carries
FFmpeg at all (dev gets it from `is_component_build`) so FFmpeg stays a separate,
relinkable DLL — LGPL-2.1+.

`pnpm browser:smoke --codecs` fails if either half is missing, whichever half is
supposed to provide it.
`browser/tools/codecs.html` is the fuller matrix — point any built browser at the
file and read what it prints.

## A non-component build

Every build so far has had `is_component_build = true`: a small executable plus ~100
DLLs, one module relinked per C++ change. A release is the opposite — one image — and
that configuration has never been built here. Do it once, deliberately, before the
codec work, so a failure has one possible cause.

```bash
cd /c/Dev/cr/src
export PATH="/c/Dev/depot_tools:$PATH" DEPOT_TOOLS_WIN_TOOLCHAIN=0
export vs2022_install="C:\Program Files (x86)\Microsoft Visual Studio 2022\BuildTools"

gn gen out/NoComp --args='is_debug=false is_component_build=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_siso=false proprietary_codecs=true ffmpeg_branding="Chrome" enable_component_ffmpeg=true hook_host_path="C:/Users/user/Documents/Dev/Hook/target/release/hook-host.exe"'

autoninja -C out/NoComp chrome
```

A separate directory on purpose: `out/Dev` keeps working, and `build.mjs` keeps
owning it. Do not point `build.mjs` at `out/NoComp` — it writes `out/Dev/args.gn`
and runs Vite; a release configuration is generated by hand, once.

What to expect, so an overnight run is not a surprise:

- **Hours, not minutes.** The link alone is long; the compile is the same work with
  a different link step. Disk: budget tens of GB beside `out/Dev`.
- **`is_official_build` stays false**, so DCHECKs stay on and the build stays closer
  to what has been tested. Turning it on is a separate experiment (it changes
  optimisation, symbols and crash reporting).
- **`enable_component_ffmpeg = true` is not optional** while FFmpeg is carried: in a
  component build `is_component_build` supplies it, otherwise FFmpeg links into the
  image — LGPL-2.1+ requires it relinkable.
- **`hook_host_path`** keeps the browser able to start its own host; without the
  define it compiles, but the launcher has no path.

Test it the same way as any build:

```bash
node browser/tools/smoke.mjs --out out/NoComp                 # the seam, the dock
node browser/tools/smoke.mjs --out out/NoComp --side-panel --newtab --no-google
```

`--host` needs an empty channel like always; `--channel` needs a running Hook app.

What this is *for*: pricing the packaging work (a release build is the first input to
an installer or an MSIX), and getting the link configuration exercised before the
codec change lands on top of it (`docs/browser-os-decoders.md`).

## Switching from a siso build directory

The overlay is a junction and siso cannot read one, so `args.gn` pins
`use_siso = false` (see Traps). A fresh `out/Dev` therefore builds with ninja
from the start.

An `out/Dev` that was already built by siso still contains `.siso_deps`.
`build.mjs` clears that marker and says so, but ninja has no record of the
completed actions — siso never writes ninja's build log — so that first build
recompiles the tree: hours, once. Every output already on disk, including
`out/Dev/chrome.exe`, keeps working in the meantime; only a rebuild pays the
cost. Nothing in the repository depends on that build completing.

## Dev loop

Most product work does not need a Chromium build. WebUI is TypeScript and runs
against mocked mojo bindings in an ordinary browser, the same way `apps/chat`
already falls back to `mock.ts`. A real WebUI change in the tree is `autoninja`
plus a resource repack, not a rebuild.

The dock is React and needs no tree at all: `pnpm browser:ui:dev` serves
`browser/ui/preview.html`, which mounts the panel at 380px against the same
transport the browser uses. Change `packages/chat` or `packages/ui`, watch it
there, and run `pnpm browser:ui` when it looks right — the bundle it writes is
what the pak carries.

`http://localhost:5173/transport-test.html` is the check for the dock's live text,
with no browser and no model: it drives `channelTransport` with a fake handler and
feeds the events through the dock's own reducer rules. It exists because a reply
that is drawn twice is not a rendering detail — a poll used to report a new chunk
*and* the end of the turn, and the dock's frame-coalesced delta then landed after
`done` had already replaced the thread. Two rules keep that from coming back, and
the page fails loudly if either is broken:

- a delta only ever carries text the dock does not have yet (`shown`, seeded from
  the `started` snapshot);
- a delta only ever appends to the reply itself: when the reply appears after the
  send's snapshot, the transport sends `started` again rather than a delta that
  would glue the answer onto the user's message;
- a poll that finds the turn over emits `done` **instead of** a delta.

Build `chrome`, never `all`: `all` drags in every test binary.

## Testing it yourself

From cheapest to most honest. Everything in the first list works on a checkout
with no browser built and no tree fetched.

```bash
pnpm install                      # once: Vite, for the dock bundle
node browser/tools/verify.mjs     # tag, overlay rule, patch stack, junction
node browser/tools/build.mjs --gen-only   # the GN graph, ~15 s
pnpm browser:ui:dev               # the dock at 380px, no tree, no build
```

`preview.html` is the panel; `transport-test.html` is the same transport driven
by a fake handler, and it fails visibly if the dock's delta rules ever break.
Neither needs Chromium and neither has a model behind it.

The compiler checks the parts that are C++ without a full build: after
`--gen-only`, `ninja -C out/Dev hook/browser:browser hook/resources:resources`
compiles the whole overlay source set and lints/packs the WebUI resources —
minutes, because it builds only those targets' objects. Run it under the same two
variables `build.mjs` sets (`DEPOT_TOOLS_WIN_TOOLCHAIN=0`,
`vs2022_install=<VS install>`): a `BUILD.gn` edit makes ninja re-run `gn gen`, and
`gn` cannot find a VS 2022 BuildTools install without the second one.

**A built browser.** First check whether one is already there, because a tree that
has been built once looks identical to one that has not until you look inside
`out/`:

```bash
ls /c/Dev/cr/src/out/Dev/chrome.exe               # the binary exists…
cd /c/Dev/cr/src && ninja -C out/Dev -n chrome    # …and how much is left (0–N steps)
```

`-n` is a dry run: a handful of steps means minutes, "no work to do" means the
browser is current, and a long list is the cold build. Do **not** start from the
assumption that it is cold — this repository's checkout has been built before, and
`gn gen` regenerating `args.gn` (which `build.mjs` always does, because
`hook_host_path` is machine-specific) is cheap either way.

`node browser/tools/build.mjs` — hours from cold, the reason the exclusions below
come first. After that:

```bash
node browser/tools/smoke.mjs                  # the seam, the dock, one send
node browser/tools/smoke.mjs --side-panel     # chrome://hook-panel, pinned
node browser/tools/smoke.mjs --newtab         # Ctrl+T's page, and the first tab
node browser/tools/smoke.mjs --signin-state out   # the gate refuses, card drawn
node browser/tools/smoke.mjs --codecs         # H.264, AAC, VP9 all decode
node browser/tools/smoke.mjs --host           # the browser starts its own host
node browser/tools/smoke.mjs --channel        # the dock on real conversations
```

`--host` is the one that needs a second binary: close every Hook product first (a
host that is already answering means nothing is launched), and build the host.

```bash
pnpm browser:host               # cargo build --release -p hook-host
cargo build -p hook-host        # the debug one, seconds once the tree is warm
```

The release binary is what a packaged browser ships beside `chrome.exe`; `debug`
is what a dev tree builds, and `build.mjs` prefers `target/release` when both
exist. When a check fails, the smoke now prints the browser's exit code and the
last of its stderr instead of an empty target list — a browser that dies during
startup says why there.

`build.mjs` picks that up and writes its path into `out/Dev/args.gn` at `gn gen`
time, so **re-run `build.mjs --gen-only` after building the host** if you built
the browser first. A debug host is fine: the browser launches it with
`HOOK_DATA_DIR` pinned to `app.hook.browser` under the shared folder, so it does
not vanish into `%APPDATA%\hook-dev\` (`docs/browser-host.md`, "Starting it").

Two failure paths are worth provoking on purpose, because both are what a person
will actually see:

- rename `target/debug/hook-host.exe` and `--host` must fail with "Hook's host is
  not installed on this computer" on the card, not a hang;
- run `pnpm browser:smoke` with no `--host` and confirm no `hook-host.exe`
  survives it (`--hook-no-host` is passed, so a check leaves nothing behind).

**By hand**, which is what a tester actually does. Launch the binary with a
throwaway profile so it never touches a real one:

```bash
"C:\Dev\cr\out\Dev\chrome.exe" --user-data-dir=%TEMP%\hb --hook-side-panel
```

Then look at: the sign-in card (signed out, with "Starting Hook…" for the second
the host takes); Ctrl+T (Hook's new tab, not Chrome's); the side panel's dock at
380px, and one message sent into it; the tab strip (narrower, rounded, opaque
selection); a typed URL while signed out, which returns to `chrome://hook`.
`chrome://hook` itself shows the live tab list and the dock side by side — that
page is the seam, and it is the fastest way to see whether a change reached a
window.

## Traps

Each of these cost a night at least once.

- **`gclient sync --no-history` trips Google's anonymous rate limit.** Fetching
  ~100 deps shallow in parallel returns `429 RESOURCE_EXHAUSTED`. `sync.mjs`
  throttles to `--jobs 2` and retries.
- **A dep that loses that race is invisible afterwards.** It keeps a `.git` with
  no HEAD, so gclient considers it healthy and never re-fetches it, and the
  build dies much later with `missing and no known rule to make it`. `sync.mjs`
  finds those and removes them between attempts — that is the only in-place
  recovery.
- **Never run `gclient sync -D`.** With the overlay junctioned in, it can remove
  unmanaged directories. Plain `gclient sync` recreates the junction instead.
- **Set the symbol levels before the first build.** Changing them later forces a
  full recompile.
- **The SDK installer's `/features` replaces the default feature set.** A
  debuggers-only run marks the bundle installed, after which plain runs become
  silent no-op "modify"s; uninstall, then a plain `/q`. `/ceipoff` is not a
  switch it accepts, and elevating the bootstrapper directly deadlocks on its
  own setup mutex — elevate a wrapper script.
- **`DEPOT_TOOLS_WIN_TOOLCHAIN=0` is required off Google's network.** The
  downloadable toolchain is Googlers-only, and the tools set this for you.
- **A navigation throttle must never `Resume()` from a callback that can run
  inline.** `account::RequestSignedIn` answers immediately for a fresh cache, so
  resuming from its callback lands inside `WillStartRequest`, before the registry
  recorded the `DEFER` — content CHECKs that and the browser dies with
  `STATUS_BREAKPOINT` (0xC0000003) and `navigation_throttle_registry_impl.cc:261`.
  Ask `account::SignedInIfKnown()` and answer without deferring; only an unknown
  answer may defer.
- **A process-wide launcher has no thread of its own.** `hook::host::Launcher` is
  asked from the UI thread (the page handler) and from the channel's `/health`
  reply, which can run on a pool sequence. Its state lives on the UI thread, every
  waiter is answered on the sequence that asked, and it holds `base::Unretained`
  rather than a `WeakPtr` — a weak reference created on a pool thread may not be
  dereferenced on the UI thread, and that is a FATAL (`sequence_checker.cc:21`),
  not a warning.
- **`--no-google` is the answer to "does it still talk to Google".** It runs a fresh
  profile with `--log-net-log` and fails on any Google host outside a short allowlist
  (the component updater, plus preconnects, which carry no content). Three leaks were
  found this way and none of them was branding-gated: the New Tab Page **component
  extension** (a CRX the updater downloads, which fetched Google's page frame),
  Google's AI Mode eligibility check, and the search prewarm. When adding a Chromium
  feature that reaches a service, run it — `docs/browser-branding.md`, "What still
  talks to Google".
- **`safe_browsing_mode = 0` does not build in this tag.** Six targets — four
  `browser_tests`, `interactive_ui_tests`, and the shipping
  `chrome/browser/feedback/report_unsafe_site` — depend on
  `//components/safe_browsing/…` unconditionally, so `gn gen` fails on every one of
  them. The switch that works is the `kSafeBrowsingEnabled` pref default
  (`0014-safe-browsing-off`); `docs/browser-branding.md` explains what that leaves
  behind and why it is off.
- **A branding change is a patch, not an overlay path.** The product name and the
  icon live in files that already exist (`chrome/app/theme/chromium/BRANDING`,
  `chrome/app/chromium_strings.grd`, two `.rc` files), so they land in
  `0011-branding`. Two traps cost a build each the first time: `rc.exe`
  interprets `` and `	`, so an icon path needs **doubled** backslashes in both
  `.rc` files, and `grit` will not resolve a path that leaves `chrome/app`, so the
  in-product logos are replaced in place (`patch.mjs add` passes `--binary` for
  those). `docs/browser-branding.md` has the whole map; re-run
  `browser/tools/brand-strings.py` after a sync to catch the strings a new release
  added.
- **The side panel is narrower than the dock.** Chromium sizes the side panel
  (360 px today) and the dock is a fixed 380 px in the desktop window, so
  `panel.html` has to make it fill its host: `width: 100%; min-width: 0`. As a
  fixed 380 the dock was 20 px wider than the panel — the ✕ sat half outside it and
  a scroll pushed the whole dock left by the same 20 px. `--side-panel` asserts that
  the dock fits and that the close button is inside, rather than a pixel width, so
  the check survives Chromium resizing the panel.
- **Siso cannot read the overlay through the junction.** Its hashfs follows a
  Windows junction as an absolute symlink and refuses it (`store resolve next
  dir hook failed`). `args.gn` therefore sets `use_siso = false`, and
  `build.mjs` builds with ninja, which follows the junction. A directory that
  was previously built by siso recompiles everything once on the switch, because
  siso never wrote ninja's build log; `build.mjs` clears the siso marker and says
  so. Set `use_siso = true` again when siso learns junctions.

## Upgrading Chromium

Chromium moves every four weeks and security releases land in between. Falling a
quarter behind means shipping a vulnerable browser, so this is an obligation.

1. Change `VERSION` to the new tag and run `sync.mjs`.
2. `patch.mjs apply` — read every hunk. A hunk that applies cleanly can still be
   semantically wrong; that is the failure the stack exists to make visible.
3. `verify.mjs`, then `build.mjs`.
4. Run Chromium's own `browser_tests` and `content_browsertests` in CI, not
   locally — they are inherited for free and are the reason this stays
   affordable.

## Status

Step 0 of the POC plan is done on Windows: the tree builds at tag `159.0.8154.13`
and `out/Dev` is a ninja build (`use_siso = false`, because siso cannot read the
overlay junction). A C++ change is an `autoninja -C out/Dev chrome` away — minutes,
not hours — and a WebUI-only change is a resource repack.

Step 1 is complete, in `overlay/src/hook/` and ten small patches:

- `chrome://hook`, served from our own `hook_resources.pak`;
- the live tab list over mojom (`common/hook.mojom`, `browser/tabs/`), registered
  by the binder patch;
- the sign-in gate (`browser/navigation/hook_sign_in_throttle.cc`): while the
  machine has no account, a navigation to the web is cancelled and the tab is sent
  to `chrome://hook`. It reads the shared account file on a thread pool, never
  writes it, and `--hook-signin-state=in|out` makes it provable on a signed-in
  machine.

Step 2 is in. The dock from `packages/chat` runs at 380px, on `packages/ui`
tokens, served from the pak — as a pane of `chrome://hook` and as a real
side-panel entry (`chrome://hook-panel`, `browser/ui/views/`, entry id + action
item patches). `--hook-side-panel` opens it, and the toolbar's pin keeps it.

The signed-out page is the shared sign-in card from `packages/ui`, mounted from
the same bundle: it shows the device code, offers the page again, cancels, and
polls until the app writes the account file — then the page reloads and the gate
lets the web back in. `StartSignIn`/`CancelSignIn` go through the browser process
to the running app's channel (`/auth/start`, `/auth/status`, `/auth/cancel`), so
the page never holds a token. Without an app the card says so and links to
hookcode.io, which is the one thing a browser cannot do on its own: the account
file belongs to `auth.rs`.

The New Tab page is `chrome://hook-newtab` (`newtab.html`, `newtab.css`,
`newtab.ts`: the wordmark, a greeting that is true of the clock, three chips) and
a new tab opens it because `ChromeUINewTabURLAsGURL()` returns it — one hunk in
`chrome/common/webui_url_constants.cc`, since Ctrl+T, the plus button, the first
window and a crash-restore tab all ask that one function. `chrome://newtab` typed
by hand is still Chrome's own page.

The tab strip is restyled (patch 0010): `chrome/browser/ui/tabs/tab_style.cc` is
narrower tabs (214 DIP), rounder corners (13/15), and
`chrome/browser/ui/color/tab_strip_color_mixer.cc` makes the selected tab opaque
instead of a 75% wash, so it reads as a card in the strip. It is Views and it is
the most expensive surface to change, which is why it is the last one and the
smallest diff.

Step 3's cheap proof is in, and so is page context: a **running Hook app**
publishes a loopback channel (`crates/hook-core/src/channel.rs`) beside the account
file, and the browser process reads it for the page. `pnpm browser:smoke --channel`
against a running Hook app is the demonstration: it listed 33 real conversations,
read a 48-message transcript, and got the backend's refusal for an empty message.

The host is **`hook-host`** (`crates/hook-host`): the backend with no window, no
tray, no IPC surface and no Tauri — it links `hook-core` with
`default-features = false`, so `commands.rs` and `update.rs` are not even
compiled. It is `Product::Browser`, with its own data folder
(`%APPDATA%\app.hook.browser`) and its own channel descriptor. **The browser
starts it itself** when no channel answers
(`overlay/src/hook/browser/host/hook_host.cc`): one launch per browser run (again
if the host it started exits), a path fixed at build time, and the descriptor
accepted only when its `pid` is the child's. `--hook-no-host` turns it off, and
`pnpm browser:smoke --host` asserts the launch, the pid and that `/health`
reports the `browser` product.
`hook --headless` still exists as the chat app with no window — it is what
`--channel` borrows for a machine with no `hook-host` build — but the browser no
longer depends on it. The design, the two shapes it considered and the order of
work are in `docs/browser-host.md`; steps 1–4 are in.

`pnpm browser:smoke` is the check for all of it, so the answer to the POC's question —
does our overlay reach Chromium, and can the Hook chat surface live inside it — is
yes.

## The channel

The dock's real backend is a *running* Hook host, not a server: `hook-core`'s
`channel.rs` binds an ephemeral loopback port and writes
`%APPDATA%\app.hook\browser-channel.<product>.json` (`port`, `token`, `pid`,
`product`, `version`) beside the shared account file, atomically and `0600` on
unix — `browser-channel.browser.json` for `hook-host`, `.chat.json` for Hook,
`.workspace.json` for Hook Workspace. One file per product, because the folder is
shared and a Hook app in the tray running beside the browser's own host is the
normal case: neither may overwrite the other's token. The browser reads its own
name first and falls back to the others (and to the bare `browser-channel.json`
of a host that has not been rebuilt), so a machine with no `hook-host` still
works. When nothing answers, **the browser starts its own**.

A debug build writes its descriptor with its own data instead, under
`%APPDATA%\hook-dev\app.hook\`, so a development Hook never takes over the
installed app's channel — which is why the browser launches the host with
`HOOK_DATA_DIR` naming the folder its gate reads. Quitting Hook removes its
descriptor; a killed process leaves it behind, which is why "available" means
**`/health` answered**, not "a file exists".

Routes, all requiring `Authorization: Bearer <token>` except `/health`: `/chats`,
`/chats/{id}`, `POST /chats`, `POST /chats/{id}/send`, `POST /chats/{id}/stop`.
Nothing is served while signed out, and nothing writes a setting, a title or a
delete: the channel reads and sends, and the window keeps the rest.

Three constraints decided the shape, and each cost an attempt to learn:

1. **The page cannot make the call.** A `chrome://` renderer is terminated by
   Chromium for a cross-scheme request (`Incorrect scheme`) — not blocked, killed.
   So `hook/browser/channel/hook_channel.cc` makes it in the browser process and
   the answer travels over mojom (`hook_page_handler.cc`). The token therefore
   never reaches the page.
2. **The UI thread may not read the file at startup.** The page asks for the
   channel as soon as it loads, which can be inside the browser's startup tasks
   where blocking work is a `DCHECK`. The descriptor is read on a thread pool.
3. **`DownloadToString` has a 5 MB cap** (`kMaxBoundedStringDownloadSize`) and
   `DCHECK`s above it, so the reply bound is that constant, not a hopeful number.

The transport (`browser/ui/transport.ts`) polls `getChat` every ~350 ms while the
chat says `busy`, and emits the dock's `delta` events from the text that grew.
That is enough for the typing to read as live, and it leaves the dock's event
contract untouched for the day a real stream (or the sidecar) arrives.

The sidecar this stands in for is Step 3's shipping shape: auth and the turn out
of process, published at the same routes, with `browser/ui/transport.ts` as the
only file that changes. `docs/browser-poc-plan.md`, "What shipping needs", lists
the rest.
