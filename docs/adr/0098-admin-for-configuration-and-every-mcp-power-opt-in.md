# ADR 0098: Admin for configuration on every surface; every MCP power is opt-in

Status: Accepted 2026-10-22 with the owner. Amends ADR 0093 (the admin list grows by what the agent works with) and ADR
0086 (asking the agent becomes a consent switch, the conversations in full get their own, and two new ones open setups
and routines to OAuth clients).

## Context

ADR 0093 made changing what the agent may do an admin's: connections, grants, Sources, the model, resident authority,
routine settings and confirming. What the agent works with stayed every member's: any member could rewrite a
Persona's instructions or a Topic's guidance and setup, and draft or change routines. On `/mcp` no admin endpoint had
a scope, so a member's client and an admin's had the same tools, and a coding agent could not read what a setup is
chosen from, nor touch routines. Every client could ask the agent, and reading how chats ran came with reading every
conversation in full.

## Decision

**What the agent works with takes an admin, in the web and on MCP alike**, by the contract's `EndpointRole`, which
owner admission checks for a session and for a client acting for a member: making and changing Personas, a Topic's
setup, and drafting, changing, archiving, pausing and running routines. A Topic stays every member's to make, rename
and archive; giving it guidance or a setup, when made or later, takes an admin (`requireAdminFor`). The web hides
these editors from members and says why. A test pins the whole admin list (`test/http/api/roles.test.ts`).

**Every MCP power is a consent switch.** `goblin:agent` (asking the agent in main and reading main back) starts on and
can be turned off; `goblin:inspect` reads how chats ran, never their words; `goblin:transcripts` reads conversations in
full; `goblin:setup` reads what setups are chosen from (the servers with their granted tools, skills and apps) and the
Sources with their routes; `goblin:routines` reads routines and their runs and, for an admin, drafts, changes, pauses
and archives them. Confirming a routine, like a Source, stays the web's, so a client never approves its own draft.
Connections, grants, resident authority, files and keys stay off `/mcp`. Keys hold none of the new scopes: they stay
`topics`, `conversations`, `personas` and `inspect`. Registered clients take the whole new scope list
(`0004_mcp_powers.sql`); the consent still decides each.

## Consequences

- A plain member reads Personas, setups and routines and uses them, and asks an admin to change them.
- A coding agent configuring a workspace reads `setup_catalog` for the connection ids and tool names a setup may name,
  then writes Personas and Topic setups; it needs an admin's consent to do so.
- A client consented without `goblin:agent` cannot ask the agent; one with `goblin:inspect` alone no longer reads
  conversations in full.

## Rejected

- **Admin for the catalog read too**: members already see it in the web, where they pick a Topic's tools to ask about.
- **Routine confirm over MCP**: a client would approve its own draft.
