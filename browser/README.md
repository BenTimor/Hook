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
- ~120 GB free: ~27 GB of tree, ~12 GB of build output, growing with the tree.

## The four commands

```bash
node browser/tools/sync.mjs      # fetch/refresh the tree at browser/VERSION (~30-90 min clean)
node browser/tools/build.mjs     # gn gen + autoninja -C out/Dev chrome (hours, once)
node browser/tools/verify.mjs    # tag, overlay rule, patch stack, junction
node browser/tools/patch.mjs     # list | add <slug> [-- paths] | apply
```

`sync.mjs` also creates the `src/hook` junction, adds `hook/` to the checkout's
`git/info/exclude`, and reports a missing SDK before a build wastes time. The
tree defaults to `C:\Dev\cr`; override with `--root` or `HOOK_CHROMIUM_ROOT`.

`build.mjs --gen-only` stops after `gn gen`, which is what a WebUI-only iteration
usually needs.

## Dev loop

Most product work does not need a Chromium build. WebUI is TypeScript and runs
against mocked mojo bindings in an ordinary browser, the same way `apps/chat`
already falls back to `mock.ts`. A real WebUI change in the tree is `autoninja`
plus a resource repack, not a rebuild.

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
and a stock Chromium runs. The overlay is empty — Step 1, the seam
(`chrome://hook`, the mojom tab list, the sign-in throttle), is not written.
