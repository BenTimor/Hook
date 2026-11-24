# Contributing to Hook

Thanks for taking the time. This is a small project with a lot of surface area,
so the notes below are the shortest path to a change that can be merged.

**Read [AGENTS.md](AGENTS.md) first.** It is the real map: what lives where, the
invariants that are not obvious from the tree, and the traps that cost an hour
each. This file covers how to *contribute*; that file covers how Hook *works*.

## Before you start

**Open an issue before writing a large patch.** Hook is opinionated about its
architecture — one account across several products, an append-only model
request, sync that merges server-side. A change that looks local often isn't.
A short issue first saves you a rejected pull request.

Small fixes — a typo, an obvious bug, a missing null check — need no issue.

## Requirements

| | |
|---|---|
| Node | 22.13 or newer |
| pnpm | 10.28.1 (pinned via `packageManager`; Corepack handles it) |
| Rust | 1.77 or newer, plus the platform toolchain Tauri needs for a build |
| OS | Windows 10/11 for a full desktop build; Linux and macOS work for UI and tests |

## Setup

```bash
pnpm install

# Required before ANY cargo build. harness.config.toml is gitignored and is
# include_str!d into hook-core, so without it the crate does not compile.
cp harness.config.ci.toml harness.config.toml
```

That second line is the one that trips up every first-time contributor: a fresh
clone fails to build with a `could not find harness.config.toml` error, and it
is not a problem with your toolchain.

The CI config has no secrets in it. The provider key lives on the server, and
the desktop app authenticates with the signed-in user's token. Never put a real
provider key in any config file you commit.

## What to run

```bash
pnpm typecheck    # every package + the landing page. The only static gate.
cargo test        # the whole Rust workspace, at the repo root. No engine or network.

pnpm dev          # chat UI in a plain browser, mock backend
pnpm app          # the real Tauri window, hot reload
```

Both must be green before you open a pull request. If your change touches the
server or the landing page, add `pnpm waitlist:test`.

Tests that need the network or a live model are `#[ignore]`d:

```bash
pnpm mock                                  # fake OpenAI-compatible endpoint on :8787
cargo test -p hook-core -- --ignored       # the live tests
```

## Style

There is no ESLint, no Prettier and no rustfmt config. **Match the file you are
editing** — its comment density, its naming, its spacing. This repo has a
consistent voice and a reformatting pass in a pull request will be asked to go
away.

Two habits worth copying:

- Comments explain *why*, not *what*. The code says what. A comment that
  restates it is noise; a comment that records the reason for a non-obvious
  choice is the most valuable line in the file.
- Prefer a pointer to the code over a copy of it, in docs and in comments.

## Commit messages

Short imperative subject line, then a blank line, then *why* the change was
made — not a restatement of the diff. Look at `git log` for the house style.

```
Raise the per-push Git cap to 100 MB

The 50 MB cap rejected legitimate assets ...
```

## Cross-layer changes

Hook is a workspace of products sharing one backend. Most bugs come from
changing one side of a boundary and forgetting the other. AGENTS.md has a
**Touch every layer** section with the checklist for each kind of change — a
new IPC command, a new chat-agent tool, a sync change, a Workspace entity. Read
the matching entry before you start, not after.

## Contribution licensing — please read

Hook is licensed under the **AGPL-3.0-only** and is dual-licensed commercially:
organisations that cannot accept the AGPL's network-copyleft can buy a
commercial license instead. That is how the project funds itself.

For that to remain possible, the project must hold sufficient rights over every
contribution. **So every non-trivial pull request needs a signed CLA**, in
[CLA.md](CLA.md).

**Signing takes one comment.** A bot ([`.github/workflows/cla.yml`](.github/workflows/cla.yml))
posts a reminder on your first pull request. Reply on the pull request with
exactly:

> I have read the CLA Document and I hereby sign the CLA

That comment is your signature. It is recorded once, it covers your future
contributions too, and the "CLA" status check turns green. If it stays red
after you comment, reply `recheck` or push again to re-run it.

If you are contributing on behalf of an employer, or your contract gives your
employer rights to your work, a **corporate CLA** is required instead. Email
**support@hookcode.io** for the form; once it is on file you are added to
`.github/cla-allowlist.json` and the gate stops asking.

You keep the copyright to your contribution. The CLA is a broad license to the
project, not an assignment — you may use your own work however you like
afterwards.

Trivial changes (a typo, a one-line docs fix) are merged without a CLA.

If you are not willing to sign a CLA, that is a legitimate position. The
alternative is to file an issue describing the fix and let a maintainer write
it. Please do not send a substantial patch and then decline the CLA — it cannot
be merged, and it wastes your work.

## Pull requests

- One logical change per pull request.
- Include a test when you touch `crates/hook-core`. The crate has a real test
  suite and it is expected to grow.
- Update the docs in the same commit. If your change alters a command, a config
  key, a file path, a data path, a user-visible flow or the architecture, update
  the matching file under `docs/` (its index is `docs/README.md`), plus
  `AGENTS.md` when it is about working on the code. A change that makes a
  sentence in AGENTS.md wrong should fix that sentence.
- Say what you tested and on which platform.

## Things that will get a pull request closed

- A formatter running over the whole tree.
- A new dependency that is copyleft or unlicensed. Check it against
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- A generated or vendored tree edited by hand: `target/`,
  `apps/*/src-tauri/gen/`, `apps/*/src-tauri/resources/pi-runtime/`,
  `apps/*/src-tauri/resources/git/`, `dist/`, `release/`.
- A version number edited by hand. Use `pnpm version:bump`, and only when asked.
- Removing an attribution, a copyright header or a license notice — from this
  code or from anything bundled.
- Using the Hook name or mark for a fork. See [TRADEMARK.md](TRADEMARK.md).

## Windows notes

Commands in this repo are written for **bash**, not `cmd.exe`. Redirect to
`/dev/null`, never `>nul` — from bash, `nul` creates a file named `nul` in the
working directory, and that name is reserved on Windows.

Never kill processes by image name. `taskkill /F /IM node.exe` matches every
Node process on the machine, including your own dev server and the agent tooling
you are running inside. Kill the port you started instead:

```bash
netstat -ano | grep :1420
taskkill //F //PID <pid>
```

## Security

Please do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
