-- One grant for every credential (myapps ADR 0015's terms, `packages/contracts/src/grants.ts`): goblin's own tables
-- beside Better Auth's. A server's API key has one grant, whose id is the key's own, so what names the key keeps naming
-- its grant; an OAuth client has one grant per person who approved it (`cg_` and a UUID). Better Auth's `apikey` keeps
-- the key's secret and `oauthConsent` the OAuth flow; what either may do is its grant. Deleting the key, the client,
-- the person or a workspace cascades.
--
-- `grant`: the terms. `level` is read, write or manage; `extras` a JSON array of setup, routines, inspect and keys;
-- `lifetime` never or 1d, 7d, 30d, 90d or 365d, and `expiresAt` when it ends (none until revoked); `workspacesAll`
-- reaches every workspace of the person's (an OAuth client's), else those in `grantWorkspace`; `origins` the JSON MCP
-- origins and tools its threads may bring (ADR 0091). `createdBy` names who made it, for display only.
create table "grant" ("id" text not null primary key, "kind" text not null, "keyId" text unique references "apikey" ("id") on delete cascade, "clientId" text references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "name" text not null, "level" text not null, "extras" text not null default '[]', "lifetime" text not null default 'never', "expiresAt" date, "workspacesAll" integer not null default 0, "origins" text not null default '[]', "createdBy" text, "revokedAt" date, "createdAt" date not null, "updatedAt" date not null, check (("kind" = 'key' and "keyId" is not null and "clientId" is null and "userId" is null) or ("kind" = 'client' and "keyId" is null and "clientId" is not null and "userId" is not null)));

-- One grant per client and person.
create unique index "grant_clientId_userId_uidx" on "grant" ("clientId", "userId");

create index "grant_userId_idx" on "grant" ("userId");

-- `grantWorkspace`: what a grant reaches in one workspace: its Topics, Personas and connections each `all` or `list`
-- (then the ids in `grantReach`), and the generation the agent compares to know when to read the lists again.
create table "grantWorkspace" ("grantId" text not null references "grant" ("id") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "topics" text not null default 'all', "personas" text not null default 'all', "connections" text not null default 'all', "generation" integer not null default 0, primary key ("grantId", "workspaceId"));

create index "grantWorkspace_workspaceId_idx" on "grantWorkspace" ("workspaceId");

-- `grantReach`: the listed ids, `kind` topic, persona or connection; `resourceId` a Topic's or a Persona's number in
-- decimal, or a connection's id.
create table "grantReach" ("grantId" text not null, "workspaceId" text not null, "kind" text not null, "resourceId" text not null, primary key ("grantId", "workspaceId", "kind", "resourceId"), foreign key ("grantId", "workspaceId") references "grantWorkspace" ("grantId", "workspaceId") on delete cascade);

-- Who reaches one Topic, Persona or connection, for its views.
create index "grantReach_workspaceId_kind_resourceId_idx" on "grantReach" ("workspaceId", "kind", "resourceId");
