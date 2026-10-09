# Operator scripts

Deployment scripts use Alchemy only. Secrets are read from mode-600 files under `.local/` and are never printed.

| Command                                          | What it does                                                                               |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `bun dev`                                        | Local stack on `http://localhost:18971` (workerd), model calls through CLIProxy.           |
| `bun run plan:dev`                               | Preview changes to the dev stage.                                                          |
| `bun run deploy:dev`                             | Deploy the dev stage (`https://dev.goblin.surf`).                                          |
| `bun run destroy:dev -- --confirm-reset`         | Erase the dev stage: every account, conversation and MCP credential.                       |
| `bun run smoke:dev`                              | Acceptance against the deployed dev stage.                                                 |
| `bun run smoke:local`                            | The same acceptance against the local stack.                                               |
| `bun run ui:acceptance [session-file]`           | Read-only UI checks and screenshots against dev (see UI acceptance below).                 |
| `bun run icons`                                  | Redraw the app icons and favicon in `apps/web/public` from the shared goblin mark.         |
| `heavy bun scripts/patch-shadcn-react.ts --test` | Rebuild the MessageScroller patch from upstream source (`patches/shadcn-react/README.md`). |

Stage configuration comes from `.local/<stage>.env` (see `.env.example`); `plan:dev`, `deploy:dev` and `destroy:dev`
also read shared Cloudflare credentials in `~/.config/myapps/dev.env`. Smoke loads only the stage file and needs no
Cloudflare API credentials.

## UI acceptance

`bun run ui:acceptance` opens the stage named by the smoke session file (`.local/dev-session.json` unless another
is given; a `http://localhost` session runs it against the local stack) in headless Chromium, as a phone (390×844,
touch), landscape phone (844×390), tablet (820×1180), hybrid pointer device and desktop (1440×900), light and dark,
on `/c/1`, a thread's panel, Threads, Activity, Tasks, Settings, Connections and Apps. It only taps and clicks what
changes nothing: menus, a Thoughts disclosure, the navigation drawer, a thread's panel. It sends no message and edits
nothing. It checks behaviour the eye cannot confirm from a screenshot: the theme's curves, menus that scale, Return-key
hints, 16px text fields and 44px icon targets on touch, panels that open to their content's height, the thread panel
beside the channel (a full view on a phone), no page wider than its screen, and phone drawers that close: the
navigation on a link to the page already showing and on a swipe left, the turn map on a swipe down. Screenshots and a receipt go to the private
`.local/goblin-acceptance/ui-<utc>/`; it exits non-zero on a failed check or a page error. Run it after each dev
deploy that touches the web app. Chromium emulation is not device evidence: feel, the keyboard and gestures still
need a real phone.

Data-dependent controls that are absent are recorded as skipped, separately from passing checks. Thoughts closure
is measured on the opened panel itself. All visible text fields are checked for at least 16px type (a checkbox, radio
or range has no text to size); the code input uses 18px. The hybrid context verifies touch behavior with a fine primary pointer.

`heavy bun apps/web/test/ui-local.ts` runs the source components in a local Vite fixture without an account or model
call. It covers editable primitives, composer Return behavior, full Home note reading with focus return, synthetic
keyboard/pinch-zoom handling, failed attachment retry/remove/send blocking, and Home feedback under reduced motion.
Its private receipts and screenshots go under `.local/goblin-acceptance/local-*`.

## Smoke

The smoke needs `GOBLIN_OWNER_EMAIL` and `GOBLIN_SMOKE_SESSION_FILE`. Capture a session through a real OTP login,
then save `{"origin":"https://dev.goblin.surf","cookie":"<session cookie>"}` in a mode-600 private JSON file.
Smoke checks that origin, validates the live session and verifies its owner email before agent requests. It never
requests a login code or creates an account. Local uses `http://localhost:18971` and Alchemy's captured `.eml` code.

The smoke spends model tokens and writes conversation history: turns in main, a new side thread and a background
subagent. It leaves the owner's grants unchanged and renews resident authority through owner requests. With
`GOBLIN_SMOKE_MODEL` set, it temporarily selects that offered model (`GOBLIN_MODEL_ID` or `GOBLIN_MODELS`) and
attempts to restore the owner's effective pick in `finally`, including after a failed step. Unset, turns use the
owner's pick. Housekeeping still uses `GOBLIN_MEMORY_MODEL`.

1. health; unless sign-up is open, a sign-up without the invite code is refused; sign-in, resident authority
   `active`, a main-thread snapshot;
2. a small text file uploaded to the owner's `/uploads`, listed, read back byte for byte and deleted (ADR 0022);
3. each configured or owner-added MCP server's status; for a connected server, its tools, and a direct call of a
   read-only probe (`account_read` on MyPlan, `browser_backends` on MyBrowser) only if the owner has already granted it;
4. an inbound MCP client: dynamic registration, owner consent including `goblin:inspect`, PKCE token, `/mcp`
   `initialize` and `tools/list` with the five inspection tools, an `inspect_problems` read, an `ask_agent` model turn, an agent turn that calls the MyPlan probe through `mcp_call` (only if step 2 proved it),
   `get_recent_messages` with the smoke client's author label, then revocation and a 401;
5. a new empty thread, a model turn there, `share_back` verified as a new `app.shared` entry in main, then close;
6. a `smokecount` subagent spawned from main and its attributed result posted back in main (a passive Delegate result, ADR 0033; with `synthesize` the report is an input main answers instead);
7. `/api/agent/memory`: a nonzero remembered-message count and the current view coverage;
8. an agent app (`scripts/smoke-apps.ts`): in a new thread the agent builds `smoke-counter` from exact code, the owner
   runs its schedule now and its revision moves by one, then the owner deletes it (typing its name) and the thread
   closes.

Inbound turns run in main as `goblin-smoke`. The threads are archived, the app deleted and the client revoked through
`finally` cleanup; their history and the subagent remain. If Telegram is on, main's replies are
also queued for delivery there. Cleanup requests can themselves fail.

On success the script writes `.local/smoke-<stage>-receipt.json` (mode 600) and prints it. A failure prints its reason
and completed HTTP steps but writes no new receipt; an older file may remain. Receipts contain model/server names,
statuses, counts and booleans, never tokens, cookies or message bodies.

| Receipt field                          | What it checks or records                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `stage`, `signup`, `resident`, `model` | Target stage, sign-up mode, active authority and smoke model or `owner pick`.                                  |
| `servers`                              | Server statuses, tool/grant counts and probe outcome (`ok`, `error` or `not-granted`).                         |
| `files`                                | `ok`: the owner's file round trip, the file deleted again.                                                     |
| `app`                                  | `ok`: an agent app built, run by the owner (revision +1) and deleted.                                          |
| `inbound`                              | Initialization, inspection read, model turn, optional resident tool call, recent history and 401 after revoke. |
| `inbound.author`                       | `ok`: the smoke user's message has author `goblin-smoke`.                                                      |
| `thread`, `shared`                     | `ok` and `true`: the empty thread ran and wrote a new `app.shared` entry to main.                              |
| `subagent`                             | `reported`: the Delegate's result reached main (passively, or answered when synthesis was asked for).          |
| `memory.messages`                      | Messages logged since memory activation; must be greater than zero.                                            |
| `memory.summarized`                    | Messages covered before the newest input by the last placed memory view; recorded without a minimum assertion. |
| `utc`, `status`, `steps`               | Completion timestamp, `passed` and HTTP step/status pairs.                                                     |

Not covered here: the owner's Connect flow (it needs the owner at the remote server's consent screen), rendering
MCP Apps, the browser UI, thread branching, memory-summary quality, skills, and Telegram hook/inbox acceptance.

Prod commands use `.local/prod.env` and require `GOBLIN_CONFIRM_PROD=1` in the calling shell:
`bun run plan:prod`, `bun run deploy:prod`, `bun run smoke:prod`. There is no destroy-prod command.
`smoke:prod` defaults to public health, anonymous auth refusal, invite refusal, MCP metadata, the page and the canonical `www` redirect. Owner email/session remain empty until the real OTP bootstrap.
Only supplying the email and private OTP session file for an operator test account enables the full acceptance flow, including model turns.
Use a dedicated operator test account for production smoke.

`GOBLIN_DOMAIN` with the required `GOBLIN_ZONE_ID` attaches the stage's custom domain through Alchemy: `dev.goblin.surf` on dev, `goblin.surf` on
prod, plus `www.goblin.surf` on prod. The Worker redirects alternate hosts to `GOBLIN_APP_URL`, preserving the path
and query (301 for GET/HEAD, 308 for writes). Dev sign-up must be closed or invite-only.

## Release operation

Dispatch the Release workflow with a stage and full main SHA, or run `heavy bun run release dev <full-sha>` locally. After its authenticated receipt passes, run `GOBLIN_CONFIRM_PROD=1 heavy bun run release prod <same-full-sha>`. Persistent state, clean source snapshots, private logs and sanitized receipts live under `/var/lib/goblin-release`; only the operator and runner share its group. GitHub environment secrets are an explicit operator provisioning step.

The first production release is invite-only with no configured invite or owner email, so it admits nobody until the operator securely supplies those values. Its dedicated model key offers the approved five models and caps spending at $10 per 30 days. Dodo remains unconfigured in live mode. After the owner signs in with delivered OTP, grant exactly that verified production user a prod-scoped Pro override of 800 Credits/day and run authenticated prod smoke.

For an emergency code rollback, prepare a clean snapshot of the last compatible green SHA, review its plan against the retained prod state, and run the guarded prod deploy with the existing private prod config. Leave all auth, app and vendor data intact; do not run down migrations. Confirm that older code supports every additive schema already applied, then repeat public/authenticated acceptance and drift inspection and record the resulting Worker version. The normal release path continues to require a matching dev receipt.
