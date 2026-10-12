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

The workerd fixture advertises Events (top-level `capabilities.events`, or the SEP-3415 extension), sends verification
challenges and signs deliveries with
Standard Webhooks headers. Run the fixture from `apps/runtime`:

```sh
heavy bun run test:integration -t Events
```

It covers signed Telegram delivery into main, replay, signature/timestamp rejection, gaps, early refresh, shared
consumer cleanup, durable skill invalidation, retained skill versions, failed-handler reconstruction and pending-receipt
retention. Unit tests independently verify HMAC bytes. A live mygram round-trip is a separate
deployed acceptance gate. The fixture's throwaway conformance vector is handed to the producer orchestrator; never use
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

## Chat identities and local proof

Browser conversation ids are stable logical chat ids. `ChatDirectory` (`chats/directory.ts`) resolves one to its current Pi
session, and the primary remains chat `1` (nothing rebinds a chat: Move to thread forks, ADR 0034). Every input into a
chat goes through one admission sequence (`ChatOperations.send`, `chats/operations.ts`), which records the operation's
receipt and selected session in `app_chat_operations` (`chats/receipts.ts`); retries keep that session, while Pi
continues to own transcripts, tasks, request ids and documents. Receipts are pruned opportunistically after 30 days.
Admission and passive writes hold the chat's one lock, `KeyedLock`'s (`ChatOperations.withChat`; the mover and a
Topic's seed take it too), never across model execution.

The unit suite covers lookup, receipts (a row from before them reads as `legacy`), replay binding, retention, the one
admission sequence, flows and chat locks (`chat-receipts.test.ts`, `chats.test.ts`, `chats-service.test.ts`). The
local workerd profile proves the boundary by binding chat `1` to a fresh non-root Pi session before service
composition:

```sh
GOBLIN_HARNESS_PORT=19101 heavy bun run --cwd apps/runtime test:integration:permuted
```

The profile runs the owner, helper, routine, Telegram, memory and related native cases; owner and inbound proofs check
the non-root session and an empty root transcript. The root `heavy bun run check` includes that profile. These are unit
and local workerd results only; they do not establish deployed-stage, live-provider, Telegram-service or remote
eviction acceptance.

## The dev stage

Dev (`https://dev.goblin.surf`) is the daily instance. Its configuration is `.local/dev.env`
(mode 600) plus the shared Cloudflare credentials in `~/.config/myapps/dev.env`:

| Variable | Meaning |
| --- | --- |
| `GOBLIN_STAGE`, `GOBLIN_APP_URL` | `dev` and the Worker's HTTPS origin. |
| `GOBLIN_DOMAIN`, `GOBLIN_ZONE_ID` | Custom hostname and its Cloudflare zone ID. |
| `GOBLIN_SIGNUP_MODE`, `GOBLIN_SIGNUP_INVITE_CODE` | `open`, `invite` or `closed` (default), and the invite code. |
| `GOBLIN_FREE_DAILY_CREDITS` | The free plan: daily model Credits for an account without Pro (no routines); unset or `0`, every account must subscribe. Capped at Pro's 800. |
| `GOBLIN_MAIL_SENDER` | Required OTP sender on a Cloudflare Email Sending domain. |
| `GOBLIN_OWNER_EMAIL`, `GOBLIN_SMOKE_SESSION_FILE` | Existing owner email and mode-600 OTP session JSON; only smoke reads them. |
| `GOBLIN_BETTER_AUTH_SECRET` | Better Auth's secret. |
| `GOBLIN_MODEL_BASE_URL`, `GOBLIN_MODEL_ID`, `GOBLIN_MODEL_KEY` | Railway LiteLLM and the dedicated capped key. Never the master key. |
| `GOBLIN_MODELS` | More LiteLLM model names users may pick, comma-separated; `GOBLIN_MODEL_ID` stays the default. Allow each on the LiteLLM key too. |
| `GOBLIN_MODEL_CREDIT_RATES` | JSON tokens per estimated Token Plan Credit (`{ default?, models?, aliases? }`, each rate `{ input, cached, output }`); unset, Alibaba's example rates (ADR 0026). |
| `GOBLIN_MEMORY_MODEL` | The offered model for thread names, Topic Conversation memory summaries and skill-draft decisions. It is not selected by price; unset or not offered uses the default. |
| `GOBLIN_SMOKE_MODEL` | Optional model for smoke turns. It must be one of the offered models; unset keeps the owner's pick. |
| `GOBLIN_MCP_SERVERS` | JSON list of outbound servers every account starts with: `[{"connectionId":"mercator","endpoint":"https://mercator.sh/mcp/auth","label":"Mercator"}]`. Dev and prod configure Mercator (ADR 0043); each owner still signs in. |
| `GOBLIN_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP credentials, Events secrets/envelopes and the legacy doorbell secret; derives purpose-separated hook tokens. |

These are source defaults and configuration names; active dev settings and provider caps must be verified separately.

```sh
bun run plan:dev                          # preview
bun run deploy:dev                        # deploy
bun run destroy:dev -- --confirm-reset    # erase every account, conversation and MCP credential
GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset   # the same on prod, only at a reset the owner decided
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
  above the composer in the channel and in the thread panel with expandable text, files, references and authors. They enter the transcript
  only when Pi starts them. Reload or reconnect to restore the queue; a failed content read retains the last view and
  retries. An idle conversation with pending inputs does not say Ready. Helpers and routine runs use their existing flows.
  Remove withdraws one waiting message without stopping active work. If Pi has already started it, the message keeps
  running and the UI says so. Failed removals keep the row visible for retry.
- **Conversations.** Each Topic is a channel in the sidebar; Personal's is Main (`/c/1`), and the rail's Home opens
  the channel you showed last. **Reply in thread** in the toolbar over any settled message, in any conversation,
  opens a draft in the thread panel beside the channel; sending starts the thread from that message, so an unsent
  reply leaves nothing behind. The message then carries the thread's summary ("n replies · Last reply …"), which
  opens it in the panel. Threads opened inside a thread stack there with a back crumb; × closes the panel and stops
  nothing. The URL (`/c/<channel>?thread=<id>`) names what the panel shows, so reload, links and Back work, and a
  thread's own `/c/<id>` opens its channel with the panel. On a phone the sidebar is a drawer from the top bar and a
  thread is a full view with a back to its channel. A conversation off screen for ten seconds stops following and
  catches up when it is back. A dot marks unread replies on every device until a chat shows them. **Share back** in
  the thread's menu asks the thread to write a note into the conversation it came from; it starts no answer there.
  Rename and Close are in the same menu; Close stops the thread and everything under it (its subagents and nested
  threads) and keeps its history, and Reopen brings it back. Subagents open in the panel from their spawner's
  transcript, can start their own, and close by themselves once their answer is reported. Writing in a subagent
  keeps it open, and while it works your
  message steers it, and its answer goes up to whoever started it with your words quoted. Every chat of a Topic works
  with the Topic's setup (its MCP servers and their tools, skills, apps and subagents; ADR 0040): choose it when you
  create the Topic, from the Topic menu's "MCP servers & skills…" or from the button beside the composer, which reads
  what a narrowed setup holds. Settings shows main's remembered-message count; see the architecture for memory and `zoom`.
- **Threads, Activity and Tasks.** The rail's Threads lists every thread, unread first; Activity what needs you (with
  Undo for what Goblin organized); Tasks the Delegates, Personas and routines at work. A Persona in the sidebar opens
  its profile: edit it (each save is a revision), archive it, or read its revisions. **Add persona** makes one.
- **Threads from the composer, Personas and sources.** The composer's thread button (or `/new-thread`) makes the next
  send start a thread; × goes back with the draft kept. On a server with Move, a message of yours in a channel offers
  Move to thread in its toolbar. With Personas, `@` offers them; tag two or more and choose Together or In turn.
  A strip under an answer that used other chats opens to each source.
- **Questions, models and budget.** Answer an `ask_user` card with your next message. Pick an offered model in the
  composer; Settings and the composer's ring show today's usage in Credits, resetting at 00:00 UTC.
- **Commands and references.** Type `/` to choose a skill, `/help`, `/stop` or `/new-thread`, and `@` to choose a
  connection, skill or helper. Arrows browse; Enter or Tab selects; Escape dismisses. Unselected tokens remain prose.
  Chips can be removed. Skill-only sends are allowed; connection hints grant nothing; helpers bring their latest
  bounded report into this conversation. New thread moves the prose, chips and attachments into a new thread's draft
  in the panel. Failed selections preserve the draft and mark the failing chip. These controls work in channels,
  threads and drafts.
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
- **MyPlan as an App.** The suggested MyPlan server uses `https://dev.myplan.lol/mcp` on local and dev
  (`apps/runtime/src/mcp/suggested.ts`); `GOBLIN_MCP_SERVERS` may configure another endpoint. Connect it, then switch
  on **Its App** above the tools that App uses. Ask the agent to open a note ("Open my Trip plan
  note"); the App opens in place under the tool row (on an older call, open the row and press *Show app*). Its bar
  opens it as a page beside the conversation or closes it; on the page, the pill's menu brings it back, fills the
  workspace or closes it. Several Apps run at once, in any conversation; beyond six the least recently seen unloads to
  a stub. These moves keep the same iframe and bridge. What an App shares rides along with your next message in its conversation as untrusted
  context; links it offers wait for your click. The originating server supplies the resource URI and the App's
  behavior. Home dashboard placement is deferred; Apps open in their conversations or as pages.
  A MyPlan question App saves the answer in MyPlan, then offers a bounded saved-answer receipt through
  `ui/message`. Goblin shows **Continue** and **Dismiss** in its own chrome. Only the owner's Continue click
  submits a fixed message with the receipt as untrusted App context in the originating conversation; it sends no
  answer text or capability. Retry and reload reuse the same submission operation. Dismiss leaves the answer saved.
  Local host acceptance: `heavy bun apps/web/test/ui-message.ts` covers save, stage, Continue, retry, reload and
  Dismiss with fixture tool replies; it does not prove authenticated MyPlan acceptance or a deployed release.
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
  with an operation id (a Telegram message is `telegram-<id>`), then `inspect_conversation` for the words.
  `inspect_flows` shows how conversations moved (sends, replies, thread starts, moves, Personas, Delegates) and
  `inspect_details` the operation behind a message. Reading needs no plan; `ask_agent` does.
- **The `goblin` CLI** (`apps/cli`) is the same from a terminal: an MCP client of `/mcp` that asks for
  `goblin:inspect`, whose commands come from the server's tools.

  ```sh
  bun run goblin login                  # once: prints the sign-in URL; approve in a browser
  bun run goblin problems --since 6h
  bun run goblin problems --all --since 6h # expected waits and recovered model attempts too
  bun run goblin turns
  bun run goblin turn telegram-<id>     # one turn end to end
  bun run goblin conversation 1         # main's entries, in full
  bun run goblin flows --chat 12        # how a chat's conversation moved, content-free
  bun run goblin details --operation <id> # what happened behind one message, and its related operations
  bun run goblin logs telegram-<id>     # Workers Logs lines that mention an id
  bun run goblin lookup 7f3a9c12        # a reference the app showed: its log lines, then its operation's details
  bun run goblin stats --since 24h      # flow totals across every agent of the stage (Analytics Engine)
  ```

  Problems filter expected authority waits and confirmed automatic model retries before applying the limit. They keep
  unresolved tool failures, cutoffs, empty final answers and coverage gaps. `inspect_problems` and `diagnose` take
  `all: true` for the full retained problem history; a turn's timeline always includes every recorded event. Private
  errors and tool payloads stay in `inspect_conversation`; telemetry summaries are fixed host codes. Old ledger reads
  are sanitized too. Successful background model calls, including bounded memory completions ending in `length`,
  are excluded from both problem views; actual background failures remain. These changes need no schema migration.

  `--origin` (or `GOBLIN_ORIGIN`) picks the stage, default `https://dev.goblin.surf`. Credentials live in
  `~/.config/goblin/credentials.json` (mode 600). The sign-in redirects to `http://127.0.0.1:18979/callback`; when the
  browser is on another machine, paste the URL it lands on into the prompt. `goblin logs`, `goblin lookup` and
  `goblin stats` read Cloudflare with your own `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` and the stage
  Worker from `/health`; the Worker never sees them. `goblin stats` queries the stage's Analytics Engine dataset
  (`goblin-<stage>-flows`) and needs a token with Account Analytics read. `--json` prints a tool's structured result; `bun link` in `apps/cli` puts `goblin` on your path.

## Changing things

- Application tables: edit `apps/runtime/src/storage/schema.ts` and append a migration to its area's list in
  `apps/runtime/src/storage/migrations/` (`base.ts`, or `conversation.ts` for the conversation-operation migrations):
  `{ key: '<14-digit timestamp>_name', tables, sql }`, statements joined by `BREAK` (`--> statement-breakpoint`).
  `storage/migrations.ts` applies every list in key order and refuses a table that is not an application table.
  Until launch goblin is greenfield: a migration is edited in place as if the schema had always been so, and a
  release that edits an applied one resets dev first (`bun run destroy:dev -- --confirm-reset`); a new table or column
  may also arrive as its own migration, which needs no reset. Never touch Pi or Agents tables.
- Owner API endpoints: add the endpoint to its area's group in `packages/contracts/src/api/` (paths are relative to
  `/api`; `error` names the failures the endpoint itself produces), then its handler in the area's `api.ts`
  (`http/api/groups.ts` wires every group). Owner admission runs before each request; nothing in the Worker changes.
  A caller that is not the owner's browser (an MCP client, a hook) gets an endpoint of the internal API instead
  (`packages/contracts/src/api/internal.ts`, behind `InternalGate`), which the Worker calls through
  `inbound/client.ts`; never add a Durable Object RPC method.
  Test a group by serving it alone (`served([Group], handlers)` in `apps/runtime/test/http/api/fixture.ts`),
  and call it from the web through a factory in the feature's `queries.ts` (ADR 0038).
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
  them (the shell's `--shell-*` and `--moss` tokens are goblin's: the moss rail and sidebar beside the off-white page). Motion uses the theme's curves (`ease-out`,
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

Daily work targets the private `dev` branch. Check runs on dev pushes; successful push checks trigger Release dev for that exact current dev tip. It deploys from a clean snapshot, verifies authenticated smoke, drift and migration inventory, and records the active Worker version. A superseded dev commit cannot deploy.

Run the Promote workflow on `dev`, supplying its full SHA and operation `promote`. It requires current authenticated dev acceptance of that SHA, advances private `prod` without a force push, then directly deploys and verifies prod. A bot ref update does not trigger another workflow, so promotion owns that deployment explicitly. All stage operations share the existing `/var/lib/goblin-release/deploy.lock`, stage names and Alchemy state. Destructive plans still require a separate explicit reset decision. Promote also plans and deploys Wallet production from the same source snapshot through `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod`, preserving its separate wallet deploy lock and Alchemy state. Prod CI materializes mode-600 `.local/wallet-prod.env` from `GOBLIN_WALLET_PROD_ENV`. Wallet smoke requires `GET /health` with `ok:true,live:true`, OAuth metadata issuer `https://wallet.goblin.surf`, and anonymous `POST /mcp` returning 401. Its receipt binds the source SHA to the active `goblin-wallet-prod` version. These probes never sign or spend.

Only accepted production is exported into `grmkris/goblin-public/main`. The exporter builds separate Git objects from filtered source trees, preserving original authors, emails and dates while removing private configuration and operational records. It retains portable tests, benchmarks, spikes, fixtures, manifests, patches and required toolchain docs. A complete public frozen install and check, history secret scan and dependency applicability gate run before a fast-forward push with a public-repo-only deploy key. The private source-to-public commit map and logs stay outside the checkout. Public CI uses GitHub-hosted runners and has no deployment credentials. Issues are the initial contribution path.

Choose operation `publish` with the same accepted prod SHA to retry export after a publication failure. Production remains deployed if export fails. The exporter rechecks both live Worker versions, their same-SHA acceptance receipts and the prod ref before pushing. The private repository stays private; the first destination is created private and made public only after its full history and checkout pass validation. See [ADR 0046](adr/0046-production-promotion-and-public-source.md).

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
Apps, live grants, queued inputs and safe removal in Main/threads, conversation Close/reopen, Topics (`topics-case.ts`:
one Pi session per create, name clashes, inherited threads, archive stopping a held run, restore, inbound landing in
Personal), Personas (`persona-case.ts`: tagged Personas answer attributed and without Goblin, in order, at their frozen
revision, Stop drops them, exclusions hold; organize tools leave receipts and Undo is refused as `touched` after a later
edit), and isolation between two authenticated accounts even with forged
workspace/agent request selectors. Removed workspace, invitation and interaction endpoints return 404.
These keyless deterministic tests are local evidence; deployed smoke and real provider acceptance are separate.

`heavy bun apps/web/test/ui-queue.ts` renders the real queue and composers in local Chromium with controlled HTTP and
native event fixtures. It checks full/inline shared reads, refresh, failed sends, removal and failed-removal retry at desktop/phone widths in
light/dark with reduced motion. Private receipts go under `.local/goblin-acceptance/queue-*`; this is browser fixture
evidence, separate from signed-in deployed acceptance and real-device checks.

`heavy bun apps/web/test/ui-setup.ts` renders a Topic's setup editor (ADR 0040) from source in local Chromium, from the
right on a desktop and from the bottom on a phone, in light and dark: Everything to Only these, a tool switched off,
touch rows of 44px, no sideways scroll, and Save as the owner API's compare-and-set answered with a routine left short.
Screenshots go under `.local/goblin-acceptance/setup-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-events.ts` renders a connection's Events (ADR 0041) from source in local Chromium at desktop
and phone widths, light and dark: the open offer, Set up on a stream, its filters as a form from the stream's input
schema (and JSON for one a flat form cannot hold), Hand to a Persona in another Topic, and the proposal's review, with
the owner API routed in the page and the proposal it receives checked. Screenshots go under
`.local/goblin-acceptance/events-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-holds.ts` renders the MCP 2026 owner cards (ADR 0042) from source in local Chromium at
desktop and phone widths, light and dark: a URL request on the connection's own host and one elsewhere (flagged), its
Open link (a new tab, never followed by the page), Done while the server still waits and Done once it answers, Cancel,
and the step-up card's sign-in link and Continue, with the owner API routed in the page. Screenshots go under
`.local/goblin-acceptance/holds-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-markdown.ts` renders chat Markdown from source in local Chromium at desktop and phone
widths: a reply that settles keeps its blocks (a table keeps its element and sideways scroll), with and without
motion (words fade in behind a caret only when motion is allowed), code highlights once
Shiki loads and Copy copies exactly the code, a table copies as CSV or Markdown and downloads as CSV, math sets in KaTeX while prices stay prices, a link asks
before it
opens and shows its address, and an image is fetched only when asked, once, without a referrer. Receipts go under `.local/goblin-acceptance/markdown-*`.

## Client performance

A change made for speed is measured against the revision before it; nothing is inferred from bundle size or transform
speed alone. Both scripts build two revisions (`--base`, default `HEAD`; `--candidate`, default the working tree, which
includes other agents' edits) in scratch worktrees under `/tmp/goblin-perf-worktrees` with today's harness copied in.

- `heavy bun apps/web/test/ui-perf.ts` builds `apps/web/test/perf/` for production (the real `useConversation`,
  projection and `Conversation` over a faked stream, `react-dom/profiling` so `<Profiler>` reports) and measures A
  and B interleaved on a 390px phone profile at 4× CPU slowdown and on desktop: opening 100–1,600 parts, streaming a
  reply at pi-durable's 100 ms batches while typing, wheel-scrolling 1,000 parts, and idle work after a reply. A win
  or a regression needs the medians to differ by more than either side's spread; this box is shared, so only compare
  numbers from one run. The same revision on both sides gives the noise floor.
- `heavy bun apps/web/test/ui-follow.ts` plays scripted owner turns against the same fixture (a streamed reply, a tool
  round after a slow provider, a storm of parallel calls, a reply already past the fold when its turn lands, a
  re-snapshot after the tab was away, the composer growing mid-stream) on the phone and desktop profiles and reports,
  frame by frame, how far the newest row sat under the composer, whether the jump-to-end arrow was offered while
  streaming, whether the view was pulled back up, how many rows the turn takes, and how often the gap between two rows
  that are both on screen changed (a visible jump; rows above the screen settling are not one, the scroller keeps the
  screen where it was). `--assert` exits 1 when a turn ends with its newest row hidden or the arrow still offered;
  `--shots` saves the live, settled and opened screens; `--dist` reuses a built fixture. Chromium only: WebKit follows
  less far on a phone and needs Playwright's image on this box.
- `heavy bun apps/web/test/ui-bytes.ts` builds the app into fresh directories and sizes, from TanStack Start's route
  manifest, the JavaScript a chat route preloads, the stylesheet, all client JavaScript and the Worker.

Receipts go to `.local/goblin-perf/<utc>-perf/` and `-bytes/` (`summary.md`, `receipt.json`). This is local fixture
evidence: no account, real Apps or provider, and not a device measurement.

**Long chats (2026-10-10).** Streaming into 1,000 parts on the phone profile is still about 4 fps (frame p50 ≈ 230 ms).
A trace of that stream puts 52 s of main-thread work against a 10 s reply, and React's render is only 5–7 s of it: the
rest is the browser hit-testing, painting and laying out every row on each batch. Skipping settled off-screen rows
(`content-visibility: auto` with remembered sizes) cut that to 29 s in Chromium, but was not kept: rows whose content
loads late (a diagram, a chart) keep their pre-load height while skipped, and WebKit then followed a streaming reply
less far. The attempt is kept in `.local/goblin-perf/phase5-settled-rows/`. Virtualize, or retry skipping with async
content measured, when a chat the owner actually has reaches the size where this costs: the phone profile's stream
frame p95 over 150 ms or opening it over 10 s. At 200 parts it is 50 ms p50 and about 4 s to open; at 1,000, 230 ms
and about 20 s. The React Compiler was measured and not adopted: both engines cut React's work while streaming by
15–27%, at +7% on the chat route's first load and +2–8% heap.

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
LOCAL throwaway-account receipts verify reminder dedupe/passive acceptance, retained cron firing
and rearm across restart, revoked-authority skip with unchanged usage, active/running caps and run/day token blocking
using CLIProxy. The native recurring-wake regression verifies the next sweep survives the callback that scheduled it.
Real provider billing, Telegram delivery, cron-after-deploy and real producer acceptance require separate deployed
verification.

## Conversation and retained Home data

Check Main with an empty transcript and existing history at desktop and phone widths: the composer remains reachable, the latest exchange is the landing point, and there is no Home grid or Home entry in the turn map. Apps previously placed on Home should be available in their tool rows or their own pages. Moving between page and chat preserves the single iframe and action bridge.

Home's runtime service and native workerd tests still cover persistence, replay, stale revisions, owner authority, bounds, app deletion and MCP grants. The browser does not render this saved layout. Dashboard UI acceptance resumes with a future iteration; installed iPhone behavior remains an owner device check.

The no-auth inbox fixture builds the `app_docs` example in Dynamic Workers and drives the native job callback through 15-minute slots. It checks newest-five validation, freshness and last-good retention after an invalid response. Run it from `apps/runtime` with `heavy bun run test:integration test/integration/inbox.test.ts`. Real MyInbox sign-in, app-power approval and message freshness on dev are separate owner steps.

## Typed decisions

Only the dev stage binds Workers AI (`AI`) for Clef (ADR 0031). The local stack and the native test stacks bind none,
so decisions judge nothing there and nothing calls paid Workers AI. Runtime unit tests cover the critic's routing,
decoding, stale results, authority, budget and unknown usage, and context relevance over a real transcript index in
`node:sqlite` with a fake Pi source and a fake Clef. The native `decisions` probe (in the probe registry) and the
owner's decisions case run the real service over the object's SQLite and Pi with the probe's own Clef: a report judged
once per relay, the first label kept and replayed, a stale result discarded, no call once the budget is spent, nothing
judged without Clef, and main still answering. Web unit tests cover the rows, the label call and the feed's slice, not
a browser run. These are local results: provider evaluation is the benchmark's (`bench/README.md`), and dev acceptance
is separate.

The model `clef` has an input-only estimated Credit rate (5,000 input tokens a Credit). Override it in
`GOBLIN_MODEL_CREDIT_RATES` with `output: null`; unrelated model overrides keep Clef's default. It is a conservative
app-budget estimate, not a conversion of Workers AI dollars into Token Plan Credits. A dispatched call whose usage is
unknown is charged its whole 65,536-token context; without the binding there is no call and no charge.

## Goblin Wallet stages

Goblin Wallet is a separate Worker beside goblin: `apps/wallet` (Worker and Alchemy stack `goblin-wallet`),
`apps/wallet-web` (the Vite and React console, built to static assets) and `packages/wallet` (the shared library).
Its stage commands are `scripts/wallet-stage.ts`, not `scripts/stage.ts`:

- `bun run dev:wallet` builds `wallet-web` and runs the stack locally (placeholder Cloudflare credentials).
- `bun run plan:wallet-dev` and `bun run deploy:wallet-dev` plan and deploy the `dev` stage
  (`wallet-dev.goblin.surf`) under `flock $GOBLIN_RELEASE_ROOT/wallet-deploy.lock`. Resources are named
  `goblin-wallet-dev[-role]`; Alchemy state lives in `/var/lib/goblin-release/alchemy/state/goblin-wallet/dev` and the
  first deploy creates it.
- `bun run plan:wallet-prod` and `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod` do the same for the `prod` stage
  (`wallet.goblin.surf`, `goblin-wallet-prod[-role]`), reading `.local/wallet-prod.env`. Prod has its own relay key: a
  relay's nonces live in its stage's `WalletRelay`, so two stages must never share one key.

The script scrubs `CLOUDFLARE_*`, `GOBLIN_*`, `PRIVY_*`, `RELAY_*`, `TREASURY_*` and `WALLET_*` from the inherited
environment, then merges the shared Cloudflare file and `.local/wallet-<stage>.env` (mode 600) into a temporary
mode-600 file. Names below; never commit or print the values.

| Variable | Used by |
| --- | --- |
| `PRIVY_APP_ID` | Worker (plain); served at `GET /api/config` |
| `PRIVY_APP_SECRET` | Worker (secret) |
| `PRIVY_AUTHORIZATION_KEY` | Worker (secret): signs Privy requests |
| `PRIVY_AUTHORIZATION_PUBLIC_KEY` | operator: registers the key quorum in Privy |
| `PRIVY_POLICY_ADMIN_KEY`, `PRIVY_POLICY_ADMIN_PUBLIC_KEY` | operator: policy administration |
| `PRIVY_SIGNER_ID`, `PRIVY_POLICY_ID` | Worker (plain); optional until Privy is provisioned |
| `RELAY_PRIVATE_KEY`, `RELAY_ADDRESS` | Worker (secret) and its public address: pays gas for relayed transactions |
| `TREASURY_PRIVATE_KEY`, `TREASURY_ADDRESS` | operator only: funds test wallets; never bound to the Worker |
| `WALLET_DOMAIN`, `WALLET_ZONE_ID` | custom domain; empty domain serves on workers.dev |
| `WALLET_RPC_URLS` | optional JSON object of chain id to RPC URL; empty uses the public RPCs |
| `WALLET_LIVE` | `1` allows mainnet money; anything else is testnets only |

Checks per workspace: `bun run --cwd apps/wallet test`, `bun run --cwd packages/wallet test`,
`bun run --cwd apps/wallet-web build`. The Worker has unit tests only; there is no workerd integration test yet.
