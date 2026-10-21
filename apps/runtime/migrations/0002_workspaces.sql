-- Workspaces (ADR 0089): Better Auth 1.7.11's organization() plugin tables, configured in
-- apps/runtime/src/auth/options.ts. Additive so production keeps its accounts and agents; it folds into the baseline
-- at the next reset the owner decides on. A workspace owns the agent named by its ID; a person belongs to it with a
-- role.
create table "organization" ("id" text not null primary key, "name" text not null, "slug" text not null unique, "logo" text, "createdAt" date not null, "metadata" text);

create index "organization_slug_idx" on "organization" ("slug");

create table "member" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "role" text not null, "createdAt" date not null);

create index "member_organizationId_idx" on "member" ("organizationId");

create index "member_userId_idx" on "member" ("userId");

-- One membership per person and workspace. D1 runs Better Auth's writes without a transaction, so this index, not a
-- read before the write, keeps a second one out.
create unique index "member_organizationId_userId_uidx" on "member" ("organizationId", "userId");

create table "invitation" ("id" text not null primary key, "organizationId" text not null references "organization" ("id") on delete cascade, "email" text not null, "role" text, "status" text not null, "expiresAt" date not null, "createdAt" date not null, "inviterId" text not null references "user" ("id") on delete cascade);

create index "invitation_organizationId_idx" on "invitation" ("organizationId");

create index "invitation_email_idx" on "invitation" ("email");

alter table "session" add column "activeOrganizationId" text;

-- Every existing account keeps its agent: its workspace takes the account's ID, which names the agent, its files, its
-- Events hooks and its sealed model endpoint. The slug is the address's local part, its dots, underscores and pluses
-- made hyphens, then the ID's first four characters, so two accounts never share one; a local part with any other
-- character gives `ws-` and the ID's first eight. The owner can change both name and slug.
insert into "organization" ("id", "name", "slug", "createdAt")
select
  "id",
  case when trim("name") = '' then substr("email", 1, instr("email", '@') - 1) else trim("name") end || '''s workspace',
  case
    when lower(substr("email", 1, instr("email", '@') - 1)) glob '*[^a-z0-9._+-]*'
      then 'ws-' || lower(substr("id", 1, 8))
    else lower(replace(replace(replace(substr(substr("email", 1, instr("email", '@') - 1), 1, 30), '.', '-'), '_', '-'), '+', '-'))
      || '-' || lower(substr("id", 1, 4))
  end,
  "createdAt"
from "user";

insert into "member" ("id", "organizationId", "userId", "role", "createdAt")
select lower(hex(randomblob(16))), "id", "id", 'owner', "createdAt" from "user";

-- An account's keys and the consents its OAuth clients hold move to its workspace, whose ID is the same.
update "apikey" set "metadata" = json_set(coalesce("metadata", '{}'), '$.createdBy', "referenceId");

update "oauthConsent" set "referenceId" = "userId" where "referenceId" is null;

update "oauthRefreshToken" set "referenceId" = "userId" where "referenceId" is null;

update "oauthAccessToken" set "referenceId" = "userId" where "referenceId" is null and "userId" is not null;
