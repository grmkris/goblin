# Operator scripts

Deployment scripts use Alchemy only. Secrets are read from mode-600 files under `.local/` and are never printed.

| Command                                  | What it does                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `bun dev`                                | Local stack on `http://localhost:18971` (workerd), model calls through CLIProxy. |
| `bun run plan:dev`                       | Preview changes to the retained dev stage.                                       |
| `bun run deploy:dev`                     | Deploy the dev stage (`https://dev.purrable.lol`).                               |
| `bun run destroy:dev -- --confirm-reset` | Erase the dev stage: every account, conversation and MCP credential.             |
| `bun run smoke:dev`                      | Acceptance against the deployed dev stage.                                       |
| `bun run smoke:local`                    | The same acceptance against the local stack.                                     |
| `bun run icons`                          | Redraw the app icons and favicon in `apps/web/public` from the one cat mark.     |

Stage configuration comes from `.local/<stage>.env` (see `.env.example`); `plan:dev`, `deploy:dev` and `destroy:dev`
also read shared Cloudflare credentials in `~/.config/myapps/dev.env`. Smoke loads only the stage file and needs no
Cloudflare API credentials.

## Smoke

The smoke needs `PURRABLE_OWNER_EMAIL` and `PURRABLE_OWNER_PASSWORD` for an account that already exists; it signs in
but never registers one. It uses the stage's `PURRABLE_APP_URL` over HTTPS, or
`http://localhost:18971`.

The smoke spends model tokens and writes conversation history: turns in main, a new side thread and a background
subagent. It leaves the owner's grants unchanged and renews resident authority through owner requests. With
`PURRABLE_SMOKE_MODEL` set, it temporarily selects that offered model (`PURRABLE_MODEL_ID` or `PURRABLE_MODELS`) and
attempts to restore the owner's effective pick in `finally`, including after a failed step. Unset, turns use the
owner's pick. Housekeeping still uses `PURRABLE_MEMORY_MODEL`.

1. health; unless sign-up is open, a sign-up without the invite code is refused; sign-in, resident authority
   `active`, a main-thread snapshot;
2. each configured or owner-added MCP server's status; for a connected server, its tools, and a direct call of a
   read-only probe (`account_read` on MyPlan, `browser_backends` on MyBrowser) only if the owner has already granted it;
3. an inbound MCP client: dynamic registration, owner consent, PKCE token, `/mcp` `initialize` and `tools/list`, an
   `ask_agent` model turn, an agent turn that calls the MyPlan probe through `mcp_call` (only if step 2 proved it),
   `get_recent_messages` with the smoke client's author label, then revocation and a 401;
4. a new empty thread, a model turn there, `share_to_main` verified as a new `app.shared` entry in main, then archive;
5. a `smokecount` subagent spawned from main, its authored report back, and main's reply to the report;
6. `/api/agent/memory`: a nonzero remembered-message count and the current view coverage.

Inbound turns run in main as `purrable-smoke`. The thread is archived and the client revoked through `finally` cleanup;
their history and the subagent remain. If Telegram is on, main's answer to the subagent report is also queued for
delivery there. Cleanup requests can themselves fail.

On success the script writes `.local/smoke-<stage>-receipt.json` (mode 600) and prints it. A failure prints its reason
and completed HTTP steps but writes no new receipt; an older file may remain. Receipts contain model/server names,
statuses, counts and booleans, never tokens, cookies or message bodies.

| Receipt field                          | What it checks or records                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `stage`, `signup`, `resident`, `model` | Target stage, sign-up mode, active authority and smoke model or `owner pick`.                                  |
| `servers`                              | Server statuses, tool/grant counts and probe outcome (`ok`, `error` or `not-granted`).                         |
| `inbound`                              | Initialization, model turn, optional resident tool call, recent history and revocation followed by 401.        |
| `inbound.author`                       | `ok`: the smoke user's message has author `purrable-smoke`.                                                    |
| `thread`, `shared`                     | `ok` and `true`: the empty thread ran and wrote a new `app.shared` entry to main.                              |
| `subagent`                             | `reported`: the report reached main and main answered it.                                                      |
| `memory.messages`                      | Messages logged since memory activation; must be greater than zero.                                            |
| `memory.summarized`                    | Messages covered before the newest input by the last placed memory view; recorded without a minimum assertion. |
| `utc`, `status`, `steps`               | Completion timestamp, `passed` and HTTP step/status pairs.                                                     |

Not covered here: the owner's Connect flow (it needs the owner at the remote server's consent screen), rendering
MCP Apps, the browser UI, thread branching, memory-summary quality, skills, and Telegram hook/inbox acceptance.

Prod commands use `.local/prod.env` and require `PURRABLE_CONFIRM_PROD=1` in the calling shell:
`bun run plan:prod`, `bun run deploy:prod`, `bun run smoke:prod`. There is no destroy-prod command.
`smoke:prod` defaults to GET `/health` and GET `/api/threads` without authentication (expected 401).
Only supplying both credentials for an operator test account enables the full acceptance flow, including model turns.
Never put the production owner's credentials in the smoke configuration.

`PURRABLE_DOMAIN` attaches the stage's custom domain through Alchemy: `dev.purrable.lol` on dev, `purrable.lol` on
prod, plus `www.purrable.lol` on prod. The Worker redirects alternate hosts to `PURRABLE_APP_URL`, preserving the path
and query (301 for GET/HEAD, 308 for writes). Dev sign-up must be closed or invite-only.
