# 0060: Suggested access from tool annotations

Accepted 2026-10-14 with the owner. Part of the cleanup that makes goblin MCP-first, with no server-specific code: the
first-class profiles' recommended grants (ADR 0043) give way to this one rule for every server, and go when the
profiles do.

## Context

Granting a new server's tools was either one switch at a time or Allow all, which lets every tool run without asking.
For three servers goblin knew (Mercator, Cloudflare, the Goblin Wallet), a hand-written profile listed which tools
should run and which should ask first. A client that treats every MCP server alike needs one rule that works for any of
them. MCP tools carry annotations for this: `readOnlyHint` says a tool only reads, `destructiveHint` that it may destroy.
They are the server's claims, and the root rules keep that a claim never grants anything.

## Decision

- **goblin suggests a policy for every tool from its annotations.** A tool that says it only reads, and does not say it
  destroys, is suggested to run when needed; every other tool, one that says nothing included, is suggested to ask first.
  `ToolView.suggested` carries it (`run` or `ask`, `mcp/suggested-access.ts`).
- **A suggestion applies only when the owner chooses it.** "Use suggested access" on a server's tools
  (`POST /api/mcp/:id/suggested`) allows every tool the agent can see and turns ask first on for each one suggested to
  ask. It never turns ask first off, and touches no other grant. Nothing applies a suggestion on its own: not connecting,
  not Start, not a server's hint.
- **The rule is the same for every server.** No server is named in it; a wrong annotation costs at most a tool that
  runs without asking but only says it reads, which the owner sees in the list and can change.

## Consequences

- The tools list shows Use suggested access until the suggested state is in place; Allow all and None stay.
- Start offers the same tap for the servers it connects (the short Start that follows), replacing the first-class
  recommended grants it applied on connect.
- A server that annotates nothing gets every tool asking first once suggested access is used.
