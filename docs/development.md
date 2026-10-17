# Development

The isolated [OpenUI playground](../apps/openui-spike/README.md) previews the production interactive-reply renderer with synthetic data.
It has its own Alchemy stack and public Worker preview; it has no model or account bindings. The playground imports
the web app's reply renderer and does not enter the main app bundle. See its README for local checks and deployment.

Requirements are Bun `1.4.2` and Node.js 22.

## MCP Events

The workerd fixture advertises Events (top-level `capabilities.events`, or the SEP-3415 extension), sends verification
challenges and signs deliveries with
Standard Webhooks headers. Run the fixture from `apps/runtime`:

```sh
heavy bun run test:integration -t Events
```

It covers signed Events delivery to registered consumers, replay, signature/timestamp rejection, gaps, early refresh, shared
consumer cleanup, durable skill invalidation, retained skill versions, failed-handler reconstruction and pending-receipt
retention. Unit tests independently verify HMAC bytes. A live mygram round-trip is a separate
deployed acceptance gate. The fixture's throwaway conformance vector is handed to the producer orchestrator; never use
its test secret for a real subscription.

## MCP call approvals

Under Connections, allow the exact tool, then choose **Asks you first** in its policy menu. An agent call ends its
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

Model calls go through CLIProxy and inherit `CLIPROXY_API_KEY` from the interactive shell (without it the local stack
has no model endpoint of its own, and each account brings one in Settings). The local stage supplies its own auth
secret, credential key, mail sender and CLIProxy model settings and opens sign-up; set them in `.local/local.env` only
to override. To try sign-in through an OpenID Connect provider, set `GOBLIN_OIDC_ISSUER`, `GOBLIN_OIDC_CLIENT_ID` and
`GOBLIN_OIDC_CLIENT_SECRET` there, with `http://localhost:18971/api/auth/callback/oidc` allowed at the provider.

Open the app and use **Create an account**, enter an email and the six-digit code captured under
`apps/web/.alchemy/local/email/`. Each account gets its own agent. Smoke uses the session from
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

Browser conversation ids are stable logical chat ids. The chat directory (`chats/directory.ts`, served as `Chats`) resolves one to its current Pi
session, and the primary remains chat `1` (nothing rebinds a chat: Move to thread forks, ADR 0034). Every input into a
chat goes through one admission sequence (`ChatOperations.send`, `chats/operations.ts`), which records the operation's
receipt and selected session in `app_chat_operations` (`chats/receipts.ts`); retries keep that session, while Pi
continues to own transcripts, tasks, request ids and documents. Receipts are pruned opportunistically after 30 days.
Admission and passive writes hold the chat's one lock, `KeyedLock`'s (`ChatOperations.withChat`; the mover and a
Topic's seed take it too), never across model execution.

The unit suite covers lookup, receipts (a row without its kind and state is refused), replay binding, retention, the one
admission sequence, flows and chat locks (`chat-receipts.test.ts`, `chats.test.ts`, `chats-service.test.ts`). The
local workerd profile proves the boundary by binding chat `1` to a fresh non-root Pi session before service
composition:

```sh
GOBLIN_HARNESS_PORT=19101 heavy bun run --cwd apps/runtime test:integration:permuted
```

The profile runs the owner, helper, routine, Sources, memory and related native cases; owner and inbound proofs check
the non-root session and an empty root transcript. The root `heavy bun run check` includes that profile. These are unit
and local workerd results only; they do not establish deployed-stage, live-provider, Telegram-service or remote
eviction acceptance.

## The dev stage

Dev (`https://dev.goblin.surf`) is the daily instance. Its configuration is `.local/dev.env`
(mode 600) plus the Cloudflare credentials in `.local/cloud.env` (mode 600, only `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; `GOBLIN_CLOUD_ENV_FILE` names another file). CI deploys dev from the same names, held as the
`dev` environment's secrets (scripts/README.md, "Release operation"):

| Variable | Meaning |
| --- | --- |
| `GOBLIN_STAGE`, `GOBLIN_APP_URL` | `dev` and the Worker's HTTPS origin. |
| `GOBLIN_DOMAIN`, `GOBLIN_ZONE_ID` | Custom hostname and its Cloudflare zone ID. |
| `GOBLIN_SIGNUP_MODE`, `GOBLIN_SIGNUP_INVITE_CODE` | `open`, `invite` or `closed` (default), and the invite code. |
| `GOBLIN_MAIL_SENDER` | The sign-in code sender, on a Cloudflare Email Sending domain. A deployment needs it, an OpenID Connect provider, or both (ADR 0064). |
| `GOBLIN_OIDC_ISSUER`, `GOBLIN_OIDC_CLIENT_ID`, `GOBLIN_OIDC_CLIENT_SECRET` | Optional, all three or none: sign-in through an OpenID Connect provider (discovery from the issuer, PKCE, `openid email profile`). The provider must allow the redirect URI `<GOBLIN_APP_URL>/api/auth/callback/oidc`. The secret is bound as a secret. |
| `GOBLIN_OIDC_LABEL` | The provider button's words, such as `Sign in with mysi`; unset, "Sign in with" the issuer's host. |
| `GOBLIN_OWNER_EMAIL`, `GOBLIN_SMOKE_SESSION_FILE` | Existing owner email and mode-600 OTP session JSON; only smoke reads them. |
| `GOBLIN_BETTER_AUTH_SECRET` | Better Auth's secret. |
| `GOBLIN_MODEL_BASE_URL`, `GOBLIN_MODEL_ID`, `GOBLIN_MODEL_KEY` | Optional, all three or none: the deployment's own model endpoint (dev and prod: Railway LiteLLM and the dedicated capped key, never the master key). Without them each owner brings their own in Settings, and until they do every model call is refused with `NoModelEndpoint` (ADR 0064). |
| `GOBLIN_MODELS` | More LiteLLM model names users may pick, comma-separated; `GOBLIN_MODEL_ID` stays the default. Allow each on the LiteLLM key too. |
| `GOBLIN_DAILY_TOKEN_CAP` | The most model tokens one account may use in a UTC day, a positive whole number; unset or anything else, no cap (ADR 0058). Once a capped day is spent, model calls are refused until 00:00 UTC. |
| `GOBLIN_MEMORY_MODEL` | The offered model for thread names, Topic Conversation memory summaries and skill-draft decisions. It is not selected by price; unset or not offered uses the default. |
| `GOBLIN_SMOKE_MODEL` | Optional model for smoke turns. It must be one of the offered models; unset keeps the owner's pick. |
| `GOBLIN_MCP_SERVERS` | JSON list of outbound servers every account starts with (`[]` for none): `[{"connectionId":"notes","endpoint":"https://mcp.example.com/mcp","label":"Notes"}]`. Each owner still signs in, and grants start empty; nothing in code depends on which servers they are (ADR 0063). |
| `GOBLIN_MCP_SHELF` | Optional JSON list of shelf entries (`id`, `title`, `description`, `endpoint`, `group`, `signIn`): one with the id of goblin's own entry replaces it, the others are added after (ADR 0061). Unset, the shelf is goblin's. |
| `GOBLIN_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP credentials and Events secrets/envelopes; derives purpose-separated hook tokens. |
| `GOBLIN_LARGE_FILES`, `GOBLIN_AGENT_APPS`, `GOBLIN_FLOWS` | Optional bindings, each on unless `off` (ADR 0064): the `FILES` bucket (without it files up to 128 KiB stay in the agent and larger ones are refused), the `LOADER` for agent apps and `code_run` (without it the agent has no app tools and Apps no Built for you), the `FLOWS` dataset (without it no flow metrics). Dev and prod keep all three. |

These are source defaults and configuration names; active dev settings and provider caps must be verified separately.

```sh
bun run plan:dev                          # preview; CI deploys every push to dev that passes Check
GOBLIN_BREAK_GLASS=1 bun run deploy:dev   # deploy by hand: break-glass only, with CI's deploys paused
GOBLIN_BREAK_GLASS=1 bun run destroy:dev -- --confirm-reset    # erase every account, conversation and MCP credential
GOBLIN_BREAK_GLASS=1 GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset   # the same on prod, at an owner reset
bun run smoke:dev                         # acceptance; see scripts/README.md
```

Changing `GOBLIN_CREDENTIAL_KEY` makes stored MCP credentials and Events secrets unreadable and changes the hook
tokens; reconnect the servers, confirm Sources and configure Notify me via afterwards.
Changing a server's `endpoint` drops what was stored for it (credentials, grants, pending sign-ins) at each
agent's next start; connect it again. Tokens are never carried from one host to another.

## Reset dev

Dev contains disposable test data. A reset erases its accounts, sessions, conversations, files, routines, grants and
connection credentials. Preserve the setup checklist below and any separately requested exports before starting.
The production stage is independent; the hackathon freeze keeps it at `hackathon-2026-10` until the owner lifts it.

Finish and commit the entire reset release first. Install the root and browser fixture dependencies exactly as CI does
(`bun install --frozen-lockfile`, then the same command in `scripts/fixtures/mcp-app`), and run `heavy bun run check`
on that commit. Use a clean checkout for the release; preserve other agents' working files in their own checkout.
Keep Alchemy pinned to the version shared with myapps. A reset changes only `goblin/dev`; never use Alchemy's
`syncState` on the account's shared state store.

1. Record the release SHA, the current dev Worker version and a checklist of the connections, Sources, notice sink,
   model choice and routines to recreate. Keep account details and tokens in private notes or mode-600 files. Notify
   the owners of test routines affected by the reset through the agreed coordination channel.
2. Pause automatic delivery with `gh workflow disable ci.yml --repo grmkris/goblin`. Inspect the workflow runs and
   wait for any active Deploy dev job to finish; disabling the workflow does not stop one already running. Ensure
   no other operator is deploying or destroying the stage. Keep the reset commit local until recreation succeeds.
3. Check the stage's mode-600 `.local/dev.env`, `.local/cloud.env` and state-store credentials without printing them.
   Keep signup invite-only or closed, with a working path for the operator to create the replacement smoke account.
   Run `bun run plan:dev` and verify the target is the dev stack.
4. From the checked commit, run `GOBLIN_BREAK_GLASS=1 bun run destroy:dev -- --confirm-reset`, then
   `GOBLIN_BREAK_GLASS=1 bun run deploy:dev`. Both commands must succeed. If recreation fails, keep CI paused and
   investigate the failed resource before retrying; do not copy or delete unrelated stacks' state.
5. Check `/health` and the served build SHA. Create the operator account through the real sign-up and one-time-code
   flow, then save its session as `.local/dev-session.json` with mode 600. The old session is invalid. Set
   `GOBLIN_OWNER_EMAIL` and `GOBLIN_SMOKE_SESSION_FILE` in the private dev configuration, and update the GitHub
   environment secret without echoing it:
   `gh secret set GOBLIN_SMOKE_SESSION --repo grmkris/goblin --env dev < .local/dev-session.json`.
   Update `GOBLIN_STAGE_ENV` through the same file-input mechanism if its configuration changed.
6. Run authenticated `bun run smoke:dev` and `bun run drift:dev`. Reconnect and grant any services required by the
   smoke, or record their explicit skips. Smoke's model calls require a configured endpoint. A public health check
   alone is not authenticated acceptance.
7. Re-enable `ci.yml` with `gh workflow enable ci.yml --repo grmkris/goblin`, then push the checked dev commit. CI must
   pass Check and Deploy dev for that exact SHA. Its `dev-acceptance` receipt must name that SHA and live Worker
   version, authenticated smoke, verified drift and the migration filenames present in `apps/runtime/migrations`.
   Re-enabling a workflow does not replay a push made while it was disabled.

Recreate the owner's setup in a separate attended session: sign in, reconnect MySI, review the exact tools and Events
granted, confirm the Source's owner rule, key/title/read/reply mappings and routing, and configure Notify me via with
its result rules. Then exercise DM, group, photo, outbound file and routine-copy delivery. Record local tests,
deployed smoke and these live checks separately. The code and reset release can finish before that live session;
until it runs, real provider and Telegram delivery remain unverified.

## Using it

- **Tool details.** Open a tool line in a conversation to inspect Input and Output. JSON branches fold, long strings
  offer Show more, and large arrays load 50 items at a time. Markdown output opens formatted. Tree or Formatted and
  Raw switch the presentation; Copy keeps the full original input or output. Plain-text results remain readable. This also works on existing conversation history.
- **Add a server.** Connections → Add a server. **Suggested** adds and connects one of ours in one tap. **Search**
  searches the MCP registries; add your own under Registries searched. **By address** takes any MCP address (public
  https only). Servers without sign-in connect directly; the suggestions mark DeepWiki, Context7 and Cloudflare Docs
  this way. Remove, in a server's ··· menu, asks first and takes its sign-in and grants with it. To suggest another server, check that it connects from a Worker,
  then add it to `apps/runtime/src/mcp/servers/shelf.ts` with its endpoint for each stage.
- **Connect a server.** Connections → Connect. You sign in at the remote server and approve; you come back
  connected. Servers that answer without sign-in connect directly. Then turn on the tools the agent may use, one by one
  or with Allow all; None turns them all off. Both bulk actions save in one request; Allow all preserves existing Ask
  first policies. Nothing is granted by default. A server marked **Needs sign-in** needs a
  new sign-in: press Sign in again. **Try a tool**, at the bottom, calls an allowed tool by hand.
- **Queued messages.** While Main or an ordinary thread is working, Send adds a follow-up. Queued messages appear
  above the composer in the channel and in the thread panel with expandable text, files, references and authors. They enter the transcript
  only when Pi starts them. Reload or reconnect to restore the queue; a failed content read retains the last view and
  retries. An idle conversation with pending inputs does not say Ready. Helpers and routine runs use their existing flows.
  Remove withdraws one waiting message without stopping active work. If Pi has already started it, the message keeps
  running and the UI says so. Failed removals keep the row visible for retry.
- **The sidebar.** One moss column on every page: Jump to (⌘K), Activity, Work and Apps; your pins; the Topics with
  their live threads and All threads; Connections, Personas, Settings and Account (Sign out) at its foot. One row
  shows where you are. ⌘B (Ctrl+B) or its button collapses it to a strip of icons, remembered in this browser; on a
  phone it is a drawer from the top bar's button, which shows a dot while Activity has something.
- **Conversations.** Each Topic is a channel in the sidebar; Personal's is Main (`/c/1`), and goblin's mark opens
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
  create the Topic, from the Topic menu's "Topic setup…" or from the button beside the composer, which reads
  what a narrowed setup holds. Settings shows main's remembered-message count; see the architecture for memory and `zoom`.
- **All threads, Activity, Work and Personas.** All threads lists every thread, unread first; Activity what needs you
  (with Undo for what Goblin organized); Work what runs (Delegates, Personas answering), your routines with their
  controls, every agent app's schedules and recent results. Personas lists them; a click opens a profile: edit it
  (each save is a revision), archive it, or read its revisions. **Add persona** makes one.
- **Apps, Pinned and an App full screen.** Apps lists your pins, the recent App views from your chats, every
  connection with its own App (Reconnect when signed out) and the apps goblin built for you (Open, or Manage). Pinned,
  in the sidebar and at the top of Apps, lists only what you pinned, in your order, on every device; a pin that does
  not open says why. Pin to sidebar is in Apps, a server card's menu, an App page's menu and the bar above an App in a
  chat; a row's own menu moves it or unpins it. A pinned server opens its App in its own thread (listed under All
  threads). On an App's page goblin's composer stays at the bottom: a reply
  shows as one line over it, and a tap opens the conversation beside the App (a sheet on a phone).
- **Threads from the composer, Personas and sources.** The composer's thread button (or `/new-thread`) makes the next
  send start a thread; × goes back with the draft kept. On a server with Move, a message of yours in a channel offers
  Move to thread in its toolbar. With Personas, `@` offers them; tag two or more and choose Together or In turn.
  A strip under an answer that used other chats opens to each source.
- **Questions, models and usage.** Answer an `ask_user` card with your next message. Pick an offered model in the
  composer; Settings shows today's tokens, and the composer's ring the share of the daily token cap used (or, without
  a cap, how full the context is), resetting at 00:00 UTC.
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
- **mysi.** The shelf's first suggestion is one mysi connection for the owner's own apps (MyPlan, MyTab, MyGram,
  MyInbox, MySkills, MyTmux): `https://mysi.lol/mcp?codemode=off` (`apps/runtime/src/mcp/servers/shelf.ts`, ADRs 0052 and
  0061). goblin's own dev and prod both use production mysi, so goblin is tested against mysi's stable release (ADR
  0075); a deployment that does need mysi's dev sets `GOBLIN_MCP_SHELF` to point the `mysi` entry at `dev.mysi.lol`. mysi is a product of its own with a free tier; the
  owner signs up there and chooses which apps the connection reaches on mysi's consent page. Its tools are
  `<service>_<tool>` (`mygram_inbox_read`), so ask the agent for one app's tools ("list my myplan tools") and it calls
  `mcp_list` with `service`. A connection made to plain `/mcp` counts as added, but lists the code tools instead.
- **Skills.** Connect a server that offers skills, then turn on its **Use its skills** switch. The agent reads and
  follows those procedures; their tools still need grants. While skills are on for some server, a correction or a
  request to keep how something was done may become a draft in your files, `/agent/skills/drafts/<name>.md`, with a
  notice in the chat; what becomes of it is yours.
- **Mygram through a Source.** Connect MySI with Mygram included and the required chat access, or Mygram directly.
  Ask goblin to propose a Source from the connected event and tool schemas. Review the exact event selector, cursor
  read, message keys, incoming direction, owner rule, title/attachment pointers, reply template and new-conversation
  route on the Source card, then confirm its revision. Route held conversations in Connections → Sources or Activity.
  The same path handles DMs, groups and forum topics; no built-in Telegram switch or hard-coded tool names remain.
  Configure **Notify me via** separately for routine copies and app notifications, reviewing its result and echo rules.
  Real MySI authorization and Telegram DM/group/photo acceptance remain the separate owner session described below.
- **Resident authority.** Settings → Your agent → **Work while you're away** shows it and when it expires. Owner
  activity renews it for 30 days; inbound and scheduled work do not renew it. Turning it off stops all outbound MCP
  use by the agent until you turn it on again.
- **Routines.** Work → Routines → New routine: what it does, when it runs (once at a time you pick, on a cron
  schedule, or on a server's event) and the tools and limits it may use. Saving makes a proposal; Confirm on its card
  turns it on, and an edit pauses it until you confirm again. The agent can also propose one in chat.
- **MyPlan as an App.** Connect mysi with MyPlan included (or MyPlan's own `https://dev.myplan.lol/mcp` by address), then switch
  on the App's group (named after its `ui://` resource) above the tools it uses. Ask the agent to open a note ("Open
  my Trip plan note"); the App opens in place under the tool row (on an older call, open the row and press *Show app*). Its bar
  opens it as a page beside the conversation or closes it; on the page, the pill's menu brings it back, fills the
  workspace or closes it. Several Apps run at once, in any conversation; beyond six the least recently seen unloads to
  a stub. These moves keep the same iframe and bridge. What an App shares rides along with your next message in its conversation as untrusted
  context; links it offers wait for your click. The originating server supplies the resource URI and the App's
  behavior. Apps open in their conversations or as pages.
  A MyPlan question App saves the answer in MyPlan, then offers a bounded saved-answer receipt through
  `ui/message`. Goblin shows **Continue** and **Dismiss** in its own chrome. Only the owner's Continue click
  submits a fixed message with the receipt as untrusted App context in the originating conversation; it sends no
  answer text or capability. Retry and reload reuse the same submission operation. Dismiss leaves the answer saved.
  Local host acceptance: `heavy bun apps/web/test/ui-message.ts` covers save, stage, Continue, retry, reload and
  Dismiss with fixture tool replies; it does not prove authenticated MyPlan acceptance or a deployed release.
- **MyInbox.** Connect mysi with MyInbox included (or MyInbox's own `https://myinbox.lol/mcp` by address). Public
  metadata advertises DCR, PKCE S256 and public clients; this does not prove a signed-in connection. The owner asks
  “Show my inbox in an app” and allows the app power card. The agent uses the exact
  connected tool schema/server id, the `app_docs` `examples` pattern, and a 15-minute refresh schedule.
- **Add goblin to Claude Code.**

  ```sh
  claude mcp add --transport http goblin https://dev.goblin.surf/mcp
  ```

  Sign in and approve in the browser. It gets `ask_agent` and `get_recent_messages` in the agent's main conversation,
  with its messages labelled by client name, and, if you turn on "Also let it read your conversations and runs" on
  the consent page (it starts off), the read-only inspection tools (ADR 0024). Revoke it under Settings → Connected clients. A connection made before inspection joined `/mcp`
  gets those tools after reconnecting once (in Claude Code: `/mcp` → goblin → Clear authentication).
- **Inspect your agent from a coding agent.** Start with `inspect_problems` or `inspect_turns`, then `inspect_turn`
  with an operation id (a Source message is `source-<source>-<message>`), then `inspect_conversation` for the words.
  `inspect_flows` shows how conversations moved (sends, replies, thread starts, moves, Personas, Delegates) and
  `inspect_details` the operation behind a message. Reading never calls a model; `ask_agent` does.
- **The `goblin` CLI** (`apps/cli`) is the same from a terminal: an MCP client of `/mcp` that asks for
  `goblin:inspect`, whose commands come from the server's tools.

  ```sh
  export GOBLIN_ORIGIN=https://dev.goblin.surf   # which goblin: required, there is no default
  bun run goblin login                  # once: prints the sign-in URL; approve in a browser
  bun run goblin problems --since 6h
  bun run goblin problems --all --since 6h # expected waits and recovered model attempts too
  bun run goblin turns
  bun run goblin turn <operation-id>     # one turn end to end
  bun run goblin conversation 1         # main's entries, in full
  bun run goblin flows --chat 12        # how a chat's conversation moved, content-free
  bun run goblin details --operation <id> # what happened behind one message, and its related operations
  bun run goblin logs <operation-id>     # Workers Logs lines that mention an id
  bun run goblin lookup 7f3a9c12        # a reference the app showed: its log lines, then its operation's details
  bun run goblin stats --since 24h      # flow totals across every agent of the stage (Analytics Engine)
  ```

  Problems filter expected authority waits and confirmed automatic model retries before applying the limit. They keep
  unresolved tool failures, cutoffs, empty final answers and coverage gaps. `inspect_problems` and `diagnose` take
  `all: true` for the full retained problem history; a turn's timeline always includes every recorded event. Private
  errors and tool payloads stay in `inspect_conversation`; telemetry summaries are fixed host codes. Old ledger reads
  are sanitized too. Successful background model calls, including bounded memory completions ending in `length`,
  are excluded from both problem views; actual background failures remain. These changes need no schema migration.

  `--origin` (or `GOBLIN_ORIGIN`) names the deployment and is required: there is no default (ADR 0064); goblin's own
  daily instance is `https://dev.goblin.surf`, the local stack `http://localhost:18971`. Credentials live in
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
  release that edits an applied one resets dev first (`GOBLIN_BREAK_GLASS=1 bun run destroy:dev -- --confirm-reset`, then
  `GOBLIN_BREAK_GLASS=1 bun run deploy:dev` re-creates it, since CI refuses a plan that creates goblinAuth); a new table or column
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
- UI components: goblin looks like the myapps apps. Prefer porting a component from the myapps checkout's `packages/ui`
  (with an "Adapted from" header naming the commit); otherwise `bunx shadcn@latest add <component>` from
  `packages/ui`, then review the generated file. Keep the shared tokens in `packages/ui/src/styles.css` as myapps has
  them (the shell's `--shell-*` and `--moss` tokens are goblin's: the moss sidebar beside the off-white page). Motion uses the theme's curves (`ease-out`,
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
only after Cloudflare Email Sending verifies the sender. A deploy needs mail, an OpenID Connect provider or both
(ADR 0064); goblin's own dev and prod use mail, and dev must stay closed or invite-only. These settings do not
authorize a production deploy.

`GOBLIN_CONFIRM_PROD=1 bun run plan:prod` previews, and the same explicit guard protects `deploy:prod` and
`smoke:prod`; a `deploy:prod` outside CI is also break-glass (`GOBLIN_BREAK_GLASS=1`). The default prod smoke is read-only: health and an anonymous protected-route probe. An operator smoke
account's mode-600 OTP session file opts into the full flow. MCP clients authorize against the stage's origin.

There are two branches: `dev` (the default; every change lands here) deploys to `dev.goblin.surf`, and `prod` to
`goblin.surf`. One workflow, `.github/workflows/ci.yml`,
runs on GitHub-hosted runners. Check runs on every push and pull request. A push to `dev` that passes Check runs Deploy
dev: `scripts/release.py dev` requires that exact dev tip and its passing Check, plans without a delete, replace or
re-create of goblinAuth, Files or Web, deploys, and verifies authenticated smoke, drift and the D1 migration inventory.
The smoke runs up to three times, four minutes apart: right after a deploy the agents' Durable Objects still run the
old code for some minutes.
Its sanitized receipt is the run's `dev-acceptance` artifact. A superseded dev commit cannot deploy.

Promote with `bun run promote <full-sha>` from any checkout with `gh` signed in and `.local/cloud.env`. It deploys nothing:
it requires that SHA's dev Check, its `dev-acceptance` receipt (authenticated, at the live dev Worker version) and a
fast-forward, then moves `prod`. That push runs Deploy prod, which repeats those checks, refuses a forced push, and
releases goblin prod.
Destructive plans still require a separate explicit reset decision.

Alchemy state for dev and prod lives in the account's shared Cloudflare state store (`scripts/alchemy-state.ts`), the
`alchemy-state-store` Worker myapps also uses; every other stage keeps local `.alchemy/state`. The store has no lock, so
each stage deploys in one non-cancelling CI concurrency group, and `deploy:*` or `destroy:*` on dev or prod anywhere else
refuses unless `GOBLIN_BREAK_GLASS=1`: the break-glass path from the build box, with CI's deploys paused first. `plan:*`,
`drift:*` and `smoke:*` run anywhere.

`grmkris/goblin` is the public source: its branches, history, Issues, workflow logs and artifacts are public. Stage
secrets are GitHub environment secrets behind branch policies (`dev` for the dev branch, `prod` for prod), masked in
the logs before use; pull requests run only Check and never reach them. See
[ADR 0046](adr/0046-production-promotion-and-public-source.md).

For the first production bootstrap, an operator supplies `GOBLIN_OWNER_EMAIL` and `GOBLIN_SIGNUP_INVITE_CODE` in the
mode-600 prod environment, signs in through the real email OTP flow, and records the resulting mode-600
`prod-session.json`.

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

`heavy bun apps/web/test/ui-navigation.ts` renders the real sidebar (ADR 0078) over a populated workspace in local
Chromium, desktop and phone, light and dark: one highlighted row per page (a thread, a pinned App, an unpinned App under
Apps, a profile under Personas), the counts, every pin state, the strip with ⌘B/Ctrl+B, its tooltip, a reload that keeps
it and the Topics list beside its `#`, and the phone's dot and drawer. `heavy bun apps/web/test/ui-apps.ts` renders
Apps: the four sections in order, pins that do not open keeping their place, two accounts on one service, search by
label, a closed view reopened in one step, a failed built-app read kept to its section and the ⋯ targets.
`heavy bun apps/web/test/ui-jump.ts` opens Jump to with ⌘K/Ctrl+K and its row, moves with the arrows, opens a thread
and a section, and closes with Escape, returning focus. Screenshots go under `.local/goblin-acceptance/`; these are
browser fixture evidence only.

`heavy bun apps/web/test/ui-events.ts` renders a connection's Events (ADR 0041, ADR 0068) from source in local Chromium
at desktop and phone widths, light and dark: the open offer, the picker with the events' titles and descriptions grouped
by service, nothing picked until the owner picks it, an event with an existing subscription, a filter the server requires
asked for in Advanced, a hand-over to a Persona, and both events set up in one step (each proposed, then confirmed), with the owner
API routed in the page and the proposals it receives checked. Screenshots go under
`.local/goblin-acceptance/events-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-holds.ts` renders the MCP 2026 owner cards (ADR 0042) from source in local Chromium at
desktop and phone widths, light and dark: a URL request on the connection's own host and one elsewhere (flagged), its
Open link (a new tab, never followed by the page), Done while the server still waits and Done once it answers, Cancel,
and the step-up card's sign-in link and Continue, with the owner API routed in the page. Screenshots go under
`.local/goblin-acceptance/holds-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-start.ts` renders first-run Start (ADR 0062) from source in local Chromium at phone (light)
and desktop (dark) widths: the splash, the welcome, the model step on the deployment's models and on the owner's own,
services before and after a server connects (Use suggested access offered, then in place) and the kickoff, with the
owner API routed in the page and no screen scrolling sideways. It needs `@goblin/app`'s runtime built (its own `build` script). Screenshots go under
`.local/goblin-acceptance/start-*`; this is browser fixture evidence only.

`heavy bun apps/web/test/ui-landing.ts [--out <dir>]` renders goblin's landing (`/`, signed out) from source in local
Chromium at phone and desktop widths, light and dark: the hero's session playing, waiting on its question, answered by
Allow and on its own, and the whole page; under reduced motion the session starts at its question and Allow still
answers it. With `/health` and the session check routed in the page, it checks the way in (`/login?new=1`), Claude
Code's command for the page's origin, that the Source link stays off, that a signed-in session leaves for its channel,
and that nothing scrolls sideways. Screenshots go under `.local/goblin-acceptance/landing-*`; this is browser fixture
evidence only.

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
producer or external message send is involved. To run just that case, use
`GOBLIN_HARNESS_PORT=18871 heavy bun run test:integration native.test.ts -t 'signed routine Events'`.

For local acceptance, start a separate `bun dev` stack with isolated Alchemy/D1/DO state, a throwaway account and no
mail. Through the authenticated API/UI, confirm a near-future reminder, observe one completed run and passive main note,
confirm a cron occurrence, restart the local process before it fires, then verify firing and next occurrence. Revoke
resident authority and confirm a reminder yields a visible skip without token usage; check active/running and run/day
token caps. Save redacted logs and screenshots. Local CLIProxy provider evidence is distinct from Railway LiteLLM and
retained dev. LOCAL throwaway-account receipts verify reminder dedupe/passive acceptance, retained cron firing and rearm
across restart, revoked-authority skip with unchanged usage, active/running caps and run/day token blocking using
CLIProxy. The native recurring-wake regression verifies the next sweep survives the callback that scheduled it. External message
delivery, cron-after-deploy and real producer acceptance require separate deployed verification.

## Main and the inbox example

Check Main with an empty transcript and existing history at desktop and phone widths: the composer remains reachable and the latest exchange is the landing point. Apps open in their tool rows or as their own pages; moving between page and chat preserves the single iframe and action bridge. Installed iPhone behavior remains an owner device check.

The no-auth inbox fixture builds the `app_docs` example in Dynamic Workers and drives the native job callback through 15-minute slots. It checks newest-five validation, freshness and last-good retention after an invalid response. Run it from `apps/runtime` with `heavy bun run test:integration test/integration/inbox.test.ts`. Real MyInbox sign-in, app-power approval and message freshness on dev are separate owner steps.

### Notify sink acceptance

Notify me via's delivery rules and echo selector are owner-reviewed settings (ADR 0071). The runtime unit tests
`sources-notify.test.ts`, `sink-result.test.ts`, `notices/copies.test.ts` and `app-powers.test.ts` cover same-second
revisions, result predicates, unknown outcomes and shared connections. The local native routine-notifications case
exercises frozen notice retries through the MCP host; `bun apps/web/test/ui-sources.ts` checks Settings at desktop and
390px phone widths. These checks do not prove a deployed provider delivered a message.

### Deferred MySI and Mygram live acceptance

Code completion and local fixtures do not close this gate. After the dev reset, schedule a 15–30 minute owner session:

1. Sign in to Goblin dev, configure its model endpoint if needed, reconnect MySI and authorize Mygram with the intended
   DM/group/topic access. Keep credentials and personal identifiers out of committed evidence.
2. Propose and review the Source against the live schemas, including owner identity, incoming direction, chat/thread
   keys, cursor read, titles, attachments and reply arguments. Confirm the exact revision and desired routes.
3. Send a DM, a group message and a photo; verify the routed Topic, the owner-turn mark, kept attachment and reply back
   to the same place. Include a non-owner message and replay to confirm their distinct behavior.
4. Configure Notify me via with the live structured-result mapping and exact echo selector. Verify a routine copy,
   an unrelated event on the same MySI connection, and a sink save invalidating an old pending copy.
5. Retain redacted operation ids and received-message evidence. Record model acceptance, MCP acceptance and actual
   external receipt separately. Any missing access or unavailable producer remains an open acceptance item.


Source reply outcome rules (ADR 0072) are covered by `sources-replies.test.ts`, `sources-engine.test.ts` and
`sources-program.test.ts`: frozen calls, per-piece progress, explicit retryability, uncertainty, reconstruction,
waiting limits and revision review. The native `source-reply-outcomes` canary carries accepted/retryable/rejected/unknown
structured results through the MCP host and verifies a stable retry. The Source browser walk edits result rules,
requires a new confirmation and copies those rules into Notify me via at desktop and 390px widths. These are local
proofs; reconnecting MySI, confirming the deployed Source and Telegram DM/group/photo checks remain live acceptance.

## Interactive reply checks

`heavy bun apps/web/test/ui-openui.ts` exercises native Markdown rendering and the real conversation submission hook
against intercepted HTTP: field values, keyboard submit, pending state and returning focus, failed-send retry
identity, conversation routing, disabled quoted/closed replies, streaming and invalid fallback, Enter beside several
buttons, wrapped long labels, typed number ranges, light/dark and 390px layout. It uses local
Chromium and does not call a model or prove authenticated deployment behavior. The public playground uses the same
renderer and has its own built/deployed browser check documented in its README. `check:patches` verifies the OpenUI
inspector patch in both normal gates; review it when upgrading the dependency.
