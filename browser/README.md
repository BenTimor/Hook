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

## Assertions, and the two builds

There are two, and they differ on one deliberate point.

**`out/Dev` keeps Chromium's default: a `DCHECK` failure kills the process.**
That is the net that catches our own mistakes while we iterate on C++, so it
stays. The cost is that Blink's own assertions fire on real pages — `bentimor.com`
dies at `compositor_animations.cc:589` (`!any_compositor_properties_present`) —
because Chromium makes every DCHECK fatal whenever `is_official_build` is false
(`build/config/dcheck_always_on.gni`). Nothing on the page is wrong and nothing
Hooks did; a shipping Chrome never runs that code because official builds compile
DCHECKs out.

**`out/NoComp` turns them off** (`dcheck_always_on = false`). It is the build we
judge pages with — the recipe's own comment says "so a failure has one possible
cause" — and a browser that dies on an ordinary page cannot be used for that. With
the flag off, `DCHECK` is compiled out exactly as in the product, so this build
behaves like shipping Chrome: no assertion crashes, no assertion overhead.

The trade is that a bug of ours which only trips a DCHECK is silent in `NoComp`
and loud in `out/Dev`, which is the right way round: Dev finds it, NoComp is what
a person sees. If you want Dev's net without the fatal crash for one session,
build with `dcheck_is_configurable = true` and add
`--enable-features=DcheckIsFatal` only when hunting — but the flag lands in every
translation unit, so flipping it either way recompiles the whole tree (~35,000
steps here). That is why it is not in `args.gn`: the tree must not start a
two-hour rebuild because someone opened a page.

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

A release build ships FFmpeg as a separate, relinkable DLL (LGPL-2.1+) — so
`is_component_ffmpeg = true` for a release, and a *signed* `ffmpeg.dll`, because the
renderer's code-integrity guard refuses an unsigned one (see "A non-component
build"). A local unsigned build therefore links FFmpeg into the image, which is
also what the check builds do.

`pnpm browser:smoke --codecs` fails if either half is missing, whichever half is
supposed to provide it.
`browser/tools/codecs.html` is the fuller matrix — point any built browser at the
file and read what it prints.

## A non-component build

Every other build has `is_component_build = true`: a small executable plus ~100
DLLs, one module relinked per C++ change. A release is the opposite — one image.
This directory is that configuration: built from scratch once, deliberately before
the codec work so a failure had one possible cause, and refreshed by hand since.

```bash
cd /c/Dev/cr/src
export PATH="/c/Dev/depot_tools:$PATH" DEPOT_TOOLS_WIN_TOOLCHAIN=0
# vswhere -products '*' -property installationPath reports this machine's path
# (BuildTools installs under Program Files (x86), one folder deeper than 2022\)
export vs2022_install="C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools"

gn gen out/NoComp --args='is_debug=false is_component_build=false dcheck_always_on=false symbol_level=0 blink_symbol_level=0 v8_symbol_level=0 use_siso=false proprietary_codecs=true ffmpeg_branding="Chrome" hook_host_path="C:/Users/user/Documents/Dev/Hook/target/release/hook-host.exe"'

autoninja -C out/NoComp chrome
```

A separate directory on purpose: `out/Dev` keeps working, and `build.mjs` keeps
owning it. Do not point `build.mjs` at `out/NoComp` — it writes `out/Dev/args.gn`
and runs Vite. Refresh it by hand: `pnpm browser:ui` first if `packages/chat` or
`browser/ui` changed (that is the Vite step `build.mjs` does for `out/Dev`), then
`gn gen out/NoComp` with no `--args` (that keeps the existing `args.gn`, which is
the whole point of the directory) and `autoninja -C out/NoComp chrome`.

**A refresh is minutes, not hours**; the overnight run is the first one only.
Ninja compiles what the overlay and the patch stack touched and relinks the rest,
so the bill is one 351 MB `chrome.dll`. Measured on this machine, refreshing after
the CDP work landed (two translation units and the resource pak):

| step | time |
| --- | --- |
| `pnpm browser:ui` | under a second |
| `gn gen out/NoComp` | 13 s, 37,285 targets |
| `autoninja -C out/NoComp chrome` | 22 s, 15 planned steps, mostly the link |
| `pnpm browser:check --out out/NoComp` | about a minute and a half |

`gn gen` is not extra work: ninja regenerates `build.ninja` itself when a
`BUILD.gn` moves. Running it first just fails fast and prints the target count.
The exception to "minutes" is a patch that edits a header half the tree includes —
the rebuild is then proportional to that header's reach, and the step count before
it starts says which one you got.

What to expect from the first, from-scratch build, so an overnight run is not a
surprise:

- **Hours, not minutes the first time.** The link alone is long; the compile is the
  same work with a different link step. Disk: budget tens of GB beside `out/Dev`.
- **`is_official_build` stays false** — turning it on is a separate experiment: it
  changes optimisation, symbols and crash reporting. DCHECKs are compiled in but
  not fatal (`dcheck_always_on=false`), which is what makes this the build pages
  are judged on: a Blink assertion must not kill a page a person is reading
  ("Assertions, and the two builds").
- **Leave `is_component_ffmpeg` alone (it defaults to `is_component_build`, so false).**
  There is no `enable_component_ffmpeg` — gn warns that the argument has no effect and
  ignores it. Setting `is_component_ffmpeg = true` builds a separate, unsigned
  `ffmpeg.dll`, and in a non-component build that kills every renderer: the sandbox's
  code-integrity guard (`MITIGATION_FORCE_MS_SIGNED_BINS`, applied to renderers only
  when `!defined(COMPONENT_BUILD)` in `chrome_content_browser_client.cc`) allows
  `chrome_elf.dll` and `chrome.dll` by path and nothing else, so loading `chrome.dll`
  pulls in an `ffmpeg.dll` the policy refuses — "Failed to load Chrome DLL … Windows
  cannot verify the digital signature for this file", once per renderer, and pages
  never draw.
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

**After a build, run the whole matrix instead** — `pnpm browser:check`
(`smoke.mjs --all`). It is the list above arranged into five launches, about a
minute and a half, and it fails on any of them:

```bash
pnpm browser:check
pnpm browser:check --out out/NoComp       # the same checks on another build
```

Five launches for six checks: the plain baseline, the two sign-in states and
`--host` each need their own (a launch flag cannot be changed once the browser is
up), and the four surface checks share one, because by then it is open anyway. The
signed-in launch also reads `chrome://components` (`--components`) and fails if the
component updater registered anything outside its allowlist, or stopped registering
one of the three it keeps — a rename upstream, which would silently stop a security
component (`docs/browser-branding.md`, "The component updater"). Two of the six are conditional, and the two that are each other's
precondition: `--host` proves a launch, so it needs no channel answering;
`--channel` proves a running Hook app's conversations, so it needs one. The one
that cannot run is **listed and says why**, because a check that disappears from a
summary reads as one that passed:

```
  – its own host     skipped: a channel is already answering, and this check proves a launch
  ✔ the channel      passed in 10 s
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

**By hand**, with a throwaway profile, when the question is "did this change reach a
window":

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

## Testing it like a person

The checks above prove the seams. They do not prove the browser: a fork breaks in
places no script looks — a dialog that lost its layout, a download that never
starts, a page that renders in Times because a font token was undefined. That pass
has its own rules.

**Use the build that ships.** `out/NoComp` once it exists. `out/Dev` is a *component*
build: hundreds of DLLs, `DCHECK`s on. That is better for finding bugs (an invariant
violation aborts instead of sailing on) and worse for anything perceptual — startup,
memory, frame pacing. Never quote a performance number measured on it, and expect
first paint to feel slower than it will.

**Use the real profile.** The browser's is Chromium's default,
`%LOCALAPPDATA%\Chromium\User Data`; it shares nothing with Chrome's, which is the
point of the product name in `BRANDING`. Real use means cookies, history, saved
passwords and a session that has to restore — so test on it, not on a temp folder.
For the first-run pass (an empty dock, the gate's device flow) move that folder
aside first, then put it back: a *warm* profile is where the interesting failures
live.

**Start it the way a user does** — no switches, from Explorer or a shortcut. The
host launches with it, the gate finds the account, nothing is pre-set.
`--hook-no-host` exists for the checks and defeats the point here.

Then the passes, in the order a new user meets them:

1. **First run, signed out.** The gate draws the card, its code matches the Hook
   app's, a typed URL comes back to `chrome://hook`, and signing in through the
   device flow lands on the page with the dock alive. `hook-host.exe` appears in
   Task Manager and is gone when the browser closes.
2. **Identity.** Title `New tab - Hook Browser`; the taskbar and Alt-Tab show the
   Hook mark; `chrome://version` and "About Hook Browser"; `chrome://credits` still
   credits Chromium (the notices are the licence, not branding); no "Google API keys
   are missing" infobar.
3. **The surfaces our patches touch.** Ctrl+T lands on our new tab page; the tab
   strip at one tab, two tabs, after a drag, a middle-click and a close; session
   restore after a kill (see 8). The side panel: pin it, narrow the window to where
   the 360px dock used to clip, close it with ✕, reopen it, restart and check it
   came back.
4. **The dock.** One message end to end — streaming reads as typing, not as a jump;
   an image attachment and its lightbox; a `/` command in advanced mode; a Workspace
   preview (board, task, document); the "not in the cloud" mark on an unsynced chat.
   With the Hook app running instead, the `--channel` check covers the wiring — here
   you are testing the *feel* at 380px and the composer's behaviour.
5. **Media.** A local `.mp4` with H.264 and AAC; YouTube (VP9/AV1 path);
   `chrome://media-internals` when something refuses; a WebRTC call with camera, mic
   and screen share; the PDF viewer; Ctrl+P — print preview is a whole WebUI, and
   forks break it quietly. DRM services (Netflix, Disney+, Prime) **must fail**
   today: there is no Widevine until the licence is signed. That is expected.
6. **Downloads.** A `.exe`, a `.zip`, something large: the shelf, Open, Show in
   folder, and that the file-type classification still happens (FileTypePolicies is
   one of the three components kept).
7. **Passwords and autofill.** Save, revisit, autofill, generate. The strength meter
   should still work — Zxcvbn's dictionary was dropped with the updater narrowing, so
   expect less precision, not a broken field.
8. **Kill it.** End `chrome.exe` mid-session: relaunch offers to restore, and no
   `hook-host.exe` survives. Kill one renderer: that tab shows a crash page and the
   browser stays up.
9. **Offline and slow.** DevTools → offline (the dock's error copy), 3G throttling,
   a hostname that does not resolve.
10. **Settings sweep.** The pages that used to reach Google: search engines (Google,
    and no "update engine" call), sync (absent or off), translate (present, on
    demand), Safe Browsing (toggle present, off), privacy. When unsure, record with
    `chrome://net-export` and read it rather than guessing.
11. **Long session.** Twenty tabs, a paused video, sleep/resume the machine. Then
    leave it idle with the dock open on a signed-in account: the transport polls at
    350 ms *only while a turn runs*, so idle CPU must be ~0 %. If it is not, that is
    ours, not Chromium's.
12. **Extensions.** `chrome://extensions` → Developer mode → Load unpacked, with an
    MV3 extension. Installing from the Web Store needs a Google sign-in this build
    does not offer, so that path is out of scope until the decision exists.

When something breaks, the browser keeps its own stderr: launch once with
`--enable-logging=stderr --v=1` from a terminal and reproduce, and the log names the
component that refused or the WebUI that failed. `chrome://crashes` is empty on
purpose — crash upload is off with the rest of Google's telemetry.

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
- **Every renderer dies with "Windows cannot verify the digital signature".** That is
  not a signing problem, and `--allow-third-party-modules` does not help: in a
  non-component build the renderer sandbox enforces code integrity, and the only
  modules it allows by path are `chrome_elf.dll` and `chrome.dll`. A separate
  `ffmpeg.dll` (from `is_component_ffmpeg = true`) is not on that list, so loading
  `chrome.dll` fails for every child process and no page ever draws. Leave
  `is_component_ffmpeg` false for an unsigned build. The tell in the log is one
  `main_dll_loader_win.cc` line per process plus zero `--type=renderer` processes.
- **A release build fails to compile on a member that only a `DCHECK` reads.**
  `-Wunused-private-field` is an error, and with `dcheck_always_on=false` a
  `base::ThreadChecker` that is only named in `DCHECK_CALLED_ON_VALID_THREAD` is
  unused: `hook_host.cc`'s did exactly that. Mark such members `[[maybe_unused]]`.
  Any shipping build compiles DCHECKs out, so this is not a dev-only annoyance.
- **Media never starts when the window is occluded**, which a check run's window
  always is: `<video>` sits at `readyState 0`, `networkState 2`, one `stalled` event,
  and no media pipeline is ever created (nothing in the log). Pass
  `--disable-backgrounding-occluded-windows --disable-renderer-backgrounding
  --disable-features=CalculateNativeWinOcclusion`, as `smoke.mjs` does, before
  believing a playback failure.
- **Never run `gclient sync -D`.** With the overlay junctioned in, it can remove
  unmanaged directories. Plain `gclient sync` recreates the junction instead.
- **"Aw, Snap! ... STATUS_BREAKPOINT" on a page that works in Chrome is a
  DCHECK, not a network error.** It means the renderer was killed by an
  assertion (`__debugbreak`, hence the Windows code) that official builds do not
  compile in. Re-run with `--enable-logging=stderr` and read the `FATAL` line for
  the file and the failed condition. `out/Dev` is where that is fatal on purpose;
  `out/NoComp` sets `dcheck_always_on = false` and does not have the problem, so
  a page that dies this way in Dev is still testable there (see "Assertions, and
  the two builds").
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
item patches). Its toolbar button is a pinned action, pinned by default
(`0019-panel-button`), so a fresh profile has the dock one click away;
`--hook-side-panel` opens the panel at startup without clicking.

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
