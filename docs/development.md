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
| `PURRABLE_MODELS` | More LiteLLM model names users may pick, comma-separated; `PURRABLE_MODEL_ID` stays the default. Allow each on the LiteLLM key too. |
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
Changing a server's `endpoint` drops what was stored for it (credentials, grants, pending sign-ins) at each
agent's next start; connect it again. Tokens are never carried from one host to another.

## Using it

- **Add a server.** Connections → Suggested adds and connects one of ours in one tap. Add a server takes any MCP
  address (public https only). Servers without sign-in (DeepWiki, Context7, Cloudflare Docs) connect at once.
  Remove takes its sign-in and grants with it. To suggest another server, check that it connects from a Worker,
  then add it to `apps/runtime/src/mcp/suggested.ts` with its endpoint for each stage.
- **Connect a server.** Connections → Connect. You sign in at the remote server and approve; you come back
  connected. Then tick the tools the agent may use. Nothing is granted by default. A server marked *needs auth* had
  its token refresh refused: press Reconnect.
- **Resident authority.** Settings shows when it expires. Any use of the app renews it for 30 days. Revoke stops all
  outbound MCP use by the agent until you enable it again.
- **MyPlan as an App (the showcase).** Dev points `myplan` at `https://dev-new.myplan.lol/mcp`, the myapps
  rewrite (the local stack does too). Connect it, then switch on **Allow app** under its `ui://myplan/panel.html`
  group. Ask the agent to open a note ("Open my Trip plan note"), then press *Show app* on the `myplan · myplan_open`
  row. The panel edits the note live. Move it to the side panel or picture-in-picture from its chrome and back: it
  never reloads. Canvases show as previews; the panel offers a link that opens them in MyPlan. What the panel shares
  (the note in view) rides along with your next message as untrusted context.
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
- UI components: Purrable looks like the myapps apps. Prefer porting a component from `~/code/myapps/packages/ui`
  (with an "Adapted from" header naming the commit); otherwise `bunx shadcn@latest add <component>` from
  `packages/ui`, then review the generated file. Keep the shared tokens in `packages/ui/src/styles.css` as myapps has
  them. Do not hand-edit `apps/web/src/routeTree.gen.ts`.
- Dependencies: `bun add <package> --cwd <workspace>`; commit `package.json` and `bun.lock` together.

Unit tests, local workerd and the deployed dev stage are separate kinds of evidence. Say which one you ran.
