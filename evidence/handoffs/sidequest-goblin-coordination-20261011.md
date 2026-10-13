# Sidequest × goblin: validating the MCP server and client together

Written 2026-10-11 by the goblin lane (`sidequest-event-connections-plan`). The Sidequest server lane is
`fix-agent-onboarding-flow` (the Sidequest repository, branch `dev`). Kris drives browsers, approvals and every testnet
write.

## Where each side is

**Sidequest dev (server).**
- Speaks MCP protocol 2026-07-28 (`apps/api/src/mcp-metadata.ts`).
- Shipped today (de46e687..e1a91faf): a setup connection becomes the agent its operator approves; the operator picks
  roles at approval; setup chats list their agent's tools up front.
- Declares the Skills extension and top-level `capabilities.events`, with `tools.listChanged: false` and `ttlMs: 0`.
- Event payloads carry `summary` and `url`.
- Still being planned (its grilling, Q5–Q12): exact tool lists with `subscriptions/listen` and
  `tools/list_changed` pushed from a Durable Object; roles on the agent with `request_role`; the standard 403
  `insufficient_scope`; and "input required: open this URL" (multi round-trip requests) for every approval, only on
  the 2026 lane and only for clients that declare support (others keep today's link).

**goblin `main` 145f6445 (client), deployed to dev but not yet released (accounts not yet re-bootstrapped).**
- Negotiates the protocol era automatically (`versionNegotiation: auto`), so it talks 2026-07-28 to Sidequest.
- ADR 0041: several connections per server (DCR `client_name` "goblin · <label>", a webhook per connection), Events
  as notices (Tell me) and hand-overs to Goblin or a pinned Persona (Hand to), Skills, owner ask-first approvals also
  inside Persona turns.
- Its SDK (`@modelcontextprotocol/client` 2.2.0) implements `subscriptions/listen`, `input_required` and the 403
  step-up, but goblin uses none of them yet. It declares no elicitation support, so Sidequest's 2026 approvals fall
  back to today's link for goblin until it does.

## The matrix

| # | Feature | Sidequest (server) | goblin (client) | Joint test |
| --- | --- | --- | --- | --- |
| 1 | 2026-07-28 negotiation | ready | ready | goblin's connection reports the modern era |
| 2 | DCR name at consent, agent picked per consent | name shown; agent pre-selected when only one | sends "goblin · <label>" | two goblin connections end on two agents (Hirer, Worker) |
| 3 | Skills extension | ready (`ttlMs: 0`; S3: honest TTL) | ready | skills on for both; activate one; digest and frontmatter verify |
| 4 | Events (SEP-3415) | top-level capability; S1 `cursor: null` = now, S2 extension spelling, S11 subscription per principal and URL | ready (ADR 0041) | each connection subscribes with its own URL; an event becomes a notice; no backlog |
| 5 | Event text | `summary`, `url` (S13: add `title`) | uses `title`, else `summary`, plus `url` | the notice reads the producer's line and links |
| 6 | Tool list changes after approval | ready on dev (exact list while a listen stream is held) | ready on main (0aedcb46, e63dc1d9): re-list in place; listen while in use, closed 60 s after the last use; re-list on a missed tool and after a URL request completes | setup → approve → the same goblin chat can call role tools |
| 7 | Approvals as "input required: open this URL" | ready on dev (2026 lane) | ready on main (c76b9d26, 6929d711, ad211653, b20908e3, 03d52045): the model's calls declare URL elicitation per request; owner card with the link and host; Done retries with the request state; chat, Persona and routine turns | `create_agent` / `request_role` pop the link in goblin and continue |
| 8 | Missing scope: 403 `insufficient_scope` | ready on dev (cfd71f59, b3eb624e) | ready on main (d72674f6, 2d4145da, 50f8c2c3): `ScopeRequired`, connection kept; step-up card opens a fresh consent for offered ∪ held ∪ asked, tokens kept until new ones arrive | a call beyond the granted scope asks the owner to re-consent; needs a narrow sign-in (goblin asks for every offered scope; Kris to choose) |
| 9 | Missing role: tool error → `request_role` | planned | works (plain tool error) | the model calls `request_role`, which leads to #7 |
| 10 | Owner approval before a write in goblin | n/a | ready (ask-first, also in Persona turns) | @Worker quotes through an approval |

## How we coordinate

1. **Phase 0, today's features (no new code on either side).** After goblin's dev bootstrap: Kris connects
   Sidequest twice (Hirer, Worker), skills on; routines worker requests → Hand to @Worker, worker inbox → Tell me +
   @Worker, hirer inbox → Tell me + @Hirer; one zero-bond request; @Worker quotes through a goblin approval;
   "You got picked" arrives as a notice. This is ADR 0041's done gate (rows 1–5, 10).
2. **Phase 1, the 2026 lane, one row at a time (6, 7, 8, 9).** For each row: Sidequest lands it on dev → tells the
   goblin lane (SendMessage) → goblin lands the client half → a joint run with Kris → both sides record receipts.
   goblin declares elicitation/input-required support only once row 7 is built, so nothing breaks in between.
3. **Messages** between `fix-agent-onboarding-flow` and `sidequest-event-connections-plan` at each milestone: plan,
   commit on dev with sha, ready for the joint run, findings.
4. **Receipts.** Sidequest: `docs/reality-check.md` and `docs/evidence/`. goblin: `evidence/handoffs/`. Testnet only;
   no mainnet; Kris's go before every write.

The full Sidequest prompt (S1–S13, the live acceptance) is `evidence/handoffs/sidequest-skills-events-prompt-20261010.md`.

## The 2026 lane, as built (ADR 0042)

Sidequest's contract for row 7: `requestState` is the agent operation id and never expires; a retry is idempotent;
pending answers `input_required` again; a decline completes as an error (`closed:…`) and leaves the approval pending
on Sidequest; a mismatched state is -32602; the one input key is `approval`. For row 6, the exact list is per OAuth
token family while it holds at least one listen stream; a deploy drops streams, and the next list is the stable one
(stable ⊇ exact) until goblin listens again. For row 8, goblin's connect asks for every scope the server offers, so a
403 appears only when an agent gains a role beyond an older sign-in; the joint run needs a narrow sign-in, either an
untick on Sidequest's consent (reverses Kris's Q7) or a scope picker in goblin. Kris decides.

The joint chain: connect narrow (read + hire) → `request_role {role: 'work'}` meets a URL request (7) → Kris allows it
on Sidequest → `list_changed` (6) → the re-list includes `apply` → `apply` answers 403 (8) → step-up → `apply` runs.
Testnet only; Kris's go before every write.
