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
  browser/            C++ — agent controller, tab model, ad interception, vault
  common/             mojom IDL for the WebUI <-> browser IPC
  app/                branding, icons, .grd strings, resources
  browser/resources/  WebUI: the React surfaces
  rust/               hook-core, built without Tauri
  tests/              our own browser tests
```

Empty until Step 1 of `docs/browser-poc-plan.md` proves the seam.
