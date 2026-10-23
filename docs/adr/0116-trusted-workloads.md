# ADR 0116: Trusted workloads use platform OIDC assertions and the server's grant

Status: proposed (spike). Extends ADRs 0081, 0086 and 0114; preserves ADRs 0091, 0103 and 0105. ADR 0115 is
reserved by ADR 0114 for sealed Topics. This decision concerns machine authentication; ADR 0064 remains user sign-in.

A server such as Swarmm currently holds a long-lived `GOBLIN_API_KEY`. A GitHub Actions job can instead obtain an
expiring platform identity. The proposed slice lets a workspace manager trust exact issuer/claim rules and attach them
to the server's existing grant, so its identity, Topics, Personas and allowed MCP origins survive the switch.

## Decision

**Trust is workspace configuration.** Settings → Trusted workloads lists, creates and disables policies through the
workspace account API, behind the existing owner/admin, session, membership, Origin and CSRF checks. The additive auth
D1 migration `0006_trusted_workloads.sql` keeps the OIDC UI policy JSON (`{ issuer, claims, label? }`), indexed issuer,
label, grant, maker, creation time and disabled time. The shared validator and forms are adapted from the public
[OIDC UI registry](https://ui.shadcn.com/oidc/docs/save-and-verify); every listed claim matches an exact string,
array claims match by intersection, and `aud` is mandatory. The UI offers GitHub repository/branch and custom
issuer/subject forms. The typed API accepts additional exact claim rules.

**A policy uses an existing server grant.** Its workspace and the grant's workspace must agree; a manager must be
allowed to approve that grant. Nothing copies its permissions. Every request reads the live policy and grant, then
uses the existing server-key principal, owner admission, grant reach mirror, per-minute count and MCP origin checks
(ADRs 0091, 0103, 0114). It never grants resident authority. The manager may retire the static secret via Better Auth's
`updateApiKey(enabled: false)` when saving; the key row remains the identity anchor. A failed retirement removes the
new policy. Changing the grant affects all its workload and static credentials. Revoking the key deletes its grant and
cascades the policies. Exchanged token hashes retain replay receipts until assertion expiry, even if a policy is deleted. Disabling one policy affects its direct and exchanged tokens at their next
request, without revoking the shared grant. Rotating the static secret does not revoke workload trust.

**One verified match selects the workspace.** An unverified `iss` is only a bounded indexed lookup hint (at most 100
candidate policies); it starts no discovery unless a saved policy names it. The verified token must match exactly one
active policy across all workspaces. Zero matches fail; multiple matches fail `ambiguous-policy`, never select the first
workspace. A request's headers, URL parameters and JWT workspace claims never choose an agent. This avoids changing the
Swarmm wire contract. The trade-off is that another manager can create an overlapping rule and deny admission; a
production design must resolve cross-workspace ambiguity, likely with an explicit workspace selector plus policy lookup.

**Verification is local after bounded public discovery.** The jose verifier permits ES256 and RS256, exact issuer,
valid signature, expiry, integral `iat` no later than now, nonempty `sub`, and `0 < exp - iat <= 600` seconds. It checks
all stored claim rules, including the runtime origin as `aud`. Issuers and JWKS must be public HTTPS hostnames with no
credentials; JWKS stays on the issuer's origin. Redirects are refused. Discovery/JWKS reads have a five-second abort and
64 KiB body cap; the isolate keeps at most 64 issuer resolvers, refreshing after five minutes and backing off failed
discovery for ten seconds. Policies and grants are never cached. The public-name check shares the existing endpoint
rule: trusted DNS remains an assumption, as in ADR 0011. Key rotation and issuer availability need live acceptance.

**Both machine entry points admit it.** A JWT Bearer reaches `/api/*` and `/mcp` through the same server principal.
User OAuth JWTs on `/mcp` retain their local Better Auth verifier. Invalid workload credentials return fixed 401 reasons
(`malformed-token`, `unknown-issuer`, `invalid-policy`, `discovery-failed`, `invalid-token`, `claims-mismatch`,
`ambiguous-policy`); they never fall back to a session or anonymous principal. Machine routes refuse Cookie or Origin.
Already admitted requests and submitted work may finish; expiry ends admission, not previously accepted work.

**Exchange is optional.** `POST /token` accepts form-encoded
`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=<JWT>`, with optional `scope=goblin` and
`resource=<runtime-origin>/mcp`. Other scopes/resources and duplicate parameters fail. A valid assertion with a bounded
`jti` yields a random opaque `gbw_` Bearer, ending at the earliest of five minutes, assertion expiry and grant expiry.
Only its SHA-256 hash and an issuer+jti digest are stored; a unique index claims a jti once, with expired rows pruned on
exchange. There is no refresh token. Direct JWT Bearers are reusable until expiry, as Swarmm requires; jti replay
protection applies only to exchange. Assertions and access tokens never enter logs or policy responses.

The server advertises `io.modelcontextprotocol/oauth-client-credentials` in MCP capabilities. SDK 2.3.1 has
`ClientCredentialsProvider` and `PrivateKeyJwtProvider`; their built-in requests use `client_credentials` plus client
authentication, rather than the platform JWT bearer grant. The test exchanges explicitly, saves its token in the
installed `PrivateKeyJwtProvider`, then uses the official Streamable HTTP transport. No dependency major upgrade or
new Better Auth OAuth provider is introduced. Automatic SDK discovery/refresh for this grant is a rollout task;
Better Auth's existing OAuth discovery remains for user clients.

**Persistent webhook authority is excluded.** Workload principals carry an internal marker and `events/subscribe`
refuses them with `workload_webhook`. Existing leases are keyed by the server grant and have no policy binding, so
accepting a workload subscription would leave access beyond policy disable or bearer expiry. Events listing and polling
remain available. Supporting workload webhooks requires policy-bound leases with expiry and delivery-time revocation.
The original static key's leases are independent; migrating a caller must end any leases it previously created.

## Swarmm and CI

Swarmm uses discovery at `<api-origin>/.well-known/openid-configuration`, same-origin
`/.well-known/jwks.json`, ES256 and a `kid`. Its JWT has exact HTTPS `iss`, `aud` equal to the goblin runtime origin,
`sub=swarmm:<stage>`, `iat`, `exp <= iat+300` and `jti`. It can send that JWT as `Authorization: Bearer` at every
place it previously sent the API key. Goblin contains no Swarmm-specific verifier branch.

A GitHub smoke migration would need a separately reviewed workflow change granting `id-token: write`, requesting the
runtime origin as audience, and a narrowly scoped policy for the exact repository, ref and subject (prefer immutable
repository/owner ids too). Pin workflow identity/environment rules where appropriate; keep separate policies for each
stage. Smoke code must use the server API/MCP operations its grant reaches: a workload assertion cannot replace a
browser session on owner-only account or resident-authority endpoints. Test with a throwaway workspace, establish real
issuer/key-rotation acceptance, retire the old smoke credential and roll back by disabling trust. This spike changes no
workflow and deploys nothing.

## Before production

Review discovery egress/DNS and issuer allowlists, concurrency and rate limits before cryptographic verification,
policy quotas and ambiguity, policy audit events, cleanup under idle token tables, and an independent grant identity
that does not require generating a static secret first. The UI supports exact GitHub branch and custom subject rules;
advanced GitHub environments, reusable workflows and arbitrary-claim editing need reviewed UX. Validate additive auth
migration against a populated stage backup and security-review replay/lifetime behavior. Local ephemeral issuer tests
cannot establish GitHub, Swarmm, network or production readiness. Results and exact commands live in
[SPIKE_RESULTS.md](../../SPIKE_RESULTS.md).
