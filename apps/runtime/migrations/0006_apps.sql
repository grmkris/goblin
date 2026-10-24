-- Apps and their installations (ADR 0118): goblin's own tables beside Better Auth's. A product a workspace registers is
-- a confidential OAuth client (Better Auth's `oauthClient`, made server-side with the client_credentials grant) that
-- belongs to that workspace (`app`). An owner or admin of a workspace installs it there (`installation`); what it may do
-- is the installation's grant, a `grant` of the new kind `app` whose id is the installation's, so what names the
-- installation keeps naming its grant, as a key's does. Deleting the client, the owning workspace or the installed
-- workspace cascades; an installation outlives the person who approved it.
--
-- `grant` takes the kind `app`. SQLite cannot change a check in place, so the three grant tables are copied aside,
-- dropped children first (no cascade fires), made again as 0005 made them with the wider check, and refilled.
PRAGMA defer_foreign_keys = true;

create table "grant_0006" as select * from "grant";
create table "grantWorkspace_0006" as select * from "grantWorkspace";
create table "grantReach_0006" as select * from "grantReach";
drop table "grantReach";
drop table "grantWorkspace";
drop table "grant";

-- `grant` as 0005 made it; `kind` is now key, client or app. An app's grant names its client and no person.
create table "grant" ("id" text not null primary key, "kind" text not null, "keyId" text unique references "apikey" ("id") on delete cascade, "clientId" text references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "name" text not null, "level" text not null, "extras" text not null default '[]', "lifetime" text not null default 'never', "expiresAt" date, "workspacesAll" integer not null default 0, "origins" text not null default '[]', "createdBy" text, "revokedAt" date, "createdAt" date not null, "updatedAt" date not null, check (("kind" = 'key' and "keyId" is not null and "clientId" is null and "userId" is null) or ("kind" = 'client' and "keyId" is null and "clientId" is not null and "userId" is not null) or ("kind" = 'app' and "keyId" is null and "clientId" is not null and "userId" is null)));

-- One grant per client and person (an app's grants name no person, so one per installation).
create unique index "grant_clientId_userId_uidx" on "grant" ("clientId", "userId");

create index "grant_userId_idx" on "grant" ("userId");

create table "grantWorkspace" ("grantId" text not null references "grant" ("id") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "topics" text not null default 'all', "personas" text not null default 'all', "connections" text not null default 'all', "generation" integer not null default 0, primary key ("grantId", "workspaceId"));

create index "grantWorkspace_workspaceId_idx" on "grantWorkspace" ("workspaceId");

create table "grantReach" ("grantId" text not null, "workspaceId" text not null, "kind" text not null, "resourceId" text not null, primary key ("grantId", "workspaceId", "kind", "resourceId"), foreign key ("grantId", "workspaceId") references "grantWorkspace" ("grantId", "workspaceId") on delete cascade);

create index "grantReach_workspaceId_kind_resourceId_idx" on "grantReach" ("workspaceId", "kind", "resourceId");

insert into "grant" ("id", "kind", "keyId", "clientId", "userId", "name", "level", "extras", "lifetime", "expiresAt", "workspacesAll", "origins", "createdBy", "revokedAt", "createdAt", "updatedAt")
select "id", "kind", "keyId", "clientId", "userId", "name", "level", "extras", "lifetime", "expiresAt", "workspacesAll", "origins", "createdBy", "revokedAt", "createdAt", "updatedAt"
from "grant_0006";

insert into "grantWorkspace" ("grantId", "workspaceId", "topics", "personas", "connections", "generation")
select "grantId", "workspaceId", "topics", "personas", "connections", "generation" from "grantWorkspace_0006";

insert into "grantReach" ("grantId", "workspaceId", "kind", "resourceId")
select "grantId", "workspaceId", "kind", "resourceId" from "grantReach_0006";

drop table "grantReach_0006";
drop table "grantWorkspace_0006";
drop table "grant_0006";

-- `app`: a registered product, by its OAuth client. `workspaceId` is the workspace that registered it, whose owners
-- and admins manage it; `terms` the JSON grant terms it asks for, which an install starts from; `script` a script app's,
-- registered with no redirect address and installed only in its own workspace; `createdBy` who registered it, for
-- display only.
create table "app" ("clientId" text not null primary key references "oauthClient" ("clientId") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "terms" text not null, "script" integer not null default 0, "createdBy" text, "createdAt" date not null);

create index "app_workspaceId_idx" on "app" ("workspaceId");

-- `installation`: an app installed in a workspace, once per pair. Its id is its grant's; `approvedBy` who approved it,
-- for display only (no cascade: it outlives them).
create table "installation" ("id" text not null primary key references "grant" ("id") on delete cascade, "clientId" text not null references "app" ("clientId") on delete cascade, "workspaceId" text not null references "organization" ("id") on delete cascade, "approvedBy" text, "createdAt" date not null);

create unique index "installation_clientId_workspaceId_uidx" on "installation" ("clientId", "workspaceId");

create index "installation_workspaceId_idx" on "installation" ("workspaceId");
