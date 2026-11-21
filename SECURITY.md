# Security policy

## Reporting a vulnerability

**Please do not open a public issue.**

Email **support@hookcode.io** with:

- What the issue is, and what an attacker could do with it.
- The version or commit you are testing.
- The platform (Windows desktop, Hook Workspace, the phone app, or the
  `hookcode.io` service and its API).
- Steps to reproduce, or a proof of concept. A script is ideal.

You will get an acknowledgement within a few days. If the report is valid, a fix
goes out and you are credited in the release notes unless you would rather not
be.

## Scope

In scope — anything in this repository:

- **`crates/hook-core/`** — the account code, chats and sync, the coding-agent
  supervisor, the preview server, the tools the chat agent can run.
- **`server/`** — the account service, model proxy, git hosting and Workspace
  API behind `hookcode.io`.
- **`apps/` and `packages/`** — the desktop and phone products.
- **The bundled guard** (`crates/hook-core/resources/hook-guard.mjs`) and the
  policy it enforces.
- **The release pipeline** (`scripts/release.sh`, `scripts/build-msix.mjs`, the
  workflows under `.github/workflows/`).

Out of scope:

- Findings that need an already-compromised machine, or physical access.
- The model provider's own behaviour. Report that to the provider.
- Missing hardening headers on the marketing site with no demonstrated impact.
- Automated scanner output with no attack path described.

## Things worth a look

These are the areas where a mistake would matter most. They are documented in
AGENTS.md so that a reviewer can reason about them:

- **Git credentials are scoped.** The desktop mints `scope='git'` tokens; the
  app token (`scope='app'`) is what reads chats and spends model credits. Any
  path that puts an app token into a project, a URL or an agent environment is a
  finding.
- **The direct-agent bridge** (`bridge.rs`) runs an agent as the signed-in user.
  Its token is minted per chat and should grant only the names in that agent's
  `tools.json`, on loopback only. Anything broader is a finding.
- **Workspace permissions are server-side.** Viewer/editor/manager/owner is
  checked on every request; UI gating is cosmetic. A client-side-only check is a
  finding.
- **Preview serving is loopback-only and path-contained** (`preview.rs`). A
  traversal out of the project folder is a finding.
- **Git quotas are server-side**, enforced by a pre-receive hook. A push that
  can bypass it is a finding.
- **Secrets never reach the renderer.** The provider key lives server-side only.
- **Never rewrite the request prefix** is a performance invariant, not a
  security one — but a change there that leaks a message's content into a
  cached prefix would matter.

## Supported versions

The project ships desktop installers and a hosted service. Fixes go into the
latest release; there are no long-term support branches. If you are running an
older build, update.

## Disclosure

We follow coordinated disclosure. Please give us a reasonable window to fix the
issue before publishing. We will agree a date with you and credit you by name
unless you ask us not to.
