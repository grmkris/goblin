# Purrable implementation handoff

The core is implemented and retained at
[purrable-dev.kristjan-grm11775.workers.dev](https://purrable-dev.kristjan-grm11775.workers.dev).
Implementation commit: `09a6e5639e6ff8c76f50d41de05b5f4f65833c3c`. Work remains on `main`; no push or production
promotion was performed. Start with [AGENTS.md](../AGENTS.md), [architecture](architecture.md), and
[development](development.md). [The implementation record](implementation.md) links the acceptance receipts.

```text
apps/runtime/       native Agent/Pi, Effect metadata, MCP/auth, migrations and tests
apps/web/           TanStack Start, AG-UI, MCP Apps and the Alchemy stack
packages/contracts/ cross-runtime Effect Schema contracts
packages/ui/        editable local shadcn components
tools/              My Apps quality rules, graph, provenance and documentation gates
scripts/            local/dev stage loader and bounded manual smoke
docs/               architecture, development, ADRs, compatibility and evidence
.agents/skills/     canonical skills and source metadata
.claude/skills/     per-skill relative links
.github/workflows/  frozen install plus the canonical gate
```

## Selected composition and ownership

Agents `0.26.0` supplies native `PiHarness`; Pi Durable/Pi AI are pinned at `1.0.1`. Alchemy is `2.0.0-beta.80`,
Effect `4.0.0`, Drizzle `1.0.0-rc.5-ab785fc`, Better Auth/MCP plugin `1.7.6`, MCP client `2.2.0`, AG-UI `1.0.1`,
MCP Apps `2.0.3`, and TanStack Start `1.168.58`. Bun `1.4.2` owns workspaces; Turbo only schedules tasks.
[The stack report](stack-compatibility.md) records API entrypoints, references and evidence boundaries.
[Deployment/source association](evidence/deployment.json) records both the deployed and final verified lock hashes;
the only subsequent lock change declared the smoke helper's existing pinned Effect dependency at the root.
[The verification receipt](evidence/verification.json) records the clean-copy and local acceptance counts.

Pi owns conversation/execution state. The native Agent registers its harness lifecycle; application migrations never
adopt vendor tables. The small `AppMetadata` Effect service uses Drizzle for application DO SQLite only. Better Auth
and capability grants use separate D1 because the pinned Durable SQLite auth adapter fails its async transaction and
affected-row contract. AG-UI projects committed Pi state; MCP Apps uses nested opaque sandbox frames and originating
server grants. Alchemy owns infrastructure; there is no parallel Wrangler deployment configuration.

## Verification and commands

The final source passed the following checks, with all Turbo tasks forced to execute:

| Command / evidence | Result | Boundary |
| --- | --- | --- |
| `heavy bun install --frozen-lockfile` in a clean temporary checkout | Passed | No private env, prior node_modules, Alchemy state or build cache was copied |
| `TURBO_FORCE=true heavy bun run check` in that copy and the main checkout | Passed | Five workspace typechecks; 84 unit tests; two workerd integration tests; production build |
| `lint:gate`, duplication, provenance and documentation checks inside the gate | Passed | Zero lint/Effect/Knip findings or collection failures; zero clones |
| Native write/read integration processes in [the stack report](stack-compatibility.md) | Passed | Different process and Agent instance, identical transcript, receipt deduplication preserved |
| `heavy bun run deploy:dev` | Passed | Retained dev Worker, SQLite DO and isolated D1; production unchanged |
| `bun run smoke:dev` | Passed | Owner boundary, real MyPlan/MyBrowser reads, resident LiteLLM/Pi MyPlan call and committed readback |
| Authenticated Chromium Apps acceptance | Passed | Real MyPlan App render plus permitted `panel_browse`; opaque frames/CSP, fallback and visibility checked |

Use `bun dev`, `bun run build`, `bun run check:fast`, `bun run check:files <paths>`, and the canonical
`bun run check`. Separate root commands exist for formatting, lint/Effect/Knip, duplication, types, unit/integration
tests, graph, provenance and compatibility; [package.json](../package.json) is authoritative.
[The script guide](../scripts/README.md) explains manual dev acceptance.

## Skills and rule provenance

The three generic Cloudflare skills retain their Apache-2.0 licenses and original bytes from
`cloudflare/skills@b052c32bab7dd493513260228a36c88294f343f1`. `effect-4` is explicitly adapted from
`grmkris/myapps@54259fdd5a2560d2595167d7ff0650826a039102`; ten further skills describe Purrable's selected boundaries.
[Skill metadata](../.agents/skills/sources.json) records upstream and local hashes, licenses and adaptations.
[Rule provenance](../tools/quality-provenance.json) and [source inventory](../tools/myapps-source-inventory.json)
pin the My Apps quality families without importing its legacy findings baseline.

Fresh Codex and Claude catalogs expose all 14 skills: [receipt](evidence/skill-discovery.json).
Grok/Cursor/Hermes adapters have structural checks; their fresh-client discovery is unproven. The official Claude
skills page returned HTTP 403; installed catalog discovery and official-page review remain separate evidence.

## Retained dev operation and remaining boundaries

Local coding/testing uses CLIProxy. The deployed Worker uses the authorized public Railway LiteLLM route with a
dedicated Gemini Flash key capped at $10 per 30 days and limited to the selected model. Its master key is never a
Worker binding. Private settings and smoke credentials remain mode 600 under `.local`; they are ignored by Git.

MCP access tokens can expire before their one-hour application grants. Refresh private dev credentials through the
recorded provisioning flow and redeploy bindings before repeating the smoke. No production endpoint, browser session,
provider-spending MCP action, message or purchase is an authorized substitute. Keep the retained dev resources and
private settings for continuation; disposable smoke grants expire naturally. Cleanup of retained infrastructure is
a separate operator action through Alchemy.

Portals, Durable Streams, Tmux, production promotion, standalone inbound OAuth login/consent UI and `/mcp` hosting,
subscriptions, completion, elicitation, Tasks/Skills and draft Events/Triggers remain later work. The implemented
authenticated `/api/mcp/*` host is the accepted first core. See [the MCP matrix](mcp-compatibility.md) for per-feature
implementation and acceptance gaps.

PiHarness and Alchemy are beta, Pi Durable is experimental, and Drizzle is a release candidate. Local reconstruction
does not prove remote eviction or in-flight alarm recovery. Cancellation may wait for an uncooperative tool; alarm and
model-call limits have not been load-tested. Conversation deletion is not implemented. The D1 auth fallback, the
separate owner-only 16 MiB App HTML limit, and future inbound OAuth product work are the main decisions to revisit.
