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
| `--shot <png>` | saves a screenshot (`-panel.png` for the side panel) |
| `--chrome <path>` | points it at another binary |

Run it **after** a build, never during one: it maps DLLs out of `out/` and the
linker cannot overwrite a file that is mapped. `--channel` needs the Hook app
running on this machine; every other flag runs alone.

## The dock bundle

`browser/ui/` is the panel's own little Vite project: `panel.tsx` mounts
`ChatDock` from `packages/chat`, `transport.ts` is the `ChatTransport` the
browser has for now (local, until the Step 3 sidecar), and `shiki-stub.ts`
answers `highlight.ts` with Shiki's own fallback so the pak does not grow every
grammar and theme as a chunk.

`pnpm browser:ui` writes the result to
`browser/overlay/src/hook/resources/panel.mjs` — one ES module with the
stylesheet inlined, which `build_webui` packs into `hook_resources.pak`. The
file is generated but **committed**, and both halves of that are deliberate:

- Chromium's WebUI build compiles Lit and TypeScript and ships no React, so the
  shared surface cannot be built by `build_webui` itself. `build_webui` also
  refuses `.js` in `static_files` and lints every `.css` it is given against
  Chromium's stylelint config, which a bundle has no reason to satisfy — hence
  `.mjs` and the inlined stylesheet.
- Committing it keeps `gn gen` hermetic and works before `pnpm install` has ever
  run for a new contributor. The cost is a generated file: regenerate it in the
  same commit as any change under `packages/chat/src` or `packages/ui/src`, or
the panel silently shows the old surface. A build-time `action()` that runs
Vite into `$root_gen_dir` is the cleaner shape and the follow-up; it needs the
repository's `node_modules` as a declared input, which GN cannot see.

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

Step 1 is complete, in `overlay/src/hook/` and eight small patches:

- `chrome://hook`, served from our own `hook_resources.pak`;
- the live tab list over mojom (`common/hook.mojom`, `browser/tabs/`), registered
  by the binder patch;
- the sign-in gate (`browser/navigation/hook_sign_in_throttle.cc`): while the
  machine has no account, a navigation to the web is cancelled and the tab is sent
  to `chrome://hook`. It reads the shared account file on a thread pool, never
  writes it, and `--hook-signin-state=in|out` makes it provable on a signed-in
  machine.

Step 2's first surfaces are in: the dock from `packages/chat` at 380px, on
`packages/ui` tokens, built by `pnpm browser:ui` and served from the pak — as a
pane of `chrome://hook` and as a real side-panel entry (`chrome://hook-panel`,
`browser/ui/views/`, entry id + action item patches). `--hook-side-panel` opens
it, and the toolbar's pin keeps it. The New Tab page and the shared sign-in card
are what is left of Step 2.

Step 3's cheap proof is in, and so is page context: a **running Hook app**
publishes a loopback channel (`crates/hook-core/src/channel.rs`) beside the account
file, and the browser process reads it for the page. `pnpm browser:smoke --channel`
against a running Hook app is the demonstration: it listed 31 real conversations,
read an 11-message transcript, and got the backend's refusal for an empty message.

`pnpm browser:smoke` passes for all of it, so the answer to the POC's question —
does our overlay reach Chromium, and can the Hook chat surface live inside it — is
yes.

## The channel

The dock's real backend is a *running* Hook app, not a server: `hook-core`'s
`channel.rs` binds an ephemeral loopback port and writes
`%APPDATA%pp.hookrowser-channel.json` (`port`, `token`, `pid`, `product`,
`version`) beside the shared account file, atomically and `0600` on unix. Quitting
Hook removes it; a killed process leaves it behind, which is why "available" means
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
