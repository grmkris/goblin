# Implementation record

The assignment source is [the finalized workspace prompt](https://myplan.lol/w/ws_ppp0EllAj9g0BRK9Wbt8/n/doc_4gpcexXhfTcT2NPT)
(revision 9), [the architecture](https://myplan.lol/w/ws_ppp0EllAj9g0BRK9Wbt8/n/doc_Mf4XNRvPsP8G8Tob) (revision 4), and
[the overview](https://myplan.lol/w/ws_ppp0EllAj9g0BRK9Wbt8/n/doc_RxNqREPmHiK4y3Um) (revision 3), reread on 2026-10-04.

## Accepted session decisions

- GPT 6.1 Sol workers; coordinator serializes integration, dependencies, commits, gates and deployment.
- Continue until completion; continue independent work around precise external blockers.
- CLIProxy for host coding/local testing; public self-hosted Railway LiteLLM for deployed Cloudflare model calls.
- Dedicated `purrable-dev` model-limited virtual key capped at $10 for 30 days; prefer verified Gemini 3.8 Flash.
- Retain isolated dev infrastructure for the handoff. Disposable dev fixture writes are allowed with receipts/cleanup.
- A dedicated D1 auth store is the supported minimal fallback for Better Auth: its pinned Durable SQLite adapter
  has asynchronous transaction and affected-row incompatibilities. Pi and application metadata remain DO SQLite.
- All applicable My Apps quality rules immediately; no copied legacy baseline or broad suppression.

## Checkpoints

| Checkpoint | Status | Evidence |
| --- | --- | --- |
| C0 Compatibility/source inventory | Complete | Pinned source/API inventory, native spike, provider probes, and skills provenance are recorded in `docs/stack-compatibility.md` and `.agents/skills/sources.json`. |
| C1 Workspace/quality foundation | Complete | Bun/Turbo workspace, My Apps quality rules, agent skills, provenance, CI, and documentation checks are present. |
| C2 Resident Pi runtime | Complete | Native `PersonalAgent`, PiHarness lifecycle, application migration boundary, durable receipts, and live Pi readback are verified; lifecycle evidence remains distinct from remote eviction. |
| C3 MCP/auth/grants/matrix | Complete | Core Streamable HTTP client, negotiated capabilities, exact grants, Better Auth boundary, MyPlan/MyBrowser dev discovery, and the versioned matrix are implemented. |
| C4 AG-UI/MCP Apps | Complete | Browser snapshot/live reconnect passes; MyPlan App renders in nested opaque frames and completes a read-only `panel_browse` interaction. |
| C5 Reproducible gates/build | Complete | The root gate and a temporary clean frozen-lockfile reproduction pass with zero lint/Effect/Knip findings, tests, integration, and build. |
| C6 Isolated dev acceptance | Complete | Alchemy deployed the retained `purrable-dev` stage and real owner/model/MCP/Apps smoke paths passed. |
| C7 Evidence handoff | Complete | This record, the compatibility ledgers, skills provenance, CI workflow, and bounded smoke command provide the continuation handoff. |

## Verified starting evidence

My Apps is read-only source material at commit `54259fdd5a2560d2595167d7ff0650826a039102`; it was clean at inventory.
LiteLLM public health and authenticated model discovery returned HTTP 200 during planning; the catalog exposed
`gemini-3.6-flash`, `gemini-3.8-flash`, and `gemini-3.5-flash-lite`. The pinned `gemini-3.8-flash` route passed host
streaming/tool probes and a retained Cloudflare dev submission. No production or remote eviction evidence is implied.

## Final verification evidence

The canonical `bun run check` passed on the repository and in a temporary clean copy after `bun install --frozen-lockfile`:

- formatting, agent/provenance/documentation checks, graph validation, and TypeScript typecheck passed;
- `lint:gate` reported `0 findings, 0 collection failures`, duplication reported zero clones, and Effect diagnostics/Knip passed;
- 84 unit tests, two local Alchemy/workerd integration tests, and the production web build passed;
- the separate two-process native reconstruction proof passed (two tests in the write process, three in the read process).

The retained Alchemy stage was deployed through `bun run deploy:dev` at 2026-10-04 00:51:50 UTC, then its disposable
read-only MCP secret bindings refreshed at 01:09:03 UTC:
`https://purrable-dev.kristjan-grm11775.workers.dev`. The retained D1 auth database is the existing isolated dev
resource; no production resource was changed. Owner sign-in, snapshot, MCP registry, model submission, durable wait,
and snapshot readback passed. The resident model used the authorized Railway LiteLLM route and called the exact,
read-only MyPlan `myplan_open` tool through Pi; the committed `pi.tool-result` was successful and the readback marker
was `PURRABLE_MCP_OK`.

The retained `bun run smoke:dev` passed at 01:10:45 UTC, including harmless MyPlan/MyBrowser reads and a fresh
resident Pi MyPlan call with correlated committed tool-result readback. Its
[sanitized receipt](evidence/smoke-dev.json) contains no credentials or remote content. Outbound access-token expiry
and application-grant expiry are separate; refresh the dev credentials and redeploy bindings before later manual runs.

At 2026-10-04 00:52:22 UTC, the authenticated Chromium Apps smoke connected MyPlan, called `myplan_open`, read its
`ui://myplan/panel.html` resource, rendered nested opaque `allow-scripts` frames with inner origin `null` and CSP, and
forwarded a `panel_browse` search through the originating connection. The app-only tool stayed hidden from the ordinary
picker, the interaction returned `isError: false`, no `panel_session` request was made, and the browser reported no
errors. Grants were exact and read-only for this disposable dev run.

The MyPlan panel HTML is 13,925,182 bytes (about 13.3 MiB). Ordinary MCP/model results remain capped at 1 MiB; the Apps host has a separate
owner-only 16 MiB `ui://` HTML bound with exact resource grants and MIME/URI validation. This preserves a hard limit
without rejecting the first real App resource.

Retained evidence includes [runtime acceptance](evidence/runtime-dev.json), [resident Pi/MCP acceptance](evidence/pi-mcp-dev.json),
[browser projection](evidence/browser-dev.json), [sandboxed Apps acceptance](evidence/apps-dev.json),
[local reconstruction](evidence/native-reconstruction.json), and [fresh skill discovery](evidence/skill-discovery.json).
All 14 skills were discovered by fresh Codex and Claude clients. Grok/Cursor/Hermes discovery and the HTTP-403-blocked
official Claude skill-page review remain explicit setup evidence gaps.

All evidence is dev-only. Production promotion, external messaging, MCP provider-spending actions, Portals, Durable Streams, draft
events/triggers, standalone inbound OAuth UI, and a standalone `/mcp` server remain separate work.
