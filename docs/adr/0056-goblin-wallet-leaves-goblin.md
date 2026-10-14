# 0056: Goblin Wallet leaves goblin

Accepted 2026-10-14 with the owner. Supersedes ADR 0045 (Goblin Wallet), ADR 0050 (gas in USDC through
UserOperations) and ADR 0051 (the Tempo float). It is the first step of the cleanup that takes crypto out of goblin.

## Context

Goblin Wallet was built in this repository for the October 2026 hackathon: a second Worker (`apps/wallet`), its
console (`apps/wallet-web`) and a shared library (`packages/wallet`), released by goblin's own CI. goblin's core grew
around it: Pro paid as a USDC subscription, inference paid per call, Mercator topped up from it, and a first-run Start
that waited for a funded wallet. The owner wants goblin to be a generic, open-source MCP client with no payment code,
and the wallet to become a product of its own (mywallet, in myapps).

## Decision

- The three wallet workspaces, their stage and release scripts and their CI steps are deleted from goblin. The tag
  `hackathon-2026-10` keeps their source for the port.
- The deployed wallet Workers (`wallet.goblin.surf`, `wallet-dev.goblin.surf`) keep running untouched. Nothing in goblin
  deploys them any more, and no destroy runs against the `goblin-wallet` Alchemy state.
- goblin reaches a wallet only as an MCP server, like any other. Its remaining wallet-specific code (billing, paid
  inference, top-ups, the first-class profile, Start's wallet step and the shelf entry) is removed by the cleanup's
  later decisions; until then goblin talks to the deployed wallet as it did.

## Consequences

- goblin's deploy jobs release goblin alone: a wallet failure can no longer block a goblin release.
- A fix to a deployed wallet needs a checkout of the tag and a break-glass deploy with its old scripts.
- `@goblin/ui` keeps what goblin uses; wallet-only parts leave with their last goblin user.
