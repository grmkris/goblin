# ADR 0095: The owner's subscription workspace takes no members

Status: Accepted 2026-10-21 with the owner, before ADR 0093's invitations reach prod. Amends ADR 0093: inviting into
the deployment owner's own workspace is refused while it is offered their subscriptions (ADR 0087).

## Context

ADR 0087 offers the deployment owner's own subscription models (`OWNER_MODELS`) in their own workspace alone
(`OWNER_WORKSPACE_ID`, ADR 0089), on the rule that they serve the owner and nobody else. ADR 0093 lets any workspace
invite people, and every member works with the workspace's agent and its model choice: a member's message in a
channel set to a subscription model would be answered on the owner's subscription.

## Decision

**A workspace that is offered the owner's subscriptions takes no invitations** (`offersOwnerModels`): inviting into it
is refused (`Conflict`, `owner_models`), and Settings says to make another workspace to work with others. Every other
workspace invites as ADR 0093 says, and the owner works with other people in those.

## Consequences

- The owner's own workspace stays theirs alone while the deployment names subscriptions for it. Taking them out of
  `OWNER_MODELS` lets it invite.
- A membership made before this held stays until it is removed.

## Rejected

- **Offering the subscriptions only while the workspace has one member**: the agent learns how many people its
  workspace has from each request, so a routine's or a Source's turn could run on a subscription after someone
  joined and before anyone wrote.
- **Serving the subscriptions only for the owner's own messages**: a turn answers a channel every member reads, so its
  answer would still serve them.
