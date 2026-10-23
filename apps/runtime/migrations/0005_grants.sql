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

-- What every key and consent made before held becomes its grant, the old columns and tables go, and every OAuth scope
-- is `goblin` from now on: what a client may do is its grant, which the person edits without signing it in again.
-- `grantConsent` is this file's own working table, dropped at its end.
--
-- A key: `manage` when its scopes held `topics` or `personas`, else `write` with `conversations`, else `read`;
-- `inspect` from `inspect`, and `setup` when it held `topics` and named servers for its setups; every Topic and Persona
-- of its workspace, and the connections it named; its origins; its lifetime the bucket its expiry falls in (1, 7, 30,
-- 90 or 365 days), keeping that expiry, which the grant holds from now on (the key's own goes).
insert into "grant" ("id", "kind", "keyId", "name", "level", "extras", "lifetime", "expiresAt", "workspacesAll", "origins", "createdBy", "createdAt", "updatedAt")
select k."id", 'key', k."id", coalesce(nullif(k."name", ''), 'API key'),
  case
    when exists (select 1 from json_each(case when json_valid(k."permissions") and json_type(k."permissions", '$.goblin') = 'array' then k."permissions" else '{"goblin":[]}' end, '$.goblin') s where s."value" in ('topics', 'personas')) then 'manage'
    when exists (select 1 from json_each(case when json_valid(k."permissions") and json_type(k."permissions", '$.goblin') = 'array' then k."permissions" else '{"goblin":[]}' end, '$.goblin') s where s."value" = 'conversations') then 'write'
    else 'read'
  end,
  (select json_group_array(e."extra") from (
    select 'setup' as "extra" where exists (select 1 from json_each(case when json_valid(k."permissions") and json_type(k."permissions", '$.goblin') = 'array' then k."permissions" else '{"goblin":[]}' end, '$.goblin') s where s."value" = 'topics')
      and exists (select 1 from json_each(case when json_valid(k."metadata") and json_type(k."metadata", '$.servers') = 'array' then k."metadata" else '{"servers":[]}' end, '$.servers'))
    union all
    select 'inspect' where exists (select 1 from json_each(case when json_valid(k."permissions") and json_type(k."permissions", '$.goblin') = 'array' then k."permissions" else '{"goblin":[]}' end, '$.goblin') s where s."value" = 'inspect')
  ) e),
  case
    when k."expiresAt" is null then 'never'
    when julianday(k."expiresAt") - julianday(k."createdAt") <= 1.01 then '1d'
    when julianday(k."expiresAt") - julianday(k."createdAt") <= 7.01 then '7d'
    when julianday(k."expiresAt") - julianday(k."createdAt") <= 30.01 then '30d'
    when julianday(k."expiresAt") - julianday(k."createdAt") <= 90.01 then '90d'
    else '365d'
  end,
  k."expiresAt", 0,
  coalesce((select json(json_extract(k."metadata", '$.origins')) where json_valid(k."metadata") and json_type(k."metadata", '$.origins') = 'array'), '[]'),
  (select json_extract(k."metadata", '$.createdBy') where json_valid(k."metadata")),
  k."createdAt", k."updatedAt"
from "apikey" k;

insert into "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
select k."id", k."referenceId", 'all', 'all', 'list', 1
from "apikey" k where exists (select 1 from "organization" o where o."id" = k."referenceId");

insert or ignore into "grantReach" ("grantId", "workspaceId", "kind", "resourceId")
select k."id", k."referenceId", 'connection', s."value"
from "apikey" k, json_each(case when json_valid(k."metadata") and json_type(k."metadata", '$.servers') = 'array' then k."metadata" else '{"servers":[]}' end, '$.servers') s
where exists (select 1 from "organization" o where o."id" = k."referenceId") and s."type" = 'text';

-- The key's scopes, servers, origins and expiry now live in its grant; its metadata keeps who made it.
update "apikey" set "permissions" = null, "expiresAt" = null,
  "metadata" = case when json_valid("metadata") and json_extract("metadata", '$.createdBy') is not null
    then json_object('createdBy', json_extract("metadata", '$.createdBy')) else null end;

-- A consent: which `goblin:*` scopes it granted, and its reach. `agentOnly` is a consent to asking the agent in main
-- and no Topic, chat or Persona: its grant reaches Personal (Topic 1) alone.
create table "grantConsent" ("clientId" text not null, "userId" text not null, "name" text not null, "level" text not null, "extras" text not null, "agentOnly" integer not null, "everything" integer not null, "createdAt" date not null, "updatedAt" date not null, primary key ("clientId", "userId"));

insert or ignore into "grantConsent" ("clientId", "userId", "name", "level", "extras", "agentOnly", "everything", "createdAt", "updatedAt")
select o."clientId", o."userId", coalesce(nullif(c."name", ''), 'MCP client'),
  case
    when exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" in ('goblin:topics', 'goblin:personas')) then 'manage'
    when exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" in ('goblin:conversations', 'goblin:agent')) then 'write'
    else 'read'
  end,
  (select json_group_array(e."extra") from (
    select 'setup' as "extra" where exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" = 'goblin:setup')
    union all
    select 'routines' where exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" = 'goblin:routines')
    union all
    select 'inspect' where exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" in ('goblin:inspect', 'goblin:transcripts'))
  ) e),
  case when exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" = 'goblin:agent')
    and not exists (select 1 from json_each(case when json_valid(o."scopes") and json_type(o."scopes") = 'array' then o."scopes" else '[]' end) s where s."value" in ('goblin:topics', 'goblin:conversations', 'goblin:personas'))
    then 1 else 0 end,
  coalesce((select r."all" from "mcpReach" r where r."clientId" = o."clientId" and r."userId" = o."userId"), 0),
  o."createdAt", o."updatedAt"
from "oauthConsent" o join "oauthClient" c on c."clientId" = o."clientId"
where o."referenceId" is null and o."userId" is not null;

-- Each consent's grant: every workspace of its person's when its reach was all of them, else the listed ones; an
-- agent-only one lists its person's workspaces it reached, each reaching Personal alone.
insert into "grant" ("id", "kind", "clientId", "userId", "name", "level", "extras", "lifetime", "workspacesAll", "origins", "createdBy", "createdAt", "updatedAt")
select 'cg_' || lower(hex(randomblob(16))), 'client', g."clientId", g."userId", g."name", g."level", g."extras", 'never',
  case when g."agentOnly" = 1 then 0 else g."everything" end, '[]', g."userId", g."createdAt", g."updatedAt"
from "grantConsent" g;

insert into "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
select gr."id", w."workspaceId", 'all', 'all', 'all', 1
from "grantConsent" g join "grant" gr on gr."clientId" = g."clientId" and gr."userId" = g."userId"
join "mcpReachWorkspace" w on w."clientId" = g."clientId" and w."userId" = g."userId"
where g."agentOnly" = 0 and g."everything" = 0
  and exists (select 1 from "member" m where m."organizationId" = w."workspaceId" and m."userId" = g."userId");

insert into "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
select gr."id", m."organizationId", 'list', 'list', 'all', 1
from "grantConsent" g join "grant" gr on gr."clientId" = g."clientId" and gr."userId" = g."userId"
join "member" m on m."userId" = g."userId"
where g."agentOnly" = 1 and (g."everything" = 1 or exists (select 1 from "mcpReachWorkspace" w
  where w."clientId" = g."clientId" and w."userId" = g."userId" and w."workspaceId" = m."organizationId"));

insert into "grantReach" ("grantId", "workspaceId", "kind", "resourceId")
select w."grantId", w."workspaceId", 'topic', '1'
from "grantWorkspace" w join "grant" gr on gr."id" = w."grantId"
where gr."kind" = 'client' and w."topics" = 'list';

drop table "grantConsent";

drop table "mcpReachWorkspace";

drop table "mcpReach";

-- One scope, `goblin`, for every consent, token and client from now on, beside the sign-in scopes.
update "oauthConsent" set "scopes" = (select json_group_array(x."scope") from (
  select s."value" as "scope" from json_each("scopes") s where s."value" not like 'goblin%'
  union all
  select 'goblin' where exists (select 1 from json_each("scopes") s where s."value" like 'goblin%')
) x) where json_valid("scopes");

update "oauthRefreshToken" set "scopes" = (select json_group_array(x."scope") from (
  select s."value" as "scope" from json_each("scopes") s where s."value" not like 'goblin%'
  union all
  select 'goblin' where exists (select 1 from json_each("scopes") s where s."value" like 'goblin%')
) x) where json_valid("scopes");

update "oauthAccessToken" set "scopes" = (select json_group_array(x."scope") from (
  select s."value" as "scope" from json_each("scopes") s where s."value" not like 'goblin%'
  union all
  select 'goblin' where exists (select 1 from json_each("scopes") s where s."value" like 'goblin%')
) x) where json_valid("scopes");

update "oauthClient" set "scopes" = '["openid","profile","email","offline_access","goblin"]' where "scopes" is not null;

update "oauthResource" set "allowedScopes" = '["openid","profile","email","offline_access","goblin"]';
