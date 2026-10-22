# ADR 0097: One /mcp reaches the workspaces its consent chooses

Status: Accepted 2026-10-22 with the owner. Supersedes ADR 0089's "an OAuth client's consent names one workspace" (its
`postLogin` choice and the `workspace` token claim) and the alternative it rejected, "the workspace in every path".
Amends ADR 0086 (every tool takes the workspace a call is for, and `workspace_list`) and ADR 0093 (removing a member
takes the workspace out of their clients' reaches instead of deleting their consents).

## Context

ADR 0089 gave each OAuth consent one workspace, chosen after sign-in, and put it in the token. A coding agent that
configures the owner's Sidequest and Swarmm workspaces then needed one connection per workspace, all at the same
`/mcp` address, which some clients keep apart and some do not. Signing a client in again was the only way to point it
elsewhere. The owner wants one connection that reaches one, several or all of a person's workspaces, all of them
including those they join later.

## Decision

**A client's reach is goblin's own record, beside its consent.** `mcpReach` (one row per client and person, `all`) and
`mcpReachWorkspace` (the workspaces it lists) live in the auth D1 (`0003_mcp_reach.sql`). The consent itself names no
workspace any more: Better Auth stores it with no reference, so its standard re-authorization skip applies, and the
token carries no workspace claim. Every consent and token made under ADR 0089 is ended by the migration; each client
signs in again. A server's API keys are untouched: a key still belongs to one workspace.

**The consent page asks which workspaces.** Beside the scopes, the person chooses among their workspaces, or "All my
workspaces, including ones I join later"; their only one is chosen for them. Allow sets the reach
(`PUT /api/clients/:clientId/reach`, the person's own account API) and then the consent. Settings → Connected clients
lists each client with what it reaches, changes it without signing the client in again, and revokes it. Clients are
the person's, whichever workspace they are in: `/api/clients` left the workspace account API.

**Every call names its workspace, read live.** On every `/mcp` request the Worker reads the client's consent and its
reach: all of the person's memberships for `all`, else the listed workspaces the person is still a member of, each with
their role and how many people it has. A client given exactly one workspace never names it. Any other (several, or
`all`, so that joining a workspace never changes what a call without one means) has a required `workspace` argument,
an id or slug, on every tool; `workspace_list` and the server's instructions name what it reaches. A call goes to that
workspace's agent as the person, a member there with their role there: rate limits, author tags (ADR 0094), resident
authority and roles stay per workspace, as before. A reach of none is not a sign-in failure: the client lists none.

**Removal edits the reach.** Removing a member, or their leaving, deletes that workspace from their reaches; an `all`
reach drops it with the membership, and an explicit one never brings it back on rejoining. Deleting a workspace or an
account cascades. Revoking a client deletes its consent and reach and revokes its refresh tokens.

## Consequences

- One Claude Code connection can configure every workspace a person runs; the workspace is part of each call.
- A client that reached one workspace and is given a second starts naming it: its cached tool list is stale until it
  lists tools again, and the error says which workspaces it may name.
- A slug is accepted for readability; an id never changes, so tools that store a target should keep the id.

## Rejected

- **A reach id as the consent's reference**: Better Auth's `consentReferenceId` hook does not see the client, so a new
  reach would make a new consent row on every sign-in, and changing a reach would need another OAuth round.
- **`/w/<slug>/mcp`, one protected resource per workspace**: one resource per workspace in Better Auth and in every
  client's settings, and a slug in a URL breaks when it changes.
- **Workspace-prefixed tools (`swarmm__topic_list`)**: the tool list would grow with every workspace and change when
  one is added.
