# ADR 0127: A client may ask for a workspace its person belongs to

Status: Accepted 2026-10-27 (owner). Amends ADRs 0097 (which workspaces a client's call reaches), 0114 (what a widening
link may ask for) and 0116 (an OAuth client's token on a workspace's path).

## Context

An OAuth client's grant reaches a list of its person's workspaces, or all of them (ADRs 0097, 0114). A call naming one
of the person's workspaces outside that list answered `NotFound` `workspace`, exactly as a workspace they are not in
does. So the client had no way to ask for it: no refusal named what was missing and no link let the person widen the
grant, unlike every other refusal of a grant (`access_insufficient` with its `widenUrl`). A coding agent's client
working for Sidequest met exactly this: refused with `NotFound` for a workspace its person belongs to, with no way to
ask for it short of the person editing the grant in Settings by hand.

## Decision

**A client naming a workspace its person belongs to, outside its grant, is refused with a link to add it.** On `/mcp`
(a call's `workspace` argument, by id or slug) and on a workspace's path (`/w/<slug>/api/…`), the token's admission
(`inbound/client-access.ts`, `reachedFor` and `tokenAt`) checks the person's other workspaces, which `reachedBy` reads in
the same D1 batch as the ones the grant reaches. For one of them it answers `AccessInsufficient` with
`missing.reachId` the bare workspace id and the grant's `widenUrl`; the person may approve it on the widening page.

**Approving adds the workspace whole:** every Topic, Persona and connection in it, at the grant's level and extras,
which the person's role there still caps (ROLE_POWER). A bare workspace in a widening link means the whole workspace
(`apps/web/src/lib/widen.ts` `withReachId`); an item's id still adds that item alone.

**What still answers `NotFound`:** a workspace the person is not in (a refusal never tells a client that a workspace it
cannot see exists), and any workspace an installed app names, since an app reaches a workspace only by being installed
there (ADR 0118).

## Consequences

- A client that needs another of its person's workspaces gets the same refusal-and-link as any other missing power;
  a coding agent working across workspaces needs no trip to Settings.
- Each token admission reads one more query in the batch it already makes.

## Rejected

- **Adding the workspace empty**, its Topics, Personas and connections each to be asked for one by one: many approvals
  for what the person meant as one.
- **Keeping `NotFound` with better words:** still no way to ask, and every other refusal of a grant already links.
