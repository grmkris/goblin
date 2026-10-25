# Better Auth OAuth provider: RFC 7009 revocation

`@better-auth/oauth-provider` 1.7.11 answers `POST /oauth2/revoke` with 400 `invalid_request` for a token it does not
know or has already revoked. RFC 7009 §2.2 requires 200: the client's aim, that the token is not usable, is met either
way, and clients that revoke on disconnect surface an error otherwise (MCP OAuth audit gap I5). The cause is one
comparison in the endpoint's last catch: `error.name === "BAD_REQUEST"` never holds, because better-call's `APIError`
is named `APIError` and keeps the status in `error.status`.

Upstream: [better-auth/better-auth#12028](https://github.com/better-auth/better-auth/issues/12028), with the same
one-line fix. This patch stays until a release carries it; then drop the `patchedDependencies` entry, the `PatchSpec`
in `tools/patches.ts` and this directory together.

The change is recorded in `revoke.diff` against the package's source (`src/revoke.ts`; the built file is
`dist/authorize-*.mjs`). The package's entry (`dist/index.mjs`) starts with the diff's SHA-256 marker, which
`bun run check:patches` looks for. A JWT access token still answers `unsupported_token_type`, as before: the endpoint
revokes refresh tokens and opaque access tokens only, and must not claim it invalidated a self-contained token.
