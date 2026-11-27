# Hook documentation

Everything about Hook, by task. The repository root keeps the short
[README](../README.md); this folder is the reference behind it.

Working on the code? [AGENTS.md](../AGENTS.md) is the onboarding for coding
agents and the fastest map of the tree — commands, invariants, and why the
obvious fix is sometimes wrong.

## Start here

| Document | What it answers |
| --- | --- |
| [Getting started](getting-started.md) | Prerequisites, `pnpm app`, the mock provider, a build, and the outputs it leaves |
| [Configure](configure.md) | `harness.config.toml`: the provider, the model, `[coding]`, `[memory]`, `[compact]` |
| [Using Hook](hook.md) | The settings sheet, advanced mode (thinking, tool calls, commands, compaction), the keyboard |

## Products

| Document | What it answers |
| --- | --- |
| [Using Hook](hook.md) | The chat window itself |
| [Coding agents](coding-agents.md) | How a run starts, follows a checklist, reports back, shows a preview — and the chat you can have with the engine directly |
| [Your machines](machines.md) | Running work on another computer of the same account |
| [Hook Workspace](workspace.md) | Projects, boards, tasks, documents, roadmaps, roles, and the service behind them |
| [Hook on a phone](mobile.md) | Hook: the same account and the same chat surface, with no folder and no local engine |

## How it works

| Document | What it answers |
| --- | --- |
| [Architecture](architecture.md) | The crate map, the two kinds of conversation, streaming, cancellation, persistence |
| [Where the data lives](data-layout.md) | Every file under `%APPDATA%` (or `~/Library/Application Support`), and what a debug build does differently |
| [Sync between computers](sync.md) | What travels, what merges, what never leaves the machine |
| [Plans, limits and your own model](plans.md) | The free plan, the account-wide sync switch, a personal endpoint, analytics |
| [Memory](memory.md) | What the agent remembers, how frames reach a chat, why the request prefix is append-only |
| [Importing from ChatGPT or Claude](import.md) | Turning a vendor export into ordinary chats |

## The account service

| Document | What it answers |
| --- | --- |
| [One account, several products](account.md) | One sign-in, one device id, one relay; the device flow and the phone's sheet |
| [Web waitlist](waitlist.md) | The landing page: dev loop, copy, Meta Pixel, the Google client |
| [The account service](server.md) | The container on the VPS: deploy, environment, database, admin scripts, approvals |
| [Model proxy and web search](model-proxy.md) | The OpenAI-compatible proxy, what it meters, and the search tool |
| [Reporting AI output](reporting.md) | The Report action, content reports, and the review queue |

## Shipping

| Document | What it answers |
| --- | --- |
| [Updates and releasing](releasing.md) | How a copy learns about a new version; how an installer is built and published |
| [Microsoft Store (MSIX)](microsoft-store.md) | Partner Center, the package, the taskbar icon, Store updates, policy 11.16 |

## Quality and legal

| Document | What it answers |
| --- | --- |
| [Tests](tests.md) | What each suite proves, and the commands that run them |
| [License](license.md) | AGPL-3.0-only, the trademark, bundled third-party programs, the CLA, commercial licensing |

## Reference

| Document | What it covers |
| --- | --- |
| [Document Markdown](document-markdown.md) | The Workspace dialect: rules, scope, what stays literal — the same file the model reads |
| [Relay protocol](relay-protocol.md) | The WebSocket contract between a controller and a host |
| [Remote control status](remote-control-status.md) | What exists today, what is left, and the decisions behind it |
| [Browser architecture](browser-architecture.md) | Hook Browser: designed, not built |
| [Browser POC plan](browser-poc-plan.md) | The build order behind that design |
| [Browser host](browser-host.md) | The browser's own host process: step 1 in, the sidecar still designed |
| [OS decoders](browser-os-decoders.md) | The platform-decoder path for H.264/AAC: decided, not started |
| [The browser's name, and what it carries](browser-branding.md) | Why anything gets removed (lean, not anti-Google), the name and icon, the services, Safe Browsing, Widevine |
| [Browser dev loop](../browser/README.md) | `browser/`: the checkout, the overlay, the patch stack, the tools |

## Repository root

| File | What it is |
| --- | --- |
| [README](../README.md) | The short version |
| [AGENTS.md](../AGENTS.md) | Onboarding for coding agents; commands, repo map, hard constraints |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | How to send a change, and the CLA |
| [SECURITY.md](../SECURITY.md) | Reporting a vulnerability |
| [CLA.md](../CLA.md) · [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) | Legal and community ground rules |
| [TRADEMARK.md](../TRADEMARK.md) | The names and the mark |
| [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) | Every bundled third-party program |
| [infra/README.md](../infra/README.md) | The server config the deploy uploads |

## Keeping this honest

A change that alters a command, a config key, a file layout, a data path or a
user-visible flow updates the matching document here in the same commit, and
[AGENTS.md](../AGENTS.md) points at it. The documents are meant to be read
instead of guessed from the tree — when one drifts, it is a bug.
