# 0061: The shelf is data

Accepted 2026-10-14 with the owner. Amends ADR 0052 (the shelf's stage endpoints, its `goblin` group and the rule that
kept off it what Mercator sells). Part of the cleanup that makes goblin MCP-first, with no server-specific code.

## Context

The shelf of suggested servers chose an endpoint per stage in code (mysi's dev endpoint on local and dev, the Goblin
Wallet's dev or prod Worker), grouped goblin's own services first, and left off any server that did what Mercator sold.
A client anyone can deploy cannot switch on goblin's own stage names or favour one vendor.

## Decision

- **One endpoint per entry, the same on every deployment.** mysi is `https://mysi.lol/mcp?codemode=off`; the Goblin
  Wallet leaves the shelf with the wallet (ADR 0056).
- **A deployment may change it with `MCP_SHELF`** (`GOBLIN_MCP_SHELF`): a JSON list of entries (`id`, `title`,
  `description`, `endpoint`, `group`, `signIn`). One with the id of goblin's entry takes its place; the others follow
  goblin's. A list that does not decode stops the agent's start, as a bad `MCP_SERVERS` does.
- **The groups name what servers are for**: the owner's own apps (`yours`), publishing (`publish`, Cloudflare), then
  travel, knowledge, crypto data, views in the chat and code. Nothing is left off the shelf for what another server
  sells.

## Consequences

- A deployment that runs its own mysi (goblin's dev stage runs against mysi's dev) sets `GOBLIN_MCP_SHELF` to point the
  mysi entry there; without it, its shelf suggests mysi's public endpoint.
- The agent's `mcp_suggest` and the Connections picker read the same shelf.
