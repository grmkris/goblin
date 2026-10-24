# ADR 0116: An OAuth client uses the owner API too

Status: Accepted 2026-10-24 (owner). Amends ADRs 0086 (`/mcp` was an OAuth client's only way in), 0089 (how a request
reaches a workspace's agent), 0110 (who reads a chat's stream) and 0112 (who calls the Events methods over REST).

## Context

ADR 0114 gave every credential one grant, but how a credential got in still depended on its kind. The edge took a
server's API key (`gbk_…`) on `/api/…` and a member's session on `/w/<slug>/api/…`. An OAuth client's token worked only
on `/mcp`, whose tools each call one owner endpoint for it. Every endpoint has a tool except a chat's stream: one tool
answer cannot carry server-sent events. So an OAuth client (Claude Code, the goblin CLI, an app acting for its person)
could send into a chat but never follow one live. The plan for ADR 0114 gave `stream` to the `read` level for every
credential; the edge never let a client token reach it.

## Decision

**An OAuth client's token is a bearer on its workspace's path.** `GET|POST /w/<slug>/api/…` with
`Authorization: Bearer <token>` admits the token as `/mcp` does (`inbound/client-access.ts`, shared by both):
- its signature, issuer and audience (the `/mcp` resource: one resource server, two ways in);
- the client, the person's standing consent and the live grant they gave it (ADR 0114);
- the workspace at the slug, among those its grant reaches now that its person belongs to (ADR 0097). Any other slug
  is `NotFound` `workspace`, as a session that is no member gets.

The request then reaches that workspace's agent with the credential the grant makes there and the person as a member,
exactly as a `/mcp` tool call does. So the endpoint's `EndpointAccess`, the grant's reach, the person's role
(`ROLE_POWER`), the rate limit and every refusal are the owner API's own. The stream, the Events methods and every
other endpoint serve an OAuth client with no rule of their own.

**What a token never reaches:**
- the workspace account API under the same path (`/members`, `/keys`), which is people's: `Forbidden` `credential`;
- the person and account routes on bare `/api/…` (workspaces, invitations, clients, grants), which take a session;
- any request that carries a session cookie too. One request has one principal: `Forbidden` `bearer_and_session`.

A server's API key is unchanged: `/api/…`, its own workspace. Its successor is an installed app (ADR 0117), so its
path does not move now.

**ADR 0089's rule**, as AGENTS.md states it, gains this way in: a request reaches an agent through its key's workspace,
a workspace an OAuth client's call names among those its reach covers (its `/mcp` arguments, or now its path), or a
session's slug, each after a live membership check.

## Consequences

- The goblin CLI follows a chat (`goblin follow <chat>`) with its OAuth token, and so can any client a person connects.
- goblin's own live checks need no session cookie: a checks identity signs in through the CLI's OAuth login.
- A token's audience stays `/mcp`. A client asks for one token and uses it on both ways in. The protected-resource
  metadata keeps naming `/mcp`, the resource MCP clients ask for.
- Browsers never send a token: goblin's web keeps its session, and with no CORS a foreign page cannot read an answer.

## Rejected

- **A second resource (`/api`) with its own audience.** That means two tokens, or a token for two resources, for one
  server; and every MCP client asks for `/mcp`, which it then could not use here.
- **A stream tool on `/mcp`** (progress notifications carrying events). A tool's result is one answer; a host's model
  reads it whole. Live following is for screens, which read the stream over HTTP.
