-- Keys are gone (ADR 0125): every credential is a person's OAuth client or an installed app. Server API keys and every
-- grant of kind `key` go, with their workspace reach and listed ids; every other row stays as it was. `grant` loses
-- `keyId` (which referenced `apikey`) and takes the kinds client and app alone.
--
-- SQLite cannot change a check or drop a referenced column in place, so the grant tables and `installation` (which
-- references `grant`) are copied aside, dropped children first (no cascade fires), made again as 0006 made them less
-- the key, and refilled; then `apikey` goes.
PRAGMA defer_foreign_keys = true;

create table "grant_0007" as select * from "grant" where "kind" <> 'key';
create table "grantWorkspace_0007" as select w.* from "grantWorkspace" w join "grant" g on g."id" = w."grantId" where g."kind" <> 'key';
create table "grantReach_0007" as select r.* from "grantReach" r join "grant" g on g."id" = r."grantId" where g."kind" <> 'key';
create table "installation_0007" as select * from "installation";
drop table "installation";
drop table "grantReach";
drop table "grantWorkspace";
drop table "grant";
drop table "apikey";

-- `grant` as 0006 made it, without `keyId`: `kind` is client or app. A client's names its client and person, an app's
-- its client and no person.
create table "grant" ("id" text not null primary key, "kind" text not null, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "name" text not null, "level" text not null, "extras" text not null default '[]', "lifetime" text not null default 'never', "expiresAt" date, "workspacesAll" integer not null default 0, "origins" text not null default '[]', "createdBy" text, "revokedAt" date, "createdAt" date not null, "updatedAt" date not null, check (("kind" = 'client' and "userId" is not null) or ("kind" = 'app' and "userId" is null)));

-- One grant per client and person (an app's grants name no person, so one per installation).
create unique index "grant_clientId_userId_uidx" on "grant" ("clientId", "userId");

create index "grant_userId_idx" on "grant" ("userId");

create table "grantWorkspace" ("grantId" text not null references "grant" ("id") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "topics" text not null default 'all', "personas" text not null default 'all', "connections" text not null default 'all', "generation" integer not null default 0, primary key ("grantId", "workspaceId"));

create index "grantWorkspace_workspaceId_idx" on "grantWorkspace" ("workspaceId");

create table "grantReach" ("grantId" text not null, "workspaceId" text not null, "kind" text not null, "resourceId" text not null, primary key ("grantId", "workspaceId", "kind", "resourceId"), foreign key ("grantId", "workspaceId") references "grantWorkspace" ("grantId", "workspaceId") on delete cascade);

create index "grantReach_workspaceId_kind_resourceId_idx" on "grantReach" ("workspaceId", "kind", "resourceId");

-- `installation` as 0006 made it.
create table "installation" ("id" text not null primary key references "grant" ("id") on delete cascade, "clientId" text not null references "app" ("clientId") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "approvedBy" text, "createdAt" date not null);

create unique index "installation_clientId_workspaceId_uidx" on "installation" ("clientId", "workspaceId");

create index "installation_workspaceId_idx" on "installation" ("workspaceId");

insert into "grant" ("id", "kind", "clientId", "userId", "name", "level", "extras", "lifetime", "expiresAt", "workspacesAll", "origins", "createdBy", "revokedAt", "createdAt", "updatedAt")
select "id", "kind", "clientId", "userId", "name", "level", "extras", "lifetime", "expiresAt", "workspacesAll", "origins", "createdBy", "revokedAt", "createdAt", "updatedAt"
from "grant_0007";

insert into "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
select "grantId", "workspaceId", "topics", "personas", "connections", "generation" from "grantWorkspace_0007";

insert into "grantReach" ("grantId", "workspaceId", "kind", "resourceId")
select "grantId", "workspaceId", "kind", "resourceId" from "grantReach_0007";

insert into "installation" ("id", "clientId", "workspaceId", "approvedBy", "createdAt")
select "id", "clientId", "workspaceId", "approvedBy", "createdAt" from "installation_0007";

drop table "installation_0007";
drop table "grantReach_0007";
drop table "grantWorkspace_0007";
drop table "grant_0007";
