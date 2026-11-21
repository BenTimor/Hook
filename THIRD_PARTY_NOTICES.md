# Third-party notices

Hook itself is licensed under the **GNU Affero General Public License v3.0**
(see [LICENSE](LICENSE)).

This file covers the third-party software that ships **inside** a Hook build, or
is linked into one. Their licenses are their own, and they take precedence over
Hook's for that software.

Every component listed here is compatible with the AGPL-3.0. Nothing bundled is
under a license that would conflict with it.

## Bundled executables

These are fetched at build time and are **not** committed to this repository.
They are redistributed inside the installer as separate programs, invoked as
child processes.

### MinGit 2.56.1 (Git for Windows)

- **License:** GPL-2.0-only
- **Source:** https://github.com/git-for-windows/git/releases/tag/v2.56.1.windows.1
- **Fetched by:** `scripts/fetch-git.mjs` (run `pnpm git`)
- **Installed at:** `apps/<product>/src-tauri/resources/git/`
- **License text:** shipped alongside the binary at
  `resources/git/LICENSE.txt`, plus per-component text under
  `resources/git/usr/share/licenses/`

Git's own `LICENSE.txt` states that the only valid version of the GPL for that
project is **v2** exactly — not v2.1 and not v3. Hook bundles MinGit unmodified
as an aggregate alongside its own code; it does not link against it, and the GPL
does not extend to Hook's own source. If you redistribute a Hook build, you must
keep `LICENSE.txt` and the `share/licenses` tree intact, and you must be able to
supply MinGit's corresponding source, which is the upstream release above.

### Node.js v22.21.1 (`node.exe`)

- **License:** MIT, plus the third-party components listed in Node's own
  `LICENSE` file
- **Source:** https://nodejs.org/ (the build matching the developer's local
  `node --version`)
- **Fetched by:** `scripts/fetch-pi-runtime.mjs` (run `pnpm engine`)
- **Installed at:** `apps/<product>/src-tauri/resources/pi-runtime/node.exe`

The runtime is the developer's own Node binary copied into the bundle, used only
to execute the coding engine below. It runs as a child process and is not linked
into Hook.

### @earendil-works/pi-coding-agent 1.5.2

- **License:** MIT
- **Source:** https://www.npmjs.com/package/@earendil-works/pi-coding-agent
- **Fetched by:** `scripts/fetch-pi-runtime.mjs` (run `pnpm engine`)
- **Installed at:** `apps/<product>/src-tauri/resources/pi-runtime/pi/`

This is the coding engine Hook drives over RPC. It is unmodified upstream code.

> **The npm package ships no `LICENSE` file.** It declares `"license": "MIT"`
> and `"author"` in its `package.json` and nothing else, so its notice is
> reconstructed from that metadata at build time and written into
> `pi-runtime/THIRD-PARTY-LICENSES.txt`. If a future version adds a real
> `LICENSE`, copy that instead: a reconstructed notice is the weakest form of
> the attribution MIT asks for. Node's `LICENSE` (copied from beside the
> executable) and jiti's are written into the same bundle, and
> `fetch-pi-runtime.mjs` refuses to finish without them — `installed()` requires
> all three, so a bundle built before this existed is rebuilt rather than
> silently shipped without its notices.

## Linked libraries

### Rust crates

The full dependency tree is pinned in `Cargo.lock` (501 crates). All of it is
permissively licensed: predominantly `MIT OR Apache-2.0`, plus BSD-3-Clause,
ISC, Unicode-3.0, Zlib, Unlicense and a handful of `MPL-2.0` crates. There are
**no** GPL or AGPL crates in the tree. `MPL-2.0` permits relicensing under the
AGPL, so it imposes nothing on Hook's own source beyond keeping those files'
notices.

To reproduce the survey:

```bash
cargo install cargo-license
cargo license --avoid-build-deps --avoid-dev-deps
```

### npm packages

The full tree is pinned in `pnpm-lock.yaml` (421 packages). All of it is
permissively licensed: MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense,
BlueOak-1.0.0, OFL-1.1 (two bundled fonts, `@fontsource-variable/inter` and
`@fontsource-variable/jetbrains-mono`, which are distributed under the SIL Open
Font License) and two `MPL-2.0` packages. There are **no** GPL or AGPL packages.

`OFL-1.1` has one obligation worth knowing: the fonts may not be sold on their
own, and any modified version must not use the reserved font name.

To reproduce the survey:

```bash
npx license-checker --summary
```

## Attribution in the product

Bundled fonts and the components above must remain attributed in any
redistributed build. The AGPL additionally requires that users interacting with
a modified version over a network be offered its source; see [LICENSE](LICENSE)
section 13.

If you add a dependency that is **not** permissively licensed, add it here, and
check it against the AGPL before merging. `MPL-2.0`, `LGPL` and `GPL-3.0` are
broadly compatible with the AGPL for separate programs; `GPL-2.0-only` (as with
MinGit) is only safe where it stays a separate, unlinked executable.
