# ADR 0114: One grant for every credential

Status: Accepted 2026-10-23 (owner); release A built. Amends ADRs 0081, 0084, 0086, 0091, 0097, 0098 and 0105.
Release B (sealed Topics, rooms removed) is ADR 0115.

## Context

goblin had grown about ten separate permission mechanisms for the two kinds of credential that call it:

- a server's API key held key scopes (`topics`, `conversations`, `personas`, `inspect`), a server ceiling for its
  setups and MCP origins for its threads (ADRs 0081, 0084, 0091);
- an OAuth client held `goblin:*` scopes from its consent (ADRs 0086, 0098) and a separate list of the workspaces it
  reaches (ADR 0097);
- a key reached only what it made itself (`app_key_reach`), so a Persona the owner made was `NotFound` to the owner's
  own server; a key's server limit could not be changed after it was made; and OAuth scopes and key scopes were two
  vocabularies for the same endpoints.

myapps solved the same problem once for its apps (myapps ADR 0015): one grant of level × reach × extras × lifetime,
one consent and widening design, and a refusal that says what is missing and links to widening it.

## Decision

**Every credential has one grant.** A server's API key has one, whose id is the key's own; an OAuth client has one per
person who approved it (`cg_` and a UUID). The grant lives in goblin's own auth D1 tables (`grant`, `grantWorkspace`,
`grantReach`, migration `0005_grants.sql`); Better Auth keeps only the key's secret and the OAuth flow. Its terms are
`packages/contracts/src/grants.ts`, ported from myapps' `packages/grants`:

- **Level:** `read` < `write` < `manage`. `read` sees within reach; `write` also sends, makes Topics and threads,
  answers questions and stops runs; `manage` also makes and changes Personas and a Topic's settings.
- **Extras:** `setup` (setups, Sources and servers; risky), `routines` (risky), `inspect` (how chats ran, within
  reach) and `keys` (owner only; vocabulary only for now, it opens nothing).
- **Reach:** per workspace, Topics, Personas and connections are each `all` or a list. There is no "own": a credential
  whose reach of a kind is a list has what it makes added to its list. A client's grant reaches all of its person's
  workspaces (ones joined later included) or the listed ones; a key's reaches its own workspace. The MCP origins its
  threads may bring (ADR 0091) are part of the grant, for either kind.
- **Lifetime:** until revoked (the default), or 1, 7, 30, 90 or 365 days. A key no longer expires on its own; it
  rotates (ADR 0105), and its grant's lifetime ends it.

**What an endpoint needs is its `EndpointAccess`** (`packages/contracts/src/api/access.ts`): a level and sometimes an
extra, on the 40 owner endpoints a credential may call. An endpoint without one takes no credential (`Forbidden`
`credential`). `EndpointScope`, the key and caller scopes, the key's servers and the client reach are gone.

**Admission checks the grant, the handler checks the reach.** The edge checks a key's level and extra before it wakes
an agent; the agent's owner admission checks them again for every credential (`/mcp` calls reach the agent directly),
and for an OAuth client also that its person's role holds them (`ROLE_POWER`: owner everything, admin all but `keys`,
member `write` and `inspect`). A grant past its end is `Unauthenticated` `grant_expired`. Handlers check reach with
`grants/policy.ts` (`reaches`, `claim`, `confineSetup`, `confineThreadServer`, `inspectReach`). A refusal for want of
access is `AccessInsufficient` (403): what is missing (level, extra or a reach id `<workspace>/<kind>/<id>`) and a
`widenUrl` to the widening page (`/consent/widen?grant=…`), with fixed copy.

**The agent mirrors a credential's lists.** The Worker forwards the credential (`x-goblin-caller`): its kind, id,
name, grant id, level, extras, end, origins, and in the workspace the request reaches whether its Topics, Personas and
connections are all or a list, with the reach's generation. The lists never travel in the header. The agent keeps
`app_grant_sync` and `app_grant_reach` and reads the lists again from the auth D1 when the forwarded generation is not
the one it holds (`Grants.sync`), so every reach check is one SQL join, including the published Events' fan-out, which
runs with no request.

**OAuth tokens carry one scope, `goblin`.** What a client may do is its grant, which its person approves on the
consent page (`PUT /api/clients/:clientId/grant` before the consent) and changes in Settings; a live token follows a
change at once, with no new consent. The token's scope claim counts for nothing. A grant past its end deletes the
consent and revokes the refresh tokens, so the next sign-in asks again, pre-filled by the default chain (the same
client's last terms, else the person's latest grant without risky extras, else the preset).

**One widening page for both kinds.** `GET /api/grants/:id/terms` and `PUT /api/grants/:id` serve the page a refusal
links to: a key's grant to an owner or admin of its workspace, a client's to its person. `/mcp` offers the link as URL
elicitation to a client that declares it, else answers the error result; `access_read` (and `GET /api/access`) say
what a credential holds and where to widen it.

**Defaults.** A new key and a new MCP client start at `write`, every Topic, Persona and connection, no extras, until
revoked.

**Rooms stay in this release.** A Topic a key makes is still a room (ADR 0108), recorded in `app_key_reach` for that and
for display ("made by"). Nothing a credential may reach depends on it. Release B replaces rooms with sealed Topics.

## Migration

One forward migration on each store, no reset:

- auth D1 `0005_grants.sql`: each key becomes a grant (`manage` if it held `topics` or `personas`, else `write` with
  `conversations`, else `read`; `inspect` from `inspect`, `setup` when it held `topics` and named servers; every Topic
  and Persona, the connections it named, its origins; its lifetime the bucket its expiry falls in, keeping the
  expiry); each consent becomes a grant (level and extras from its `goblin:*` scopes, `transcripts` as `inspect`; a
  consent to asking the agent alone reaches Personal alone; workspaces from its reach); then the key's permissions and
  expiry are cleared, `mcpReach` and `mcpReachWorkspace` are dropped and every consent, token, client and the resource
  ask for `goblin`.
- agent `GRANTS`: the mirror tables, `app_thread_servers.key_id` renamed `grant_id` (a key's grant has its id), and
  `app_publish_subscriptions.grant_id`, backfilled for keys' leases; clients' leases end, since the agent cannot know
  a client's grant before its next request.

## Consequences

- A key reads the owner's Personas and Topics by default; one that must stay inside what it makes is given lists.
  Migrated keys reach every Topic and Persona of their workspace, wider than before: list the prod keys before promoting
  and confirm or revoke each.
- OAuth clients holding `goblin:*` scopes keep working on their tokens; a refresh that names the old scopes fails, and
  the client signs in again once.
- The consent page, the widening page and Settings edit one shape for both kinds (release A's web lane).
- What a turn may do once admitted (the sender's grant intersected with the Persona and the Topic) is ADR 0115's.
