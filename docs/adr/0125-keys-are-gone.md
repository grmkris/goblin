# ADR 0125: Keys are gone: every credential is a person's client or an installed app

Status: Accepted 2026-10-24 (owner). Supersedes ADR 0105 in full (archived). Also supersedes the key parts of:
- ADRs 0081, 0084, 0085, 0090 and 0091;
- ADR 0114: grant kind `key` and the `keys` extra;
- ADR 0116: a key on bare `/api`;
- ADR 0118: keys that remain for scripts.

## Context

ADR 0118 made a product an app that each workspace installs, with its own client_credentials token. It also made a
script an app of its own workspace. Server API keys (`gbk_…`, ADR 0081) stayed only until nothing used them. Swarmm now
runs on installations, so nothing does.

Keeping them meant two server credentials with two of everything:
- two admission paths at the edge and on `/mcp`;
- two lease holders;
- two ways a server's name reached what it made;
- a bare `/api` that names no workspace;
- a `keys` extra, owner only, that opened nothing.

## Decision

**There are two credentials.**
- **An OAuth client acting for a person:** a grant of kind `client`, one per client and person.
- **An installed app:** a grant of kind `app`, one per installation, whose id is the installation's. It uses its own
  client_credentials token.

There is no server API key. Gone with it are:
- Better Auth's `apiKey()` plugin, the `apikey` table and its `/api/auth/api-key/*` routes;
- `/w/<slug>/api/keys` and its rotation;
- Settings → API keys;
- the key-name learner.

**What replaces each part.**
- **A server a workspace runs, a script or CI** uses a script app (Settings → Developer, "A script of this workspace's").
  It is installed in its own workspace at registration with the terms it was registered with. Its backend gets a token
  from `/api/auth/oauth2/token` (client_credentials, HTTP Basic). From a shell, `goblin token` does the same with
  `GOBLIN_CLIENT_ID` and `GOBLIN_CLIENT_SECRET`. Either calls `/w/<slug>/api` or `/mcp` with that token.
- **A product many workspaces use** is an app each of them installs (ADR 0118).
- **A key's grant (ADR 0114)** is an installation's grant, with the same level, reach, extras, lifetime and origins.
  Settings → Installed apps changes it, and a widening link names it.
- **A key's secret rotation (ADR 0105)** is an app's: `POST /w/<slug>/api/developer/apps/:clientId/rotate`. The old
  secret admits nothing from then on, tokens it got end within the hour, and the installations stay with what they made.
- **A key's rate limit (ADR 0085)** is a caller's, as ADR 0086 already counted every caller. Each installed app and each
  client is counted on its own.
- **What a key made (ADRs 0108, 0115)** says the app that made it, for display: `madeBy: { app: <app name> }` on a Topic
  or a Persona. The agent's `app_made_by` keeps its columns `key_id` and `key_name`, which now hold the app's client id
  and name. No agent migration is needed.
- **A key's threads and the MCP servers they declare (ADRs 0090, 0091, 0103)** are any credential's, within its grant,
  as ADR 0114 made them. The refusal reasons lose their prefix: `key_origin`, `key_origin_tools` and `key_origin_tool`
  are now `origin`, `origin_tools` and `origin_tool`.
- **A message a key sent** is an app's. Its receipt's origin is `app`, and its author is `server <app name>` (ADR 0115).
  A receipt written before with origin `key` reads as read-only server power, as every origin goblin does not know
  does.

**Every bearer names its workspace.**
- **The owner API:** a credential calls `/w/<slug>/api/…` (ADR 0116). The Worker no longer routes a bearer on bare
  `/api/<owner path>`, so it is not found (404).
- **`/mcp`:** admits OAuth access tokens only, a person's client's or an app's. Any other bearer, a former `gbk_` key
  included, gets the sign-in challenge (401 with `WWW-Authenticate` naming the resource metadata and, for a bearer
  that was presented, `invalid_token`, ADR 0122).
- **The `workspace` argument:** every caller's tools take it, as its reach says. An app's reach is its installations.
  `workspace_list` is always offered.

**Grants.**
- `grant.kind` is `client` or `app`, and `grant.keyId` is gone.
- The `keys` extra is gone, so no extra is owner only and an owner's and an admin's role power are the same.
- `GET /api/access` and the widening page's summary say whose grant it is (`kind`) and always its `clientId`.
- The grant editor's one-workspace holder is an installation's.

**Migration.** Auth D1 `0007_no_keys.sql` drops `apikey` and every grant of kind `key`, with its `grantWorkspace` and
`grantReach` rows. It rebuilds `grant` without `keyId`, with the check `(kind = 'client' and userId is not null) or
(kind = 'app' and userId is null)`, and rebuilds `installation`, which references it. Every other row is kept as it was.
The pattern is 0006's: `PRAGMA defer_foreign_keys`, the rows copied aside, the tables dropped children first, made
again and refilled. `installation` is rebuilt too because dropping `grant` would cascade into it.

## Consequences

- A deployed key stops working when this release is live: on bare `/api` it is a 404, and on `/mcp` it gets the sign-in
  challenge. Whatever used one moves to a script app or an installation before the release is promoted.
- A workspace's slug is now in every server's calls, so changing it breaks a script that still uses the old one.
  Settings says so.
- Admission, the inspection log lines, the publish lease holders and `/mcp`'s tool naming each have one path for
  servers instead of two.
- The `@better-auth/api-key` dependency is gone.
