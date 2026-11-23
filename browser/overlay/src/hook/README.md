# The overlay

`tools/sync.mjs` junctions this directory into the Chromium checkout as
`src/hook`, so `//hook` in a GN file resolves here and editing a file here
edits the bytes Chromium compiles. Nothing is copied and nothing is stashed.

## The rule

**New paths only. Never copy an upstream file into this directory.**

Copying `tab_strip.cc` here to "just tweak it" recreates the merged fork that
we chose not to take, one file at a time, and nobody later knows which copies
are stale. If upstream behaviour has to change, that is a patch in
`browser/patches/` — visible, reviewable, revertable, and it fails loudly when
upstream moves.

`tools/verify.mjs` enforces this: a path under `overlay/src/` that also exists
upstream is an error. Paths under `hook/` are our namespace, so they are exempt.

## Layout

Mirrors `src/` inside the checkout:

```
overlay/src/hook/
  browser/            C++ — the WebUI controller, the tab reader, later the tab model
    tabs/             the live tab list (BrowserWindowInterface, read-only)
    ui/webui/         chrome://hook's controller and its mojom handler
  common/             mojom IDL for the WebUI <-> browser IPC, shared constants
  app/                branding, icons, .grd strings, resources
  resources/          the chrome://hook page: hook.html/ts/css, and panel.mjs
                      (the dock, built by `pnpm browser:ui` from browser/ui/)
  rust/               hook-core, built without Tauri
  tests/              our own browser tests
```

Step 1's seam is in `browser/` and `resources/`: the page is served from the
generated `hook_resources.pak`, and it reads the live tab list over
`common/hook.mojom`. Step 2's first surface is `resources/panel.mjs` — the dock
from `packages/chat`, mounted beside the seam page at 380px. The signed-out
navigation throttle is what is left of Step 1.
