-- The workspaces an OAuth client's consent reaches (ADR 0097): goblin's own tables beside Better Auth's, one reach per
-- client and person. `all` reaches every workspace the person is a member of at the moment of each call, ones they
-- join later included; otherwise the listed ones, while the person is still a member of each. Removing a member takes
-- their workspace out of their reaches; deleting a workspace or an account cascades.
create table "mcpReach" ("clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text not null references "user" ("id") on delete cascade, "all" integer not null default 0, "updatedAt" date not null, primary key ("clientId", "userId"));

create table "mcpReachWorkspace" ("clientId" text not null, "userId" text not null, "workspaceId" text not null references "organization" ("id") on delete cascade, primary key ("clientId", "userId", "workspaceId"), foreign key ("clientId", "userId") references "mcpReach" ("clientId", "userId") on delete cascade);

create index "mcpReachWorkspace_workspaceId_idx" on "mcpReachWorkspace" ("workspaceId");

-- A consent no longer names a workspace (ADR 0097): every consent and token made under ADR 0089, which named one, goes,
-- and its client signs in again choosing its reach. A server's API keys are untouched.
delete from "oauthConsent" where "referenceId" is not null;

delete from "oauthAccessToken" where "referenceId" is not null;

update "oauthRefreshToken" set "revoked" = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where "referenceId" is not null and "revoked" is null;
