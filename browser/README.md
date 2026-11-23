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
round trip. `--shot <png>` saves a screenshot, `--chrome <path>` points it at
another binary. Run it **after** a build, never during one: it maps DLLs out of
`out/` and the linker cannot overwrite a file that is mapped.

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
and a stock Chromium runs. Step 1's seam is in on both halves — `chrome://hook`,
served from our own `hook_resources.pak` and drawn by
`overlay/src/hook/resources/`, and the live tab list read over mojom through a
binder registered by the fourth patch. The signed-out navigation throttle is the
rest of Step 1.

Step 2's first surface landed with the ninja rebuild: the chat dock from
`packages/chat` at 380px beside the seam page (`browser/ui/`, `pnpm browser:ui`).
It is a pane in `chrome://hook` rather than a Views side-panel entry; the
`SidePanelEntry` host and the New Tab page are next.

`out/Dev` is a ninja build now (`use_siso = false`, because siso cannot read the
overlay junction). A C++ change is an `autoninja -C out/Dev chrome` away, and a
WebUI-only change still needs nothing but a resource repack.

`pnpm browser:smoke` is the check that all of that reached a window: it launches
the built browser with a throwaway profile, opens `chrome://hook` over the
DevTools protocol, and asserts the live tab list, the dock at 380px, the composer
and one send round trip. It passes at tag `159.0.8154.13`, so the answer to the
POC's question — does our overlay reach Chromium, and can the Hook chat surface
live inside it — is yes.
