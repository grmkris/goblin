# Worker

## Worker

`apps/web/src/worker.ts` sends pages to TanStack Start and the routes below to `apps/runtime/src/worker.ts`, whose
handlers are `http/worker.ts`.
Runtime paths below are relative to `apps/runtime/src/`; browser paths are relative to `apps/web/src/`.

| Path | What happens |
| --- | --- |
| `/health` | What the deployment is and offers, from its settings alone (`http/health.ts`, the `Health` contract): `ok`, `service`, the `stage` label, the `signup` mode, the `signIn` methods (`{ method: 'email' }` with mail, `{ method: 'oidc', label }` with a provider) and the optional `features` it has (`largeFiles`, `agentApps`, `flows`; ADR 0064). |
| `/.well-known/oauth-protected-resource*` | Protected-resource metadata for `/mcp`, the same document at every path. |
| `/.well-known/*`, `/api/auth/*` | Better Auth: sign-up and sign-in (emailed codes, and the deployment's OpenID Connect provider at `/api/auth/sign-in/social` and `/api/auth/callback/oidc`), the OAuth authorization server for inbound clients. |
| `/mcp` | goblin's own MCP server, one for every caller (ADR 0086): an OAuth client's Bearer token reaches the agents of the workspaces its grant names, while its person is a member of each, every call naming one (ADRs 0097, 0114); an installed app's those of its installations (ADR 0118); each with one tool per owner endpoint its grant's level and extras hold. Any other bearer gets the sign-in challenge (ADR 0120). |
| `/api/workspaces…`, `/api/client-errors` | The account API, a person's: their workspaces, and crash reports, answered in the Worker without waking an agent (see The owner API). |
| `/w/<slug>/api/*` | A member's requests (ADR 0089): admitted at the Worker's edge by the session and a live membership of that slug's workspace, then the workspace account API (`/api/members…`, `/api/developer…`, `/api/installations…`, `/api/clients…`) is answered in the Worker and every other path forwarded to the workspace's agent as `/api/*` (see The owner API). |
| `/api/mcp/oauth/callback` | An outbound sign-in coming back, one address for every workspace: its `state` names the workspace, whose agent gets it once the person's session and live membership of it admit (`mcp/oauth/sign-in.ts`, ADR 0089); the agent's redirect goes to that workspace's pages. A person who is not a member goes to `/connect-elsewhere` instead, and the code to no agent (ADR 0096). |
| `/hooks/mcp-events/<workspaceId>/<connectionId>/<token>` | One connection's signed MCP Events; the route token, bound to the agent and the connection, is checked before object lookup, then the agent's internal API takes it (`mcpEvents`). |
| `/files/link/<token>/<name>` | One workspace file handed to a server (`file_link`, ADR 0070): GET only; the token (agent, path, expiry within fifteen minutes, HMAC under a purpose-derived key) is checked in constant time before object lookup, then the agent it names serves that file through its internal API (`linkedFile`) as an attachment, never cached; anything else is a 404. |
| anything else, `/internal/*` included | A 404 in the envelope: the internal API is reached only by the Worker, on the agent's stub. |
