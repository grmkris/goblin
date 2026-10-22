# ADR 0106: The deploy smoke makes no model call

Status: Accepted 2026-10-22 with the owner. Amends ADR 0046, whose consequences say each dev deploy's authenticated
smoke spends a few model calls.

## Context

Every push to `dev` that passes Check deploys and runs the authenticated smoke (`scripts/smoke-dev.ts`), and
promotion needs that smoke's receipt for the exact sha. The smoke asked the agent several things: an inbound
`ask_agent` turn, a tool call through resident authority, a side thread, a subagent, memory and an agent app. On
2026-10-22 a night of many deploys spent the dev account's whole daily token cap on these turns alone, the next smoke
failed on `BudgetExhausted`, and no release could be promoted until the owner raised the cap. What the turns check, the
model's own behaviour, the workerd integration tests already cover with a scripted model, and real providers are
accepted by hand.

## Decision

**The smoke makes no model call by default.** It still checks health and the client build, refused sign-up, sign-in
and resident authority, the owner's file round trip, the typed API's edge, each MCP server with a direct probe, and an
inbound OAuth client: consent, token, `initialize`, its tool list and an inspection read, a read of main's recent
messages, revocation and a 401. The agent turns run only with `GOBLIN_SMOKE_TURNS=1`, by hand; then
`GOBLIN_SMOKE_MODEL` still picks their model.

## Consequences

- A dev deploy spends no model tokens, so the daily cap no longer decides whether a release can be promoted.
- The receipt's `model` is `none`, its inbound `modelTurn` and `residentTool` are `skipped`, and its `flows` check is
  skipped: the only `send` point it looked for came from a turn.
- Whether a deployed agent still answers is no longer part of dev acceptance. Run `GOBLIN_SMOKE_TURNS=1 bun run
  smoke:dev` before a release that changes how the agent calls its model.

## Rejected

- **Raising the cap alone**: it moves the limit; a busy night still blocks the release.
- **A cheaper smoke model**: still spends tokens on every push and still fails on an empty budget.
