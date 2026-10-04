# Operator scripts

Deployment scripts use Alchemy only. Secrets are read from mode-600 files under `.local/` and are never printed.

| Command                                  | What it does                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `bun dev`                                | Local stack on `http://localhost:18971` (workerd), model calls through CLIProxy. |
| `bun run plan:dev`                       | Preview changes to the retained dev stage.                                       |
| `bun run deploy:dev`                     | Deploy the dev stage (`https://purrable-dev.<account>.workers.dev`).             |
| `bun run destroy:dev -- --confirm-reset` | Erase the dev stage: every account, conversation and MCP credential.             |
| `bun run smoke:dev`                      | Acceptance against the deployed dev stage.                                       |
| `bun run smoke:local`                    | The same acceptance against the local stack.                                     |

Stage configuration comes from `.local/<stage>.env` (see `.env.example`); `deploy:dev` also reads the shared
Cloudflare credentials in `~/.config/myapps/dev.env`.

## Smoke

The smoke needs `PURRABLE_OWNER_EMAIL` and `PURRABLE_OWNER_PASSWORD` for an account that already exists; it signs in
but never registers one. It refuses any target other than the retained `purrable-dev.*.workers.dev` Worker or
`http://localhost:18971`.

It reads and changes nothing the owner set:

1. health; unless sign-up is open, a sign-up without the invite code is refused; sign-in, resident authority
   `active`, a main-thread snapshot;
2. each configured MCP server's status; for a connected server, its tools, and a direct call of a read-only probe
   (`account_read` on MyPlan, `browser_backends` on MyBrowser) only if the owner has already granted it;
3. an inbound MCP client: dynamic registration, owner consent, PKCE token, `/mcp` `initialize` and `tools/list`, an
   `ask_agent` model turn, an agent turn that calls the MyPlan probe through `mcp_call` (only if step 2 proved it),
   `get_recent_messages`, then revocation and a 401.

Agent turns run in the throwaway client's own conversation, never the main thread, and the client is revoked even
when a step fails. The receipt (`.local/smoke-<stage>-receipt.json`, mode 600) holds statuses, counts and booleans
only: no tokens, cookies or message bodies.

Not covered here: the owner's Connect flow (it needs the owner at the remote server's consent screen), rendering
MCP Apps, and the browser UI.
