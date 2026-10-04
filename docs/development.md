# Development

Requirements are Bun `1.4.2` and Node.js 22.

## Local

```sh
bun install --frozen-lockfile
mkdir -p .local && cp .env.example .local/local.env && chmod 600 .local/local.env
bun dev                 # Alchemy runs the Worker in local workerd on http://localhost:18971
```

Model calls go through CLIProxy and inherit `CLIPROXY_API_KEY` from the interactive shell. The local stage supplies
its own auth secret and credential key and opens sign-up; set them in `.local/local.env` only to override.

Open the app and use **Create an account**. Each account gets its own agent. For `bun run smoke:local`, put that
account's email and password in `PURRABLE_OWNER_EMAIL` and `PURRABLE_OWNER_PASSWORD`.

## Gates

```sh
heavy bun run check:fast    # format, agent/docs checks, lint, typecheck, unit tests
heavy bun run check         # everything, including graph, Knip, duplication, workerd integration tests and the build
```

Run expensive commands through `heavy`. Exit 75 means another heavy job is running: retry, do not treat it as a
failure. Never pipe `heavy`. Focused commands: `bun run test:unit`, `bun run test:integration`, `bun run typecheck`,
`bun run effect:check`, `bun run lint:gate`, `bun run check:files <paths>`.

If a check fails, look at `git status` first. Another agent's half-finished file failing is not your change failing.

## The dev stage

Dev (`https://purrable-dev.<account>.workers.dev`) is the daily instance. Its configuration is `.local/dev.env`
(mode 600) plus the shared Cloudflare credentials in `~/.config/myapps/dev.env`:

| Variable | Meaning |
| --- | --- |
| `PURRABLE_STAGE`, `PURRABLE_APP_URL` | `dev` and the Worker's HTTPS origin. |
| `PURRABLE_SIGNUP_MODE`, `PURRABLE_SIGNUP_INVITE_CODE` | `open`, `invite` or `closed` (default), and the invite code. |
| `PURRABLE_MAIL_SENDER` | Sender on an Email Sending apex (dev: `purrable@mytab.lol`); turns on email verification. |
| `PURRABLE_OWNER_EMAIL`, `PURRABLE_OWNER_PASSWORD` | An existing account; only the smoke reads them. |
| `PURRABLE_BETTER_AUTH_SECRET` | Better Auth's secret. |
| `PURRABLE_MODEL_BASE_URL`, `PURRABLE_MODEL_ID`, `PURRABLE_MODEL_KEY` | Railway LiteLLM and the dedicated capped key. Never the master key. |
| `PURRABLE_MODEL_DAILY_TOKENS` | Model tokens each user's agent may spend per UTC day (default 300000). |
| `PURRABLE_MCP_SERVERS` | JSON list of outbound servers: `[{"serverId":"myplan","endpoint":"https://…/mcp"}]`. |
| `PURRABLE_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP tokens. |

```sh
bun run plan:dev                          # preview
bun run deploy:dev                        # deploy
bun run destroy:dev -- --confirm-reset    # erase every account, conversation and MCP credential
bun run smoke:dev                         # acceptance; see scripts/README.md
```

Changing `PURRABLE_CREDENTIAL_KEY` makes every stored MCP credential unreadable; reconnect the servers afterwards.

## Using it

- **Connect a server.** Connections → Connect. You sign in at the remote server and approve; you come back
  connected. Then tick the tools the agent may use. Nothing is granted by default. A server marked *needs auth* had
  its token refresh refused: press Reconnect.
- **Resident authority.** Settings shows when it expires. Any use of the app renews it for 30 days. Revoke stops all
  outbound MCP use by the agent until you enable it again.
- **Add Purrable to Claude Code.**

  ```sh
  claude mcp add --transport http purrable https://purrable-dev.<account>.workers.dev/mcp
  ```

  Claude Code opens the browser; sign in and approve. It gets `ask_agent` and `get_recent_messages`, in its own
  conversation. Revoke it under Settings → Connected MCP clients.

## Changing things

- Application tables: edit `apps/runtime/src/storage/schema.ts` and append a migration to
  `storage/migrations.ts` (`'<14-digit timestamp>_name'`, statements joined by `--> statement-breakpoint`). Never
  edit an applied migration; never touch Pi or Agents tables.
- Auth tables: Better Auth's schema lives in `apps/runtime/migrations` and is applied by the Alchemy D1 resource.
- Bindings: declare them in `apps/runtime/src/env.ts` and `apps/web/alchemy.run.ts` together.
- UI components: from `packages/ui`, `bunx shadcn@latest add <component>`, then review the generated file. Do not
  hand-edit `apps/web/src/routeTree.gen.ts`.
- Dependencies: `bun add <package> --cwd <workspace>`; commit `package.json` and `bun.lock` together.

Unit tests, local workerd and the deployed dev stage are separate kinds of evidence. Say which one you ran.
