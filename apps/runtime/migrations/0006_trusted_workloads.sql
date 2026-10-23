-- Trust follows an existing server grant (ADR 0116). No Better Auth or agent tables change.
create table "trustedWorkloadPolicy" (
  "id" text not null primary key,
  "workspaceId" text not null references "organization" ("id") on delete cascade,
  "issuer" text not null,
  "policy" text not null check (json_valid("policy")),
  "label" text not null,
  "grantId" text not null references "grant" ("id") on delete cascade,
  "createdBy" text not null,
  "createdAt" date not null,
  "disabledAt" date
);
create index "trustedWorkloadPolicy_workspace_idx" on "trustedWorkloadPolicy" ("workspaceId");
create index "trustedWorkloadPolicy_issuer_idx" on "trustedWorkloadPolicy" ("issuer", "disabledAt");

-- Hash only, no refresh token. Keep issuer+jti digests until assertion expiry to refuse a second exchange.
create table "workloadAccessToken" (
  "hash" text not null primary key,
  -- Retain the replay receipt until assertion expiry even if its policy is deleted. Admission reads the policy live.
  "policyId" text not null,
  "assertionId" text not null unique,
  "expiresAt" integer not null,
  "assertionExpiresAt" integer not null
);
create index "workloadAccessToken_expiry_idx" on "workloadAccessToken" ("assertionExpiresAt");
