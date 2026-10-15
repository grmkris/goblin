# Worker

## Worker

`apps/web/src/worker.ts` sends pages to TanStack Start and the routes below to `apps/runtime/src/worker.ts`, whose
handlers are `http/worker.ts`.
Runtime paths below are relative to `apps/runtime/src/`; browser paths are relative to `apps/web/src/`.

| Path | What happens |
| --- | --- |
| `/health` | What the deployment is and offers, from its settings alone (`http/health.ts`, the `Health` contract): `ok`, `service`, the `stage` label, the `signup` mode, the `signIn` methods (`{ method: 'email' }` with mail, `{ method: 'oidc', label }` with a provider) and the optional `features` it has (`largeFiles`, `agentApps`, `flows`, `decisions`; ADR 0064). |
| `/.well-known/oauth-protected-resource*` | Protected-resource metadata for `/mcp`, the same document at every path. |
| `/.well-known/*`, `/api/auth/*` | Better Auth: sign-up and sign-in (emailed codes, and the deployment's OpenID Connect provider at `/api/auth/sign-in/social` and `/api/auth/callback/oidc`), the OAuth authorization server for inbound clients. |
| `/mcp` | goblin's own MCP server; a Bearer token from an inbound client reaches the agent of the user who consented, and `goblin:inspect` adds read-only inspection (ADR 0024). |
| `/api/clients…`, `/api/client-errors` | The account API, answered in the Worker without waking an agent (see The owner API). |
| `/api/*` | The owner API: admitted at the Worker's edge, then forwarded to the signed-in user's own agent (see The owner API). |
| `/hooks/mcp-events/<userId>/<connectionId>/<token>` | One connection's signed MCP Events; the route token, bound to the user and the connection, is checked before object lookup, then the agent's internal API takes it (`mcpEvents`). |
| anything else, `/internal/*` included | A 404 in the envelope: the internal API is reached only by the Worker, on the agent's stub. |
