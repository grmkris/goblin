# Worker

## Worker

`apps/web/src/worker.ts` sends pages to TanStack Start and the routes below to `apps/runtime/src/worker.ts`, whose
handlers are `http/worker.ts`.
Runtime paths below are relative to `apps/runtime/src/`; browser paths are relative to `apps/web/src/`.

| Path | What happens |
| --- | --- |
| `/health` | Stage, service name, sign-up mode, whether mail is configured, the billing mode, whether Pro can be paid from the Goblin Wallet, and what anyone may know: Pro's prices (`plans`: id, amount and period of each way to pay) and the Goblin Wallet's origin (`walletOrigin`, when set), which the landing shows. |
| `/.well-known/oauth-protected-resource*` | Protected-resource metadata for `/mcp`, the same document at every path. |
| `/.well-known/*`, `/api/auth/*` | Better Auth: sign-up and sign-in, the OAuth authorization server for inbound clients. |
| `/mcp` | goblin's own MCP server; a Bearer token from an inbound client reaches the agent of the user who consented, and `goblin:inspect` adds read-only inspection (ADR 0024). |
| `/api/billing/…`, `/api/clients…`, `/api/client-errors` | The account API, answered in the Worker without waking an agent (see The owner API). |
| `/api/*` | The owner API: admitted at the Worker's edge, then forwarded to the signed-in user's own agent (see The owner API). |
| `/hooks/mcp-events/<userId>/<connectionId>/<token>` | One connection's signed MCP Events; the route token, bound to the user and the connection, is checked before object lookup, then the agent's internal API takes it (`mcpEvents`). |
| anything else, `/internal/*` included | A 404 in the envelope: the internal API is reached only by the Worker, on the agent's stub. |
| `/hooks/dodo` | Signed payment webhooks (see Plans and payments). |
