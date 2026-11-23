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
  browser/            C++ — the WebUI controllers, the tab reader, the gate, the channel
    account/          where Hook's shared files are (account.json, the descriptor)
    channel/          the client for a running Hook app's loopback channel
    navigation/       the sign-in gate (a NavigationThrottle)
    tabs/             the live tab list (BrowserWindowInterface, read-only)
    ui/views/         the dock's side-panel entry
    ui/webui/         chrome://hook and chrome://hook-panel, their handler and data source
  common/             mojom IDL for the WebUI <-> browser IPC, shared constants
  app/                branding, icons, .grd strings, resources
  resources/          hook.html/ts/css (the seam page), panel.html and panel.mjs
                      (the dock, built by `pnpm browser:ui` from browser/ui/)
  rust/               hook-core, built without Tauri
  tests/              our own browser tests
```

Step 1 is complete in `browser/` and `resources/`: the page is served from the
generated `hook_resources.pak`, reads the live tab list over `common/hook.mojom`,
and `navigation/` turns a signed-out web navigation into the page itself. Step 2's
surfaces are `resources/panel.mjs` — the dock from `packages/chat`, mounted beside
the seam page at 380px — and `ui/views/`, which is the same document as a side
panel entry. `channel/` is how the dock reaches a running Hook app: the browser
process makes the call, because a `chrome://` renderer may not.
