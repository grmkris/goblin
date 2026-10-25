# ADR 0122: Inbound OAuth follows the MCP authorization spec: metadata documents, bearer tokens, no private-use redirects

Status: Accepted 2026-10-25 (owner: standards first, "no backwards-compatibility shims, no half-implemented features";
the spec wins where it and convenience disagree). Amends ADR 0024 (the challenge and the resource metadata), ADR 0086
(how a client registers) and ADR 0114 (nothing about what a grant is; the sign-in that leads to one).

## Context

An audit of every inbound MCP authorization server the owner runs against MCP 2026-07-28, Basic › Authorization,
found goblin solid on discovery, PKCE, resource binding, audience checks, rotation and per-call revocation, and short
of the spec in six places:

- the authorization server advertised DPoP algorithms and bound a token to any proof a client sent, while `/mcp`
  refused every token with a confirmation claim: a DPoP-capable client signed in and then failed forever (I1);
- a `cursor://` redirect was accepted: the spec says every redirect URI is `localhost` or https (security
  considerations, "Redirect URI validation");
- clients registered only dynamically (RFC 7591), which the spec keeps for backwards compatibility and asks servers to
  replace with Client ID Metadata Documents (SHOULD), and a public registration that declared a grant goblin does not
  hand out (`client_credentials`, `device_code`) was refused rather than narrowed (I4, I2);
- the 401 and the resource metadata named the sign-in scopes and `offline_access`, which the spec says a resource
  SHOULD NOT, and a refused bearer got the same 401 as no bearer, without `error="invalid_token"` (S3, S4);
- the consent page did not show where the authorization sends the person back, which the spec requires once clients
  are metadata documents (M5);
- revoking an unknown or already revoked token answered 400, where RFC 7009 says 200 (I5), a Better Auth bug.

## Decision

**A client is its metadata document.** `cimd()` (`@better-auth/cimd`, pinned with the rest of Better Auth) resolves a
`client_id` that is an https URL by fetching, validating (MCP profile) and keeping that document as an `oauthClient`
row, refetched an hour after at most. The fetch is the Worker's own `fetch`, held to public addresses by the
`global_fetch_strictly_public` compatibility flag on dev and prod (local keeps its model endpoint on loopback and stays
off it); the plugin itself refuses non-https ids, special-use hosts and redirects. Discovery says so
(`client_id_metadata_document_supported: true`). Dynamic registration stays open **until** the clients that matter
(Claude, Claude Code, ChatGPT, Codex, VS Code, Cursor) are seen connecting by document on dev; it is then removed in a
follow-up ADR. Until then a registration that says no `application_type` is native when a redirect is http on loopback
(`clientRegistrationDefaultApplicationType: 'infer'`), and its grant types are narrowed to `authorization_code` and
`refresh_token`, the two a dynamically registered client may hold (RFC 7591 §3.2.1: the server may replace what was
asked and returns what it registered). `client_credentials` remains goblin's own apps' (ADR 0118), registered
server-side.

**A redirect URI is `localhost` or https**, at registration and at authorization (`auth/protocol.ts`): `cursor://` and
every other private-use scheme are refused with `invalid_redirect_uri` / `invalid_request`, never redirected to. A
metadata document listing one gets no further than a registration would. For http on the loopback names and literals
the port is free (OAuth 2.1 §8.4.2, RFC 8252 §7.3), which Better Auth 1.7.11 does; everything else matches exactly.
The consent page shows the authorization's redirect host, with a note when it is this computer.

**Tokens are plain bearer, audience-bound (RFC 8707), and DPoP is stripped**: no `dpop_signing_alg_values_supported`
in either discovery document, no `DPoP` proof read at the token endpoint (RFC 9449 §5: an authorization server
without DPoP ignores it and issues a bearer token), no `dpop_jkt` carried through an authorization, no registration
asking for bound tokens. `/mcp` keeps refusing a token with a confirmation claim: none is ours. DPoP comes back only as
a complete implementation, proof checks at the resource server included, once the MCP DPoP extension is stable.

**Every authorization asks `offline_access`.** The before hook appends it to the request's scope when missing, so an
MCP client gets a refresh token without asking for the scope; whether one is issued stays the client's registered
grant types (`refresh_token`), which Better Auth checks. With that rule in place the resource names only itself:
the 401 says `scope="goblin"` and `/.well-known/oauth-protected-resource` lists `goblin` alone (`RESOURCE_SCOPES`),
while the authorization server keeps offering the sign-in scopes and `offline_access` (`MCP_SCOPES`).

**A refused bearer says so.** `/mcp` answers a token it refuses (garbage, expired, another audience, a revoked client
or consent, an ended grant) with 401 `error="invalid_token"` beside the metadata and scope, which is what tells a
client to sign in again; no bearer at all gets the challenge without it. Revocation stays per call (ADR 0114).

**Access tokens live fifteen minutes** (`accessTokenExpiresIn: 900`); an app's `client_credentials` token keeps Better
Auth's hour (`m2mAccessTokenExpiresIn`, ADR 0118). Revoking never waits for either.

**Better Auth's revocation bug is patched, not worked around.** `patches/@better-auth%2Foauth-provider@1.7.11.patch`
changes the one comparison (`error.name` → `error.status`), with the source diff and the marker `check:patches` looks
for under `patches/better-auth-oauth-provider/`, and the upstream report is
[better-auth/better-auth#12028](https://github.com/better-auth/better-auth/issues/12028). It goes when a release
carries the fix.

**HTTPS is the zone's.** The owner enforces it at the Cloudflare edge (Always Use HTTPS, HSTS); the Worker adds no
guard of its own beyond the canonical-host redirect it already had.

## Consequences

- Cursor cannot connect with its `cursor://` redirect, on goblin as on every other server of the owner's; it connects
  once it offers a loopback or https redirect. This is the spec's rule and a deliberate end to goblin's acceptance.
- A client that registered without `refresh_token` still gets no refresh token: asking `offline_access` for it changes
  nothing there.
- A metadata document that requires DPoP (`dpop_bound_access_tokens: true`) cannot get a token here: the token endpoint
  asks for the proof the Worker takes away. That is the honest answer until DPoP is implemented in full.
- `ClientId` in the contracts admits an https URL beside Better Auth's own ids, and the consent page and the clients
  API carry it percent-encoded on their paths.
- What is proven on the wire: `apps/runtime/test/integration/protocol-case.ts` (discovery, registration shapes,
  loopback ports, `offline_access`, DPoP stripped, `invalid_token`, RFC 7009) and its metadata document client; the
  rules themselves in `apps/runtime/test/mcp/auth.test.ts`.
