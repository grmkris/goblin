# Prompt for the Sidequest session: skills and platform Events into goblin

Written 2026-10-10 by the goblin session after reading both codebases (goblin `main` 4faef240, agent-jobs `dev`
eac22c8b) and the current MCP specs. Paste everything below the line into a Claude session in `~/code/agent-jobs`.

---

You are working in `~/code/agent-jobs` (Sidequest). goblin (`~/code/goblin`, earlier named purrable) is the owner's
resident personal agent on Cloudflare and an MCP client of Sidequest's `/mcp`. The goal is two things, proven live on
dev:

1. **Skills.** goblin's owner switches on Sidequest's skills, and they verify and load. The switch currently reverts
   to off; goblin fixes that on its side.
2. **Platform Events.** Sidequest happenings (inbox, jobs, approvals, requests) reach goblin as MCP Events. There an
   owner-confirmed routine wakes and tells the owner. These are the platform's notifications, delivered to the owner's
   agent.

Most of this already exists on both sides. This run closes the gaps below and proves them end to end. Coordinate with
the goblin session that sent this prompt; the protocol is at the end.

## Rules for this run

- Work on `dev` only. Never push prod or run `deploy:prod` without Kris. No mainnet transaction. **Any testnet write
  needs Kris's explicit go first.**
- Run expensive checks through `heavy`, and never pipe it. Stage exact paths only; other agents share the checkout.
- After editing `skill/*/SKILL.md`, run `node scripts/gen-skills.mjs`.
- Record outcomes in `docs/reality-check.md` and `docs/integrations/goblin.md`, with sanitized receipts under
  `docs/evidence/`. Keep testnet and mainnet evidence separate.
- Never edit `~/code/goblin`. Report goblin-side needs to the goblin session.

## Sources

Specs:

- **Skills extension (Final).** The stable spec
  https://github.com/modelcontextprotocol/ext-skills/blob/main/specification/stable/skills.mdx is the source of truth.
  SEP-2640 (https://modelcontextprotocol.io/seps/2640-skills-extension) is the historical record. Decision log:
  https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/decisions.md (2026-09-10, `ttlMs`/`cacheScope`).
  Implementations: https://github.com/modelcontextprotocol/ext-skills/blob/main/docs/implementations.md.
- **Skill format.** https://agentskills.io/specification. `name` is `[a-z0-9-]`, 1–64 characters, and must equal the
  directory. `description` is 1–1024 characters.
- **List caching.** SEP-2549 (https://modelcontextprotocol.io/seps/2549-TTL-for-list-results) defines `ttlMs >= 0`
  and `cacheScope`.
- **Events extension.** SEP-3415 is a **Draft, unmerged**
  (https://github.com/modelcontextprotocol/modelcontextprotocol/pull/3415, latest commit c47fd245 on 2026-10-08).
  Its numbers are provisional.
- **Events working group.** https://github.com/modelcontextprotocol/experimental-ext-triggers-events. Its
  `docs/design-sketch-proposal.md` is the older sketch.
- **ChatGPT's Events.** https://developers.openai.com/plugins/build/mcp-events (live since 2026-09-29) follows the
  older sketch: top-level `capabilities.events`, webhook only, codes `-32015`/`-32012`. On its revocation behaviour:
  https://workos.com/blog/mcp-events-chatgpt-subscription-revocation.

goblin, the client side. Read these; don't guess:

- ADR 0008 (skills), ADR 0011 (Events), ADR 0040 (Topic setup) under `docs/adr/`; `docs/architecture.md` §Skills
  and §MCP Events and Telegram.
- Skills: `apps/runtime/src/mcp/remote.ts:58-62`, `src/mcp/manager.ts:146-204`, `src/skills/{protocol,verify,library,events}.ts`.
- Events: `src/mcp/events/{client,webhook,ingress,consumers,store}.ts`, `src/mcp/events.ts`, `src/routines/events.ts`.

Sidequest today: `apps/api/src/mcp.ts:243-249` (capabilities) and `:337-400` (resources, skills, events),
`packages/indexer/src/{mcp-events,webhooks,feed}.ts`, `scripts/gen-skills.mjs`, `docs/integrations/goblin.md`.

## What already matches (no change needed)

**Skills**

- Capabilities declare `resources: {}` and `extensions['io.modelcontextprotocol/skills']: {}`, and `resources/list`
  answers. goblin needs all three.
- Each skill is served at `skill://sidequest/<name>/SKILL.md`, and the last path segment equals `frontmatter.name`.
- The digest and byte size are recomputed after the origin substitution (`renderedSkillManifests`). goblin checks size,
  sha256 and the parsed-YAML frontmatter against the entry.
- `skills/list` pages two at a time with `nextCursor`; goblin follows up to 64 pages. goblin never calls `skills/get`.

**Events**

- The top-level `capabilities.events: {}` arrives in an `application/json` discovery response, which is how goblin
  detects Events.
- All four descriptors offer `delivery: ['poll','webhook']`; goblin refuses any event without both.
- Signing follows Standard Webhooks: second-precision `webhook-timestamp`, padded base64 `v1,` signature over
  `id.ts.body`, keyed by the decoded `whsec_` bytes, plus `x-mcp-subscription-id`. Occurrence `webhook-id` equals
  `eventId`; controls use `msg_<type>_…`; there is no top-level `type` on occurrences.
- The verification challenge is echoed as `{"challenge": …}` with 200. goblin pre-persists the intent, so an early
  challenge is fine.
- Unsubscribe by selector `{name, arguments, delivery:{mode,url}}` with no id works, and an unknown subscription
  returns `{}`.
- Leases are capped at 6 h; goblin asks for 1 h and renews before `refreshBefore`.
- `410` and `413` stop delivery. goblin answers `410` when the owner revoked authority and `503` for anything it
  wants retried, including an unknown subscription id.

## Gaps to close

**S1 (must): `cursor: null` must mean "from now".**
- **Problem.** `parseCursor(null)` returns `undefined`, and `readInbox` without a cursor starts seven days back. So
  `eventStart` puts a fresh subscription before the oldest row of the last week, and the worker delivers that whole
  backlog. goblin's first subscribe sends `cursor: null` (`goblin/apps/runtime/src/mcp/events/client.ts:116`) and its
  polls send `maxAgeMs: 604800000`. goblin runs a routine for every occurrence under 24 h old
  (`src/routines/events.ts:198`), so a newly confirmed monitoring routine fires on yesterday's news.
- **Spec.** SEP-3415 says a `null` cursor means "start from now".
- **Fix.** For `events/subscribe` and `events/poll`, an explicit `null` starts at the current head (`max(seq)` for the
  selector's scope). `events/poll` with `null` returns no events and the head cursor.
- **Unchanged.** The `inbox` tool keeps its seven-day default. Whether an omitted cursor should keep the old behaviour
  is your call: check what the Purrable-era client and ChatGPT (webhook only) send, and write the answer down.
- **Tests.** Subscribe with `null` delivers nothing older than the subscribe. A resubscribe with the saved cursor
  still delivers from that cursor. A refresh of an active row never rewinds.

**S2 (should): declare the SEP-3415 capability form as well.**
- Keep `capabilities.events: {}`, which goblin and ChatGPT read.
- Add `capabilities.extensions['io.modelcontextprotocol/events']: {}`, which SEP-3415 specifies.
- goblin will accept either form (G2), so neither side breaks while the SEP is a draft.

**S3 (should): skills caching fields.**
- The stable spec requires `ttlMs` and `cacheScope` on `skills/get` as well as on `skills/list`. `skills/get`
  currently returns neither.
- Every `/list` currently gets `ttlMs: 0`. Skills only change on deploy, so give `skills/list` and `skills/get` an
  honest TTL; one hour is suggested. goblin clamps listing TTLs to 30 s–1 h and defaults to 5 min.

**S4 (decide, recommended no): skill change Events.**
- No spec defines `skills.updated` or `skills.list_changed`. They are a MySkills convention that goblin binds when a
  server offers them.
- goblin no longer fails when a server lacks them (G1). Sidequest's skills are static per deploy, so the TTL from S3
  covers changes.
- If you add them anyway: `inputSchema` must accept `{}`, delivery must be poll and webhook, and goblin ignores the
  payload and only refreshes its listing.

**S5 (measure): subscribe latency.**
- Sidequest's `events/subscribe` POSTs the verification challenge synchronously, with its own 5 s deadline.
- goblin caps every Events request at 5 s, so a slow challenge round trip fails the subscribe on goblin's side first.
- Measure subscribe duration on dev from your logs (p50 and max) and send the numbers. goblin will raise its subscribe
  timeout if needed (G3).

**S6 (confirm): stable subscription id across token refresh.**
- `subscriptionId` includes `grantId`, and goblin requires a renewal to return the same `id`.
- Confirm with a test that an OAuth refresh-token rotation keeps the same `grantId`. A brand-new consent is a new
  connection on goblin's side as well, so a new id there is fine.

**S7 (record, don't churn): error codes.**
- Sidequest uses `-32015` for a failed callback and `-32003` for revoked or forbidden.
- The SEP-3415 draft uses `-32027`, `-32024` and `-32023` NotFound. ChatGPT uses `-32015` and `-32012`. goblin treats
  `-32011` on unsubscribe as already gone.
- Leave the codes as they are; note them in `docs/reality-check.md` and revisit when the SEP merges.

**S8 (docs): refresh `docs/integrations/goblin.md`.**
- It cites purrable paths and predates goblin's ADR 0040, under which each Topic's setup chooses MCP servers and
  skills (default: everything).
- State that the monitoring routine must live in a Topic whose setup holds Sidequest; Personal holds everything by
  default.
- Keep the read-only allowlist and the zero-allowance rule.

**S9 (Kris decides; do not change):** Sidequest also sends its own Telegram notifications
(`packages/indexer/src/telegram-notifications.ts`). Once goblin watches `sidequest.inbox`, the owner may be pinged
twice. Note the overlap and leave both on.

**S10 (could): say `terminated` when access stops.**
- `terminateSubscriptions` and `terminateGrantSubscriptions` only mark rows terminated; no `terminated` control is sent.
- goblin therefore learns at its next poll or lease renewal (`-32003`), which comes within 5 minutes.
- A final signed `{type:'terminated', error}` to the callback would stop the client at once. goblin pauses a routine on
  `terminated`.

## goblin side (the goblin session does these)

- **G1.** Release 4faef240 to goblin dev. Switching skills on keeps working when a server offers Events but not the
  skills ones; the grant is withdrawn and the listing refreshes on its `ttlMs`.
- **G2.** Detect Events from `capabilities.extensions['io.modelcontextprotocol/events']` as well as from top-level
  `capabilities.events`.
- **G3.** Raise the subscribe request timeout above 5 s if S5's numbers call for it.

## Live acceptance on dev (testnet only, no funds moved)

Sidequest dev must carry S1–S3 and goblin dev must carry G1. Kris drives the owner steps in goblin; you read your logs
and tables.

1. **Skills.**
   - In goblin Connections, Sidequest (`https://dev.sidequest.exchange/mcp`) is connected. Switching **Use skills
     from this server** on stays on.
   - Three skills appear in the composer's `/` menu.
   - Activating `sidequest-publisher` verifies: size, digest and frontmatter all pass. Your logs show `skills/list` and
     `resources/read`, and goblin's `mcp.request` telemetry shows them `ok`.
2. **Subscribe.**
   - Kris confirms the monitoring routine from `docs/integrations/goblin.md`: trigger `sidequest.inbox`, arguments
     `{}`, read-only allowlist.
   - Your side shows the challenge answered with 200, an `active` row, and `refreshBefore` within 6 h.
   - Because of S1, no backlog arrives and the routine does not run.
3. **Deliver.**
   - Ask Kris for the cheapest testnet event that moves no funds, and wait for his go.
   - Within the next cron minute, goblin answers the signed delivery with 204. The routine runs **once** and reports in
     its Topic.
   - goblin's 5-minute safety poll sees the same `eventId` and starts no second run.
4. **Stop.**
   - Pausing or archiving the routine should unsubscribe by selector, leaving the row `terminated`. Report what
     actually happens.
   - Revoking the OAuth connection on Sidequest terminates the rows. Report how and when goblin notices (see S10).
5. **Record.** Write a sanitized receipt and a reality-check entry: shas, times, the subscription id hash, and status
   codes, with no secrets or tokens. The goblin session records its half in goblin's handoff.

## Coordination protocol

- Reply to the goblin session with SendMessage; use this message's `from` as `to`. Message at each milestone:
  - your plan, including the S1 omitted-cursor answer and the S4 decision;
  - S1–S3 committed and on Sidequest dev, with sha and receipt;
  - S5's numbers;
  - ready for live acceptance;
  - every finding during acceptance.
- Ask whenever goblin's contract is unclear, and cite goblin `file:line` when you claim something about it.
- Out of scope: mainnet, prod, a nonzero allowance, economic writes, OAuth scope changes, and any edit to goblin.
