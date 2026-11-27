# Updates and releasing

How an installed copy learns about a new version, and how an installer is built, published and never taken down.

## Updates

Installed copies check `GET /api/releases` at startup and every four hours. The
response is public and lists the newest version, the oldest supported version
(`minimumVersion` in `release.config.json`, deployed with the website), and the
recent releases with their sizes, checksums and dates. What Hook does with it:

- **Current** — nothing.
- **Behind, above the floor** — a dismissible banner above the chat offers the
  new version. "Later" hides it until the next launch.
- **Below the floor** — a blocking dialog. This is the security lever: raise
  `minimumVersion` and older builds stop working as soon as the website deploys,
  without rebuilding the app. The server clamps a floor above the newest
  published build to that build, so a typo cannot brick everyone.

A packaged Microsoft Store build uses its own pair (`store.latest` /
`store.minimumVersion`) because certification lags behind direct releases; see
[Microsoft Store (MSIX)](microsoft-store.md). The live config is:

```json
{
  "minimumVersion": "0.6.1",
  "store": { "latest": "0.6.2", "minimumVersion": "0.6.1" }
}
```

`store.latest` names the version Microsoft has certified (0.6.2) and moves
again only after the next submission is certified; an empty value means Store
builds are never told an update exists. Its floor is `0.6.1`, so a Store
install on 0.6.1 is offered 0.6.2 as a banner and anything below 0.6.1 is
required to update; the server never forces a version its channel does not
have, so a floor above `store.latest` falls back to it. The direct floor is
`0.6.1` as well, but that channel's newest build is still 0.3.9 while no newer
installer is published, so the server clamps the floor to it: the direct
channel forces anything below 0.3.9 and offers nothing newer. A direct build
reaches 0.6.2 only when a direct installer is published (`pnpm release`). The
Store's own install has a constraint the direct channel does not: see
[Updating a Store install](microsoft-store.md#updating-a-store-install).

"Update now" downloads the installer with the signed-in token, checks it against
the published SHA-256, and hands it to the NSIS installer in passive update mode
(`/P /UPDATE /R`). The installer replaces Hook and starts it again; chats,
projects and the coding engine stay on disk. There is no signing key to manage
and no separate update channel: the same account gate that protects the download
protects the update. The installer lands in `%TEMP%\hook-update\<version>\` and is
replaced by the next update.

A signed-out build still checks for updates (the index is public). Installing
asks for sign-in first, because the installer download requires an approved
account. Builds older than 0.1.1 predate the updater, so the first move to this
release is still a manual download; everything after it is one click. `release.config.json` is the only file to edit to force updates:

```json
{ "minimumVersion": "0.1.0" }
```

`0.0.0` never forces an update. The public history lives at
`https://hookcode.io/api/releases`; the desktop updater uses the same data, and
`/api/download/windows?version=` pins an exact build. The website links the
Microsoft Store listing instead of an installer.

## Releasing

Installers are built and published from the machine that makes the release, not
from CI:

```bash
pnpm version:bump patch                 # patch|minor|major, add --product workspace
pnpm release                            # every product whose source changed
pnpm release -- --dry-run               # build and merge the index, upload nothing
pnpm release -- --store                 # also package the MSIX and print the submit
```

`scripts/release.sh` refuses to run from anything but a clean, already-pushed
`main`, runs the checks (`pnpm typecheck`, `pnpm test:release`,
`cargo test -p hook-core`), and then, per product, builds the installer, writes
`release/latest.json` (version, commit, builtAt, size, SHA-256, source hash,
release notes), merges it into `release/releases.json`, and uploads both to
`/opt/hook-web/data/releases` over the same SSH deploy key as the website. It
prints what it is skipping: a product whose source is identical to the published
build is left alone.

The release gate (`scripts/release-gate.mjs`) is what decides that, and it still
refuses the two cases that used to fail the workflow:

| Repo state | What happens |
|---|---|
| Same application source as the published build | that product is skipped |
| Source changed, version bumped | builds and publishes |
| Source changed, same version | refuses, asks for `pnpm version:bump` |
| Source changed, lower version | refuses (no downgrades) |

Publishing never takes downloads down. The new installer goes up under its
versioned name first; the old index keeps serving the previous version until the
new one is complete, and the swap is a single `mv`. The last five versions stay
downloadable.

`.github/workflows/checks.yml` still runs the typecheck, both window builds, the
server suite and `cargo test -p hook-core` on every push that can change a
product — it is the "is main good" light, not a publisher. Nothing in CI has to
pass for a release to go out, which is why `pnpm release` runs those checks
itself before it uploads anything.

The release profile is tuned for build time — thin LTO, parallel codegen units,
and one `rlib` per product instead of the mobile `staticlib`/`cdylib` too —
because an installer is dominated by the ~200 MB of MinGit, Node and pi it ships,
not by the executable in it.

Bump the version with `pnpm version:bump patch` (or `minor`, `major`, or an
explicit version, add `--product workspace`). It updates that product's
`package.json`, `src-tauri/Cargo.toml`, the workspace `Cargo.lock` and
`src-tauri/tauri.conf.json` together: the app reports
Cargo's version, the installer is named after Tauri's, and the release manifest
refuses to publish if they disagree.

`crates/hook-core` is the one crate with no release version: it is shared by both
products, so a number of its own would be wrong for at least one of them. Each
app passes `env!("CARGO_PKG_VERSION")` to `hook_core::builder`, which records it
in `crates/hook-core/src/version.rs`; the window's version label, the update
check, the sign-in payload, the AI report and the `X-Hook-App-Version` header all
read it from there. Never call `env!("CARGO_PKG_VERSION")` inside `hook-core`
for anything user-facing — that answers with the crate's own number, and a build
that believes it is an old version offers an update forever.

---

[Documentation](README.md) · [Hook](../README.md)
