# Development

Requirements are Bun `1.4.2` and Node.js 22.

The [memory benchmark workspace](../bench/README.md) runs isolated native Pi experiments with a keyless provider by
default. `bun run bench:plan` previews the GLM/DeepSeek matrix; `bun run bench:run --manifest
bench/experiments/native-smoke.json --run smoke-01` starts its own local relay and workerd. Live calls require
`--live` and the separate mode-600 provider configuration. Runs, resume evidence and reports stay in `.local/bench/`.
`bench:import` and `bench:canary` freeze a real Claude session and six manually grounded probes; the resulting
six-arm, 36-answer manifest requires live CLIProxy inference and append-only semantic review before its scores count.
Native pressure and API transport capacity are separate manifest settings; failed checkpoint builds block dependent
episodes, and their usage stays charged when a new trial is prepared.
`bench:recall` prepares the four-arm DeepSeek recall iteration from the frozen real corpus without inference. It runs
cutoff 22 first and requires an explicit `bench:resume --live --until-cutoff 32` after the durable operational gate.
`bench:review-packet` exports blinded original answers; `bench:review-votes` imports independent machine/human votes
and human adjudication. Reports show strict and semantic results, memory/search effects, shared construction, reader
efficiency and remaining stage budgets. See the benchmark runbook for the exact limits and commands.

## MCP Events

The workerd fixture advertises `capabilities.events`, sends verification challenges and signs deliveries with
Standard Webhooks headers. Run the fixture from `apps/runtime`:

```sh
heavy bun run test:integration -t Events
```

It covers signed Telegram delivery into main, replay, signature/timestamp rejection, gaps, early refresh, shared
consumer cleanup, durable skill invalidation, retained skill versions, failed-handler reconstruction and pending-receipt
retention. Unit tests independently verify HMAC bytes. A live mygram round-trip is a separate
deployed acceptance gate. The lane's throwaway conformance vector is handed to the producer orchestrator; never use
its test secret for a real subscription.

## MCP call approvals

Under Connections, allow the exact tool, then change **Run when needed** to **Ask first**. An agent call ends its
turn with an approval card showing the exact redacted arguments. Approve once sends the original call, including
its `operationKey`; Refuse leaves the remote untouched. A later text message grants no approval. Existing grants
keep their prior automatic policy until the owner explicitly changes it; remote hints never choose it.

For a Sidequest showcase, mark `create_task`, `request_quotes`, `pick_quote`, `select_worker`, `approve_work`,
`reject_work` and `cancel_task` Ask first after connecting and granting them. App and background paths cannot bypass
this policy. An uncertain call may have taken effect; reconcile with the service before making another call.
The native owner test verifies routine/subagent holds and recovery fencing without a real hire or model spend.

## Local

```sh
bun install --frozen-lockfile
mkdir -p .local && cp .env.example .local/local.env && chmod 600 .local/local.env
bun dev                 # Alchemy runs the Worker in local workerd on http://localhost:18971
```

Model calls go through CLIProxy and inherit `CLIPROXY_API_KEY` from the interactive shell. The local stage supplies
its own auth secret and credential key and opens sign-up; set them in `.local/local.env` only to override.

Open the app and use **Create an account**, enter an email and the six-digit code captured under
`apps/web/.alchemy/local/email/`. Each account gets its own agent after plan admission. Smoke uses the session from
an actual OTP login: store `{"origin":"http://localhost:18971","cookie":"<session cookie>"}` in
`.local/local-session.json` with mode 600, then configure `GOBLIN_OWNER_EMAIL` and `GOBLIN_SMOKE_SESSION_FILE`. Never
print or commit the cookie. Smoke validates the file origin and the authenticated owner before making agent calls.

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

Dev (`https://dev.goblin.surf`) is the daily instance. Its configuration is `.local/dev.env`
(mode 600) plus the shared Cloudflare credentials in `~/.config/myapps/dev.env`:

| Variable | Meaning |
| --- | --- |
| `GOBLIN_STAGE`, `GOBLIN_APP_URL` | `dev` and the Worker's HTTPS origin. |
| `GOBLIN_DOMAIN`, `GOBLIN_ZONE_ID` | Custom hostname and its Cloudflare zone ID. |
| `GOBLIN_SIGNUP_MODE`, `GOBLIN_SIGNUP_INVITE_CODE` | `open`, `invite` or `closed` (default), and the invite code. |
| `GOBLIN_MAIL_SENDER` | Required OTP sender on a Cloudflare Email Sending domain. |
| `GOBLIN_OWNER_EMAIL`, `GOBLIN_SMOKE_SESSION_FILE` | Existing owner email and mode-600 OTP session JSON; only smoke reads them. |
| `GOBLIN_BETTER_AUTH_SECRET` | Better Auth's secret. |
| `GOBLIN_MODEL_BASE_URL`, `GOBLIN_MODEL_ID`, `GOBLIN_MODEL_KEY` | Railway LiteLLM and the dedicated capped key. Never the master key. |
| `GOBLIN_MODELS` | More LiteLLM model names users may pick, comma-separated; `GOBLIN_MODEL_ID` stays the default. Allow each on the LiteLLM key too. |
| `GOBLIN_MODEL_CREDIT_RATES` | JSON tokens per estimated Token Plan Credit (`{ default?, models?, aliases? }`, each rate `{ input, cached, output }`); unset, Alibaba's example rates (ADR 0026). |
| `GOBLIN_MEMORY_MODEL` | The offered model for thread names, main-memory summaries and skill-draft decisions. It is not selected by price; unset or not offered uses the default. |
| `GOBLIN_SMOKE_MODEL` | Optional model for smoke turns. It must be one of the offered models; unset keeps the owner's pick. |
| `GOBLIN_MCP_SERVERS` | JSON list of outbound servers: `[{"serverId":"myplan","endpoint":"https://…/mcp"}]`. |
| `GOBLIN_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP credentials, Events secrets/envelopes and the legacy doorbell secret; derives purpose-separated hook tokens. |

These are source defaults and configuration names; active dev settings and provider caps must be verified separately.

```sh
bun run plan:dev                          # preview
bun run deploy:dev                        # deploy
bun run destroy:dev -- --confirm-reset    # erase every account, conversation and MCP credential
bun run smoke:dev                         # acceptance; see scripts/README.md
```

Changing `GOBLIN_CREDENTIAL_KEY` makes stored MCP credentials and the Telegram secret unreadable and changes the hook
token; reconnect the servers and re-enable Telegram afterwards.
Changing a server's `endpoint` drops what was stored for it (credentials, grants, pending sign-ins) at each
agent's next start; connect it again. Tokens are never carried from one host to another.

## Using it

- **Tool details.** Open a tool line in a conversation to inspect Input and Output. JSON branches fold, long strings
  offer Show more, and large arrays load 50 items at a time. Markdown output opens formatted. Tree or Formatted and
  Raw switch the presentation; Copy keeps the full original input or output. Plain-text results remain readable. This also works on existing conversation history.
- **Add a server.** Connections → Add a server. **Suggested** adds and connects one of ours in one tap. **Search**
  searches the MCP registries; add your own under Registries searched. **By address** takes any MCP address (public
  https only). Servers without sign-in connect directly; the suggestions mark DeepWiki, Context7 and Cloudflare Docs
  this way. Remove, in a server's ··· menu, asks first and takes its sign-in and grants with it. To suggest another server, check that it connects from a Worker,
  then add it to `apps/runtime/src/mcp/suggested.ts` with its endpoint for each stage.
- **Connect a server.** Connections → Connect. You sign in at the remote server and approve; you come back
  connected. Servers that answer without sign-in connect directly. Then turn on the tools the agent may use, one by one
  or with Allow all; None turns them all off. Nothing is granted by default. A server marked **Needs sign-in** needs a
  new sign-in: press Sign in again. **Try a tool**, at the bottom, calls an allowed tool by hand.
- **Queued messages.** While Main or an ordinary thread is working, Send adds a follow-up. Queued messages appear
  above both full and inline composers with expandable text, files, references and authors. They enter the transcript
  only when Pi starts them. Reload or reconnect to restore the queue; a failed content read retains the last view and
  retries. An idle conversation with pending inputs does not say Ready. Helpers and routine runs use their existing flows.
  Remove withdraws one waiting message without stopping active work. If Pi has already started it, the message keeps
  running and the UI says so. Failed removals keep the row visible for retry.
- **Conversations.** Each conversation is a pane; the URL (`/c/<id>`) names the focused one and `/` restores your
  last arrangement. Click a conversation in the sidebar to show it in the focused pane. The **+** beside Threads opens
  a new thread's draft beside it, and **Reply in thread** under any settled message, in any conversation, opens a
  small reply right under that message; sending starts the thread from it, so an unsent reply leaves nothing behind.
  The message then carries the thread's chip (replies, name, last activity) instead of Reply in thread: it unfolds
  the live thread in place, with its own threads unfolding the same way and **Open in pane** to put it beside. While a
  thread is in a pane its fold says so, with the way to it and back. A conversation off screen for ten seconds stops
  following and catches up when it is back. Drag a pane by the grip in its pill onto another pane: near an edge it splits there, in the middle the two
  trade places (Escape cancels). Drag a divider to resize, **Fill the workspace** in the pill's menu to show one pane
  alone, and × to close a pane (any but the last; the conversation goes on). The device remembers the arrangement;
  narrow screens show one pane at a time, swipe between them. The sidebar lists every conversation as a tree
  (subagents under who started them, threads under where they branched); hover a row for **Open beside**, or drag a
  row onto a pane. ⌘/Ctrl+B folds it to a rail of the active ones; rest on an icon to see what it is. A dot marks
  unread replies on every device until a pane shows them. **Share to …** asks the thread to
  write a note into the conversation it came from; it starts no answer there. Rename and Close are in the thread menu;
  Close stops the thread and everything under it (its subagents and nested threads) and keeps its history, and Reopen
  brings it back. Subagents appear under the conversation that started them, can start their own, and close by
  themselves once their answer is reported (they fold into "n closed" under their spawner); one left open folds into
  "n idle" once it is idle and you have read it. The chevron at the end of a row hides what it started, and this
  browser remembers it. Writing in a subagent keeps it open, and while it works your
  message steers it, and its answer goes up to whoever started it with your words quoted. The sliders button by the composer shows
  what the agent can use in that conversation (connections and their tools, skills, subagents); switching something
  off there hides it from the agent in that conversation only, and a new thread starts with the switches of the conversation it came from. Settings shows main's remembered-message count; see the architecture for memory and `zoom`.
- **Questions, models and budget.** Answer an `ask_user` card with your next message. Pick an offered model in the
  composer; Settings and the composer's ring show today's usage in Credits, resetting at 00:00 UTC.
- **Commands and references.** Type `/` to choose a skill, `/help`, `/stop` or `/new-thread`, and `@` to choose a
  connection, skill or helper. Arrows browse; Enter or Tab selects; Escape dismisses. Unselected tokens remain prose.
  Chips can be removed. Skill-only sends are allowed; connection hints grant nothing; helpers bring their latest
  bounded report into this conversation. New thread moves the prose, chips and attachments into a fresh draft pane.
  Failed selections preserve the draft and mark the failing chip. These controls work in panes, drafts and inline replies.
- **Figures.** Assistant replies can draw Mermaid, chart and map fences. Ordinary Markdown is the
  default for checklists, timelines, comparisons and small sets of values. Open streaming fences, invalid specs and
  drawing failures stay readable code. **Explore diagram** opens zoom, pan and node connections: scroll or pinch to
  zoom, drag or use arrows when zoomed, and select a node by click, tap, Enter or Space. Fit restores the view; Escape
  clears selection, then closes. Agent-app views share the kit; see `app_docs` topic `ui`. Local browser acceptance:
  build the app runtime with `heavy bun run --cwd packages/app build`, then run `heavy bun apps/web/test/ui-diagram.ts`.
- **Skills.** Connect a server that offers skills, then turn on its **Use its skills** switch. The agent reads and
  follows those procedures; their tools still need grants. To receive drafts in a library such as MySkills, grant
  `skill_draft` and `skill_draft_status`, then review the proposals there.
- **Telegram.** Bind the authorized mygram connection to the bot, then turn on its **Telegram** switch. A server offering
  Events grants `inbox`, `send_message` and its two exact event selectors; older servers use the four-tool doorbell
  fallback. Connections shows which transport is active. New inbox messages arrive in main as **Telegram**, including
  answers to pending questions, and replies go back to the bot. Turning it off unsubscribes and clears pending
  replies. The suggested MyGram endpoint is `https://dev.mygram.lol/mcp` for local/dev and `https://mygram.lol/mcp`
  for test/prod. It is unchanged while the owner decides the goblin bot/account setup; a dedicated bot is not assumed.
- **Resident authority.** Settings → Your agent → **Work while you're away** shows it and when it expires. Owner
  activity renews it for 30 days; inbound and scheduled work do not renew it. Turning it off stops all outbound MCP
  use by the agent until you turn it on again.
- **Routines.** Settings → Routines → New routine: what it does, when it runs (once at a time you pick, on a cron
  schedule, or on a server's event) and the tools and limits it may use. Saving makes a proposal; Confirm on its card
  turns it on, and an edit pauses it until you confirm again. The agent can also propose one in chat.
- **MyPlan as an App.** The suggested MyPlan server uses `https://dev-new.myplan.lol/mcp` on local and dev
  (`apps/runtime/src/mcp/suggested.ts`); `GOBLIN_MCP_SERVERS` may configure another endpoint. Connect it, then switch
  on **Its App** above the tools that App uses. Ask the agent to open a note ("Open my Trip plan
  note"); the App opens in place under the tool row (on an older call, open the row and press *Show app*). Its bar
  opens it as a page beside the conversation or closes it; on the page, the pill's menu brings it back, fills the
  workspace or closes it. Several Apps run at once, in any conversation; beyond six the least recently seen unloads to
  a stub. These moves keep the same iframe and bridge. What an App shares rides along with your next message in its conversation as untrusted
  context; links it offers wait for your click. The originating server supplies the resource URI and the App's
  behavior. Home dashboard placement is deferred; Apps open in their conversations or as pages.
- **MyInbox.** The suggestion uses `https://dev.myinbox.lol/mcp` locally and `https://myinbox.lol/mcp` on dev/test/prod.
  Public metadata advertises DCR, PKCE S256 and public clients; this does not prove a signed-in connection. The owner
  connects it in Connections, asks “Show my inbox in an app”, and allows the app power card. The agent uses the exact
  connected tool schema/server id, the `app_docs` `examples` pattern, and a 15-minute refresh schedule.
- **Add goblin to Claude Code.**

  ```sh
  claude mcp add --transport http goblin https://dev.goblin.surf/mcp
  ```

  Sign in and approve in the browser. It gets `ask_agent` and `get_recent_messages` in the agent's main conversation,
  with its messages labelled by client name, and, if you turn on "Also let it read your conversations and runs" on
  the consent page (it starts off), the read-only inspection tools (ADR 0024). Revoke it under Settings → Apps that use your agent. A connection made before inspection joined `/mcp`
  gets those tools after reconnecting once (in Claude Code: `/mcp` → goblin → Clear authentication).
- **Inspect your agent from a coding agent.** Start with `inspect_problems` or `inspect_turns`, then `inspect_turn`
  with an operation id (a Telegram message is `telegram-<id>`), then `inspect_conversation` for the words. Reading
  needs no plan; `ask_agent` does.
- **The `goblin` CLI** (`apps/cli`) is the same from a terminal: an MCP client of `/mcp` that asks for
  `goblin:inspect`, whose commands come from the server's tools.

  ```sh
  bun run goblin login                  # once: prints the sign-in URL; approve in a browser
  bun run goblin problems --since 6h
  bun run goblin problems --all --since 6h # expected waits and recovered model attempts too
  bun run goblin turns
  bun run goblin turn telegram-<id>     # one turn end to end
  bun run goblin conversation 1         # main's entries, in full
  bun run goblin logs telegram-<id>     # Workers Logs lines that mention an id
  ```

  Problems filter expected authority waits and confirmed automatic model retries before applying the limit. They keep
  unresolved tool failures, cutoffs, empty final answers and coverage gaps. `inspect_problems` and `diagnose` take
  `all: true` for the full retained problem history; a turn's timeline always includes every recorded event. Private
  errors and tool payloads stay in `inspect_conversation`; telemetry summaries are fixed host codes. Old ledger reads
  are sanitized too. Successful background model calls, including bounded memory completions ending in `length`,
  are excluded from both problem views; actual background failures remain. These changes need no schema migration.

  `--origin` (or `GOBLIN_ORIGIN`) picks the stage, default `https://dev.goblin.surf`. Credentials live in
  `~/.config/goblin/credentials.json` (mode 600). The sign-in redirects to `http://127.0.0.1:18979/callback`; when the
  browser is on another machine, paste the URL it lands on into the prompt. `goblin logs` reads Cloudflare with your
  own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the stage Worker from `/health`; the Worker never sees
  them. `--json` prints a tool's structured result; `bun link` in `apps/cli` puts `goblin` on your path.

## Changing things

- Application tables: edit `apps/runtime/src/storage/schema.ts` and append a migration to
  `apps/runtime/src/storage/migrations.ts` (`'<14-digit timestamp>_name'`, statements joined by `--> statement-breakpoint`).
  Never edit an applied migration; never touch Pi or Agents tables.
- Auth tables: Better Auth's schema lives in `apps/runtime/migrations` and is applied by the Alchemy D1 resource.
- Bindings: declare them in `apps/runtime/src/env.ts` and `apps/web/alchemy.run.ts` together, and in the integration
  stacks (`apps/runtime/test/integration/*-stack.ts`, `stack.ts`) when the runtime reads them.
- Agent apps: `packages/app` holds the SDK, release entry, transpiler and the agent's docs; `bun run build` there writes
  `dist/toolchain.js`, which the runtime bundles. `bun dev`, deploys and the integration tests build it first; run it
  yourself after editing `packages/app/src` or `docs` for an editor or a unit test. Local workerd runs Dynamic Workers
  (`--experimental`, which Alchemy passes) but enforces no CPU limit: never test an app with a busy loop locally. A
  change to the SDK or release entry changes the toolchain hash, so every app's next build is a new release.
- The owner's files: the `FILES` R2 bucket is local under Alchemy's workerd state in `bun dev` and the integration
  stacks, so nothing reaches a real bucket. Shell's `cf_workspace_*` tables are vendor-owned, like `pi_*`: migrations
  never touch them (ADR 0022).
- UI components: goblin looks like the myapps apps. Prefer porting a component from `~/code/myapps/packages/ui`
  (with an "Adapted from" header naming the commit); otherwise `bunx shadcn@latest add <component>` from
  `packages/ui`, then review the generated file. Keep the shared tokens in `packages/ui/src/styles.css` as myapps has
  them (the sidebar tokens are goblin's: a shade heavier than the page). Motion uses the theme's curves (`ease-out`,
  `ease-in-out`, `ease-drawer`, the default for every `transition-*`), never ease-in or `transition-all`, at 300ms or
  less with exits faster than entrances (sheets excepted). Every raw `:hover` in the app CSS sits under
  `(hover: hover)`, and a control that tints on hover tints on `:active` too, because the tap highlight is off. Fields
  stay at 16px on touch screens (`pointer-fine:md:` for anything smaller). The Home Screen icons, favicon and web app
  manifest are static files in `apps/web/public`; after changing the mark or the page background, run `bun run icons`
  and keep the manifest's colours and the root route's `theme-color` metas equal to `--background`. It also draws a
  startup image for every iPhone and iPad screen in `apps/web/src/lib/startup-images.ts`, which the root route links;
  add a screen there, bump its `VERSION` (iOS caches the images hard; installed apps need removing and re-adding),
  and run it again. Do not hand-edit `apps/web/src/routeTree.gen.ts`.
- Dependencies: `bun add <package> --cwd <workspace>`; commit `package.json` and `bun.lock` together. A patched
  dependency (root `patchedDependencies`) stays pinned to the version its patch was made for, and `bun run
  check:patches` fails when the installed file is not the patched one; `patches/shadcn-react/README.md` says how the
  MessageScroller patch is rebuilt.

Unit tests, local workerd and the deployed dev stage are separate kinds of evidence. Say which one you ran.


## Production preparation

`.local/prod.env` is mode 600, with fresh auth and credential secrets. Fill its model key with a dedicated Railway
LiteLLM virtual key; never the master key. Set `GOBLIN_DOMAIN=goblin.surf` and
`GOBLIN_APP_URL=https://goblin.surf`; dev uses `dev.goblin.surf` for both. Set `GOBLIN_MAIL_SENDER=hello@goblin.surf`
only after Cloudflare Email Sending verifies the sender. Every stage requires OTP mail; dev must stay closed or
invite-only. These settings do not authorize a production deploy.

`GOBLIN_CONFIRM_PROD=1 bun run plan:prod` previews, and the same explicit guard protects `deploy:prod` and
`smoke:prod`. The default prod smoke is read-only: health and an anonymous protected-route probe. An operator smoke
account's mode-600 OTP session file opts into the full flow. MCP clients authorize against the stage's origin.

The release workflow is manually dispatched with a full `main` SHA. It requires the successful Check workflow for that exact SHA, uses a persistent private Alchemy state directory (shared only by the operator and runner through the `goblin-release` group), serializes deploys with a host lock, rejects destructive plans, deploys from a clean detached snapshot, runs stage smoke and non-repairing drift checks (normalizing only Alchemy beta.80's unobservable domain-zone bookkeeping and D1's default disabled read replication), and records sanitized receipts outside the checkout. Production promotion also requires an authenticated dev receipt for the same SHA and a clean migration inventory. The first production receipt is public-only until the owner completes the real OTP session and entitlement override; no owner email, invite code or session is stored in this repository.

For the first production bootstrap, an operator supplies `GOBLIN_OWNER_EMAIL` and `GOBLIN_SIGNUP_INVITE_CODE` in the mode-600 prod environment, signs in through the real email OTP flow, and records the resulting mode-600 `prod-session.json`. The operator then applies exactly one stage-scoped Pro override of 800 Credits/day to that verified owner. Dodo stays deferred and its live keys remain unset.

## Billing development and acceptance

Set `DODO_PAYMENTS_ENVIRONMENT=test_mode` on local/dev and `live_mode` on prod. Store
`DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY` and `DODO_PRODUCT_ID` in the stage's mode-600 env file; Alchemy
binds them as Worker secrets. Choose a goblin-only recurring $10/month product with no trial. Never bind an account's
master model key or print payment keys. Configure a separate Standard Webhooks endpoint at `/hooks/dodo` per stage.
`/health` reports the stage billing mode and whether billing is configured; missing keys never bypass admission.

The billing migration grants existing users a dev-only Pro override; a fresh database has no such users. New OTP
signups need an operator override or test billing. Overrides grant nothing outside their configured stage. An operator can insert/update `app_billing_accounts` for a known user ID, setting `plan_override='pro'`,
`override_stage` to the intended stage, `daily_credits` to a positive allowance in Credits (Pro's is 800) and both
timestamps in milliseconds. `daily_tokens` is retired and no longer read.
Remove the override to test paid access. A fresh local user also needs test billing or an explicit local override.

The local billing tests run without keys or provider calls:

```sh
cd apps/runtime
heavy bun run test:integration -t billing
```

They deploy an isolated native Worker with real auth D1 and an injected Dodo client. The fixture levers and signing
key are reachable only from that test Worker; production imports neither. Acceptance on deployed dev is a separate
operator step: invite/signup a new account, confirm agent routes return 402, use a test card, wait for the signed
webhook and agent access, cancel and verify paid-through expiry, then replay a delivery. Preserve receipts without
card data or secrets. Existing operator accounts retain access.

The Credit rates are estimates, not the plan's bill; configure reviewed rates in `GOBLIN_MODEL_CREDIT_RATES`. Local
tests prove the pricing and separate ledgers, not the provider's actual charges.
Before prod payments, review the draft legal pages and provide operator identity, support/postal address, jurisdiction,
refund/withdrawal policy and retention/subprocessor details. Cancel recurring billing through Dodo before account
deletion; deletion does not itself cancel provider charges.

## Owner routing and Apps tests

The local workerd/auth-D1 owner fixture runs on `GOBLIN_HARNESS_PORT + 20`.
Run `heavy bun run --cwd apps/runtime test:integration test/integration/owner.test.ts` to verify per-call owner
Apps, live grants, queued inputs and safe removal in Main/threads, conversation Close/reopen, and isolation between two authenticated accounts even with forged
workspace/agent request selectors. Removed workspace, invitation and interaction endpoints return 404.
These keyless deterministic tests are local evidence; deployed smoke and real provider acceptance are separate.

`heavy bun apps/web/test/ui-queue.ts` renders the real queue and composers in local Chromium with controlled HTTP and
native event fixtures. It checks full/inline shared reads, refresh, failed sends, removal and failed-removal retry at desktop/phone widths in
light/dark with reduced motion. Private receipts go under `.local/goblin-acceptance/queue-*`; this is browser fixture
evidence, separate from signed-in deployed acceptance and real-device checks.

## Routine definition checks

From `apps/runtime`, run `heavy bun run test:unit test/routines-time.test.ts test/routines-summary.test.ts` for IANA
zones, DST, cron spacing, explicit reminder offsets, strict write CSRF and summary scrubbing. Run
`GOBLIN_HARNESS_PORT=18871 heavy bun run test:integration native.test.ts -t routine` for real local workerd SQLite,
native dated alarms, Pi run/session/report dedupe, no copied capabilities, committed usage, revoked-authority skips,
correlated questions, late answers, main Stop, two-running cap, burst collapse, archive and revision fencing. These
keyless fixture tests establish local behavior. The signed routine Events case shares the native stack and official
fixture producer: exact descriptor filters, raw signatures, shared leases, escaped run IDs, replay across revisions,
sealed metadata, one event/minute, pending coalescing, gap/poll recovery and termination/reconfirmation. No live MCP
producer or Telegram send is involved. To run just that case, use
`GOBLIN_HARNESS_PORT=18871 heavy bun run test:integration native.test.ts -t 'signed routine Events'`.

For local acceptance, start a separate `bun dev` stack with isolated Alchemy/D1/DO state and a throwaway account;
use the local operator entitlement override, no mail and no billing provider credentials. Through the authenticated
API/UI, confirm a near-future reminder, observe one completed run and passive main note, confirm a cron occurrence,
restart the local process before it fires, then verify firing and next occurrence. Revoke resident authority and
confirm a reminder yields a visible skip without token usage; check active/running and run/day token caps. Save
redacted logs and screenshots. Local CLIProxy provider evidence is distinct from Railway LiteLLM and retained dev.
The Events lane's LOCAL throwaway-account receipts verify reminder dedupe/passive acceptance, retained cron firing
and rearm across restart, revoked-authority skip with unchanged usage, active/running caps and run/day token blocking
using CLIProxy. The native recurring-wake regression verifies the next sweep survives the callback that scheduled it.
Real provider billing, Telegram delivery, cron-after-deploy and real producer acceptance require separate deployed
verification.

## Conversation and retained Home data

Check Main with an empty transcript and existing history at desktop and phone widths: the composer remains reachable, the latest exchange is the landing point, and there is no Home grid or Home entry in the turn map. Apps previously placed on Home should be available in their tool rows or their own pages. Moving between page and chat preserves the single iframe and action bridge.

Home's runtime API and native workerd tests still cover persistence, replay, stale revisions, owner authority, bounds, app deletion and MCP grants. The browser does not render this saved layout. Dashboard UI acceptance resumes with a future iteration; installed iPhone behavior remains an owner device check.

The no-auth inbox fixture builds the `app_docs` example in Dynamic Workers and drives the native job callback through 15-minute slots. It checks newest-five validation, freshness and last-good retention after an invalid response. Run it from `apps/runtime` with `heavy bun run test:integration test/integration/inbox.test.ts`. Real MyInbox sign-in, app-power approval and message freshness on dev are separate owner steps.
