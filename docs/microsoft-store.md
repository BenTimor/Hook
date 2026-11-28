# Microsoft Store (MSIX)

The second channel: Partner Center identity, the package, the taskbar icon, Store updates and policy 11.16.

Hook also ships as an MSIX through the Microsoft Store. Microsoft signs that
package with its own certificate, so Store installs never see a SmartScreen
prompt even though the direct installer is unsigned. This is a second channel,
not a replacement: the direct NSIS installer and the custom updater keep
working, and the same source will later build macOS and Linux packages.

## One-time setup (Partner Center)

1. Create a free developer account at
   [storedeveloper.microsoft.com](https://storedeveloper.microsoft.com). A
   Company account needs a D-U-N-S number (or incorporation/registration
   documents) and a business-domain email; an Individual account verifies with
   an ID and selfie. Both are free.
2. Partner Center → Apps and Games → New product → **MSIX or PWA app** → reserve
   the name `HookCode`.
3. On the product's **Package identity** page, copy the Identity Name (for
   example `BenTimor.HookCode`), the Publisher (`CN=...`) and the Store ID
   (`9N...`).
4. Fill `msix/chat/identity.json` with those values and a publisher display name.
5. Put the Store ID in both places that carry it: `harness.config.ci.toml` for
   the packaged app, and `release.config.json` for the website.

   ```toml
   [update]
   store_id = "9N..."
   ```

   ```json
   { "store": { "productId": "9N...", "latest": null, "minimumVersion": "0.1.0" } }
   ```

The reserved product name is **HookCode**; the MSIX display name matches it, while
the app's own window and chat UI stay branded **Hook**. Until step 4,
`node scripts/build-msix.mjs` prints these instructions and exits without
packaging, so a direct release is never blocked by an unconfigured Store
identity.

The listing is whitelisted, so it opens only for accounts Microsoft has approved.
That is why the website shows its button on the approved screen and nowhere else:
`/api/waitlist/status` returns `store: { productId, url }` from
`storeListing()` in `server/releases.mjs`, which reads the id out of
`release.config.json`. The packaged app keeps its own copy in
`harness.config.ci.toml`, because a Store build cannot ask the server which
listing it came from.

## Build the package

```bash
pnpm app:msix      # fetch the engine, build Hook.exe, package the MSIX
```

The result is `release/Hook-<version>-x64.msix` (about 84 MB with the bundled
engine and git). CI does not package the Store build: it is made here, on
demand, from the commit that was published, and submitted when you decide to
(`pnpm release -- --store` packages it and prints the submit command). The
package is deliberately unsigned: Partner Center re-signs Store submissions, and
signing it yourself with a self-signed certificate only breaks the upload. For
local sideload testing, pass `--sign dev.pfx --password …` to sign with a
development certificate.

A package version has four numeric parts, so the script writes `<semver>.0`
(0.2.1 → `0.2.1.0`) and the manifest is not edited by hand. Every Store
submission needs a version higher than the one you published before it, which a
`pnpm version:bump patch` per submission already gives you.

The package contains `Hook.exe` plus `resources/pi-runtime` and `resources/git`,
and declares `runFullTrust` (the coding agents spawn a bundled Node runtime and work in the
user's project folders) and `unvirtualizedResources`. The latter opts
`%APPDATA%\app.hook.chat` out of MSIX AppData virtualization, so the Store and
direct builds share chats, sign-in and project notes — and uninstalling the
Store app does not delete them. It needs the Evergreen WebView2 Runtime, which is
preinstalled on Windows 11 and on Windows 10 machines with Edge; the Store
listing states the requirement.

`makeappx` is taken from the newest installed Windows SDK, which must know the
`uap17` namespace the manifest uses (the 10.0.26100 SDK does; anything from
Windows 11 24H2 on does). An older SDK rejects the manifest instead of producing
a package that fails the same way at install time.

## The taskbar icon

A packaged app's taskbar, Start and search icon is drawn on a square *plate*
filled with `uap:VisualElements/@BackgroundColor` unless the package carries
the per-size, unplated AppList assets. Hook's mark is a rounded square, so the
plate showed through its four corners: with `BackgroundColor="transparent"`
that is the user's accent colour, which looked like a red ring around the
taskbar button on a red-accent machine. The manifest therefore names the mark's
own fill (`#191817` for chat, `#171716` for Workspace), and
`pnpm msix:icons` renders
`Square44x44Logo.targetsize-<n>[_altform-unplated|_altform-lightunplated].png`
(14 sizes × 3 themes) from `apps/<product>/src-tauri/icons/icon.png`. Those
files are part of the icon set, not a build output: `tauri icon` does not make
them, so rerun `pnpm msix:icons` whenever the mark changes. The names follow the
`Square44x44Logo` attribute — rename one and rename the other.

## Updating a Store install

MSIX never services a package that is in use. An update that finds Hook running
fails with `ERROR_PACKAGES_IN_USE` (`0x80073D02`) — and the Store reports that as
a failed update with no reason at all, which reads as "try again". Closing Hook
is what makes it work, because the package's files (the exe and the bundled
`resources/pi-runtime` and `resources/git` that agent subprocesses load) are
locked while it runs. Two things keep that from being the user's problem:

- The manifest declares `<uap17:UpdateWhileInUse>defer</uap17:UpdateWhileInUse>`
  in `<Properties>`. Windows then **holds** the update and finishes it the next
  time Hook closes, instead of failing. Honoured on Windows 11 24H2 (build
  26100) and later; older Windows ignores it, so it is listed in
  `IgnorableNamespaces`.
- The in-app Store button closes Hook before it hands over
  (`open_store_update` → `update::open_store_for_update`), so the deployment
  never meets a locked package on any Windows version. `on_exit` stops the
  coding agents and the preview server first, which is what actually releases
  the package files. Reopening Hook is the user's job — Windows will not
  relaunch a full-trust app after a Store install.

Neither reaches an install whose package predates the change; that one update
still needs Hook closed by hand. `scripts/msix.test.mjs` fails if a template
loses the element, the namespace or a placeholder the packager fills.

## Store policy 11.16: live generative AI

Hook replies and coding-agent steps are created live by a model, so the Store
requires four things — all but the Partner Center declarations are handled by
the app:

| Requirement | Where |
|---|---|
| Disclose live generative AI in the listing | description draft below |
| Declare it in Partner Center | Properties → “This product incorporates generative AI features” |
| Let users report inappropriate output | **Report** on every assistant reply, with an optional “include the whole conversation” toggle |
| Act on reports | `./scripts/ai-reports.sh --list`, `--show <id>`, `--resolve <id>` |

The endpoint is `POST /api/reports` (approved accounts only). It stores the
reported reply, reason, optional note, optional transcript, account and app
version in the `ai_reports` table; the privacy policy documents it. The reply is
always included, so the dialog warns against reporting secrets.

## Store listing draft

The Partner Center copy is kept as plain text under `msix/chat/store/`, one file
per field, ready to select and paste without Markdown or rich text:

- `short-description.txt` (228 characters; limit 256)
- `full-description.txt` (9,299 characters; limit 10,000)
- `feature-bullets.txt` (one sentence per line; each under 200 characters)
- `release-notes.txt` (one section per version, newest first; copy only the
  newest — the 0.6.3 section is 1,361 characters, limit 1,500)

These are the 0.6.3 listing and release notes. The package itself is built from
this commit at `0.6.3.0`, and `release.config.json` names it in `store.latest`
now that Microsoft has certified it, so a Store install is told the update
exists. Search terms: AI chat, coding
agent, AI assistant, code assistant, developer tools, cross-device sync,
project sync. ("ChatGPT import" is tempting but it is someone else's trademark
in a keyword field - leave it out unless you want to argue about it.)

---

[Documentation](README.md) · [Hook](../README.md)
