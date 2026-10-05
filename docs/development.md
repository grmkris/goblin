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
| `PURRABLE_MAIL_SENDER` | A sender on an Email Sending apex; turns on email verification. |
| `PURRABLE_OWNER_EMAIL`, `PURRABLE_OWNER_PASSWORD` | An existing account; only the smoke reads them. |
| `PURRABLE_BETTER_AUTH_SECRET` | Better Auth's secret. |
| `PURRABLE_MODEL_BASE_URL`, `PURRABLE_MODEL_ID`, `PURRABLE_MODEL_KEY` | Railway LiteLLM and the dedicated capped key. Never the master key. |
| `PURRABLE_MODELS` | More LiteLLM model names users may pick, comma-separated; `PURRABLE_MODEL_ID` stays the default. Allow each on the LiteLLM key too. |
| `PURRABLE_MODEL_DAILY_TOKENS` | Model tokens each user's agent may spend per UTC day (default 300000). |
| `PURRABLE_MEMORY_MODEL` | The offered model for thread names, main-memory summaries and skill-draft decisions. It is not selected by price; unset or not offered uses the default. |
| `PURRABLE_SMOKE_MODEL` | Optional model for smoke turns. It must be one of the offered models; unset keeps the owner's pick. |
| `PURRABLE_MCP_SERVERS` | JSON list of outbound servers: `[{"serverId":"myplan","endpoint":"https://…/mcp"}]`. |
| `PURRABLE_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP credentials and the Telegram doorbell secret, and derives the hook token. |

These are source defaults and configuration names; active dev settings and provider caps must be verified separately.

```sh
bun run plan:dev                          # preview
bun run deploy:dev                        # deploy
bun run destroy:dev -- --confirm-reset    # erase every account, conversation and MCP credential
bun run smoke:dev                         # acceptance; see scripts/README.md
```

Changing `PURRABLE_CREDENTIAL_KEY` makes stored MCP credentials and the Telegram secret unreadable and changes the hook
token; reconnect the servers and re-enable Telegram afterwards.
Changing a server's `endpoint` drops what was stored for it (credentials, grants, pending sign-ins) at each
agent's next start; connect it again. Tokens are never carried from one host to another.

## Using it

- **Add a server.** Connections → Suggested adds and connects one of ours in one tap. Find a server searches the MCP
  registries; add your own under Registries searched. Add a server takes any MCP address (public https only). Servers
  without sign-in connect directly; the suggestions mark DeepWiki, Context7 and Cloudflare Docs this way.
  Remove takes its sign-in and grants with it. To suggest another server, check that it connects from a Worker,
  then add it to `apps/runtime/src/mcp/suggested.ts` with its endpoint for each stage.
- **Connect a server.** Connections → Connect. You sign in at the remote server and approve; you come back
  connected. Servers that answer without sign-in connect directly. Then tick the tools the agent may use. Nothing is
  granted by default. A server marked *needs auth* needs a new sign-in: press Reconnect.
- **Conversations.** Main is `/`. The **+** beside Threads in the sidebar opens a new thread's draft beside main, or
  use **Reply in thread** under one of your settled messages or the agent's in main. Either opens beside main (a
  sheet on a phone), and sending starts the thread (empty, or from that message), so an unsent draft leaves nothing
  behind. Main then shows the thread
  under that message with its reply count, and a second Reply there opens the same thread. The sidebar
  lists every thread, and the panel's full-view button opens one at `/t/:id`. **Share to main** asks the thread to
  write a note; it starts no answer in main. Rename and Archive are in the thread menu; archiving hides it and keeps
  its history. Subagents appear under the conversation that started them. The sliders button by the composer shows
  what the agent can use in that conversation (connections and their tools, skills, subagents); switching something
  off there hides it from the agent in that conversation only, and a new thread starts with main's switches. Settings shows main's remembered-message count; see the architecture for memory and `zoom`.
- **Questions, models and budget.** Answer an `ask_user` card with your next message. Pick an offered model in the
  composer; Settings and the composer's ring show today's token usage, resetting at 00:00 UTC.
- **Skills.** Connect a server that offers skills, then turn on **Use skills from this server**. The agent reads and
  follows those procedures; their tools still need grants. To receive drafts in a library such as MySkills, grant
  `skill_draft` and `skill_draft_status`, then review the proposals there.
- **Telegram.** Bind the authorized myagent client to the agent's bot in myagent. Under that connection, choose
  **Use for Telegram**: it grants the four channel tools, skips old inbox entries and subscribes the doorbell. New
  messages arrive in main as **Telegram** and answers go back to the bot. Only one connection carries Telegram;
  **Stop** disables it and leaves its tool grants in place.
- **Resident authority.** Settings shows when it expires. Owner activity renews it for 30 days; inbound and scheduled
  work do not renew it. Revoke stops all outbound MCP use by the agent until you enable it again.
- **MyPlan as an App.** The suggested MyPlan server uses `https://dev-new.myplan.lol/mcp` on local and dev
  (`apps/runtime/src/mcp/suggested.ts`); `PURRABLE_MCP_SERVERS` may configure another endpoint. Connect it, then switch
  on **Allow app** under its discovered `ui://` resource group. Ask the agent to open a note ("Open my Trip plan
  note"), then press *Show app* on the resulting tool row. Move it to the side panel or picture-in-picture from its
  chrome and back: it keeps the same iframe. What the panel shares rides along with your next message as untrusted
  context; links it offers wait for your click. The originating server supplies the resource URI and the panel's
  behavior.
- **Add Purrable to Claude Code.**

  ```sh
  claude mcp add --transport http purrable https://purrable-dev.<account>.workers.dev/mcp
  ```

  Sign in and approve in the browser. It gets `ask_agent` and `get_recent_messages` in the agent's main conversation,
  with its messages labelled by client name. Revoke it under Settings → Connected MCP clients.

## Changing things

- Application tables: edit `apps/runtime/src/storage/schema.ts` and append a migration to
  `apps/runtime/src/storage/migrations.ts` (`'<14-digit timestamp>_name'`, statements joined by `--> statement-breakpoint`).
  Never edit an applied migration; never touch Pi or Agents tables.
- Auth tables: Better Auth's schema lives in `apps/runtime/migrations` and is applied by the Alchemy D1 resource.
- Bindings: declare them in `apps/runtime/src/env.ts` and `apps/web/alchemy.run.ts` together.
- UI components: Purrable looks like the myapps apps. Prefer porting a component from `~/code/myapps/packages/ui`
  (with an "Adapted from" header naming the commit); otherwise `bunx shadcn@latest add <component>` from
  `packages/ui`, then review the generated file. Keep the shared tokens in `packages/ui/src/styles.css` as myapps has
  them (the sidebar tokens are Purrable's: a shade heavier than the page). The Home Screen icons, favicon and web app
  manifest are static files in `apps/web/public`; after changing the mark or the page background, run `bun run icons`
  and keep the manifest's colours and the root route's `theme-color` metas equal to `--background`. Do not hand-edit `apps/web/src/routeTree.gen.ts`.
- Dependencies: `bun add <package> --cwd <workspace>`; commit `package.json` and `bun.lock` together.

Unit tests, local workerd and the deployed dev stage are separate kinds of evidence. Say which one you ran.
