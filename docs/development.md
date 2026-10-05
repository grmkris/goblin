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

Dev (`https://dev.purrable.lol`) is the daily instance. Its configuration is `.local/dev.env`
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
| `PURRABLE_MODEL_DAILY_TOKENS` | Local native model fixture allowance only; deployed accounts use their plan/override. |
| `PURRABLE_MODEL_TOKEN_WEIGHTS` | JSON model-id to positive price multiplier; omitted models count at one. |
| `PURRABLE_MEMORY_MODEL` | The offered model for thread names, main-memory summaries and skill-draft decisions. It is not selected by price; unset or not offered uses the default. |
| `PURRABLE_SMOKE_MODEL` | Optional model for smoke turns. It must be one of the offered models; unset keeps the owner's pick. |
| `PURRABLE_MCP_SERVERS` | JSON list of outbound servers: `[{"serverId":"myplan","endpoint":"https://…/mcp"}]`. |
| `PURRABLE_CREDENTIAL_KEY` | 32 random bytes, base64 (`openssl rand -base64 32`). Encrypts outbound MCP credentials, Events secrets/envelopes and the legacy doorbell secret; derives purpose-separated hook tokens. |

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
- **Conversations.** Each conversation is a pane; the URL (`/c/<id>`) names the focused one and `/` restores your
  last arrangement. Click a conversation in the sidebar to show it in the focused pane. The **+** beside Threads opens
  a new thread's draft beside it, and **Reply in thread** under any settled message, in any conversation, opens a
  reply draft beside that conversation; sending starts the thread (empty, or from that message), so an unsent draft
  leaves nothing behind. The conversation then shows the thread under that message with a connector and the first
  five messages in an expanded preview (collapse is saved on your device), and a second Reply there opens the same
  thread. Drag a pane by the grip in its pill onto another pane: near an edge it splits there, in the middle the two
  trade places (Escape cancels). Drag a divider to resize, **Fill the workspace** in the pill's menu to show one pane
  alone, and × to close a pane (any but the last; the conversation goes on). The device remembers the arrangement;
  narrow screens show one pane at a time, swipe between them. The sidebar lists every conversation as a tree
  (subagents under who started them, threads under where they branched); hover a row for **Open beside**, or drag a
  row onto a pane. ⌘/Ctrl+B folds it to a rail of the active ones; rest on an icon to see what it is. A dot marks
  unread replies on every device until a pane shows them. **Share to …** asks the thread to
  write a note into the conversation it came from; it starts no answer there. Rename and Close are in the thread menu;
  Close stops the thread and everything under it (its subagents and nested threads) and keeps its history, and Reopen
  brings it back. Subagents appear under the conversation that started them. The sliders button by the composer shows
  what the agent can use in that conversation (connections and their tools, skills, subagents); switching something
  off there hides it from the agent in that conversation only, and a new thread starts with the switches of the conversation it came from. Settings shows main's remembered-message count; see the architecture for memory and `zoom`.
- **Questions, models and budget.** Answer an `ask_user` card with your next message. Pick an offered model in the
  composer; Settings and the composer's ring show today's token usage, resetting at 00:00 UTC.
- **Skills.** Connect a server that offers skills, then turn on **Use skills from this server**. The agent reads and
  follows those procedures; their tools still need grants. To receive drafts in a library such as MySkills, grant
  `skill_draft` and `skill_draft_status`, then review the proposals there.
- **Telegram.** Bind the authorized mygram connection to the bot, then choose **Use for Telegram**. A server offering
  Events grants `inbox`, `send_message` and its two exact event selectors; older servers use the four-tool doorbell
  fallback. Connections shows which transport is active. New inbox messages arrive in main as **Telegram**, including
  answers to pending questions, and replies go back to the bot. **Stop** unsubscribes and clears pending replies.
- **Resident authority.** Settings shows when it expires. Owner activity renews it for 30 days; inbound and scheduled
  work do not renew it. Revoke stops all outbound MCP use by the agent until you enable it again.
- **MyPlan as an App.** The suggested MyPlan server uses `https://dev-new.myplan.lol/mcp` on local and dev
  (`apps/runtime/src/mcp/suggested.ts`); `PURRABLE_MCP_SERVERS` may configure another endpoint. Connect it, then switch
  on **Allow app** under its discovered `ui://` resource group. Ask the agent to open a note ("Open my Trip plan
  note"), then press *Show app* on the resulting tool row. On wide screens it opens in a pane beside the
  conversation: drag its grip to move it and a divider to resize it, and × closes the App. Its chrome opens fullscreen
  and returns to the pane; narrow screens use the App sheet. These moves keep the same iframe and bridge. What the panel shares rides along with your next message as untrusted
  context; links it offers wait for your click. The originating server supplies the resource URI and the panel's
  behavior.
- **Add Purrable to Claude Code.**

  ```sh
  claude mcp add --transport http purrable https://dev.purrable.lol/mcp
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


## Production preparation

`.local/prod.env` is mode 600, with fresh auth and credential secrets. Fill its model key with a dedicated Railway
LiteLLM virtual key; never the master key. Set `PURRABLE_DOMAIN=purrable.lol` and
`PURRABLE_APP_URL=https://purrable.lol`; dev uses `dev.purrable.lol` for both. Set `PURRABLE_MAIL_SENDER=hello@purrable.lol`
only after Cloudflare Email Sending verifies the sender. Prod open sign-up requires mail; dev must stay closed or
invite-only. These settings do not authorize a production deploy.

`PURRABLE_CONFIRM_PROD=1 bun run plan:prod` previews, and the same explicit guard protects `deploy:prod` and
`smoke:prod`. The default prod smoke is read-only: health and an anonymous protected-route probe. An operator smoke
account's credentials opt into the full flow. After dev's origin changes, sign in by email code and register new
passkeys; reconnect MCP clients at the new origins.

## Billing development and acceptance

Set `DODO_PAYMENTS_ENVIRONMENT=test_mode` on local/dev and `live_mode` on prod. Store
`DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY` and `DODO_PRODUCT_ID` in the stage's mode-600 env file; Alchemy
binds them as Worker secrets. Choose a Purrable-only recurring $10/month product with no trial. Never bind an account's
master model key or print payment keys. Configure a separate Standard Webhooks endpoint at `/hooks/dodo` per stage.
`/health` reports the stage billing mode and whether billing is configured; missing keys never bypass admission.

The additive billing migration grants users already in D1 a dev-only Pro override. It grants nothing on prod or for
new signups. An operator can insert/update `app_billing_accounts` for a known user ID, setting `plan_override='pro'`,
`override_stage` to the intended stage, `daily_tokens` to a positive allowance and both timestamps in milliseconds.
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

The model price schedule is not fixed by source; configure reviewed positive multipliers in
`PURRABLE_MODEL_TOKEN_WEIGHTS`. Local tests prove weighted counting and separate ledgers, not active provider prices.
Before prod payments, review the draft legal pages and provide operator identity, support/postal address, jurisdiction,
refund/withdrawal policy and retention/subprocessor details. Cancel recurring billing through Dodo before account
deletion; deletion does not itself cancel provider charges.

## Account workspace tests

Members routing uses a separate local workerd/D1 fixture on `PURRABLE_HARNESS_PORT + 20`. Run
`bun run --cwd apps/runtime test:integration test/integration/members.test.ts` through `heavy`. The tests prove
stable ordinary-owner routing and selection fences, invitation-only accounts without personal fallback, email-bound
OTP admission, paid/concurrent acceptance, replay after removal, rotated/expired proofs, malicious leave payloads,
closed member/viewer RPCs and owner deletion failure/retry. They capture injected mail, use no provider keys, and do
not prove real mail delivery or Phase B shared execution. Browser acceptance uses an intercepted local fixture
for empty permission choices, exact member/viewer invitations, selection teardown, unpaid leave, fragment clearing,
OTP sign-in and subscribe-return-join navigation. It does not prove real Dodo checkout or invitation delivery.

The native fixture also counts workspace D1 queries after authentication: established browser/owner resolution
uses one live read and zero writes while retaining invitation, stale-context, revocation and deletion fences.
It invokes the actual scheduled Worker entry point without Dodo and verifies bounded expiry cleanup, retained
unexpired active/used admissions, current hourly counters and repeated sweeps. Cleanup adds only indexes through
the auth D1 migration; it runs hourly and drains at most 1000 rows from each expiry table per tick.

## Routine definition checks

From `apps/runtime`, run `heavy bun run test:unit test/routines-time.test.ts test/routines-summary.test.ts` for IANA
zones, DST, cron spacing, explicit reminder offsets, strict write CSRF and summary scrubbing. Run
`PURRABLE_HARNESS_PORT=18871 heavy bun run test:integration native.test.ts -t routine` for real local workerd SQLite,
native dated alarms, Pi run/session/report dedupe, no copied capabilities, committed usage, revoked-authority skips,
correlated questions, late answers, main Stop, two-running cap, burst collapse, archive and revision fencing. These
keyless fixture tests establish local behavior. The signed routine Events case shares the native stack and official
fixture producer: exact descriptor filters, raw signatures, shared leases, escaped run IDs, replay across revisions,
sealed metadata, one event/minute, pending coalescing, gap/poll recovery and termination/reconfirmation. No live MCP
producer or Telegram send is involved. To run just that case, use
`PURRABLE_HARNESS_PORT=18871 heavy bun run test:integration native.test.ts -t 'signed routine Events'`.

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

The Members Phase B checkpoint uses `MEMBER_EXECUTION_ENABLED=1` only in its isolated native fixture. Deployed
Workers stay closed until the separate enablement change passes review. Fixture tests exercise filtered principal
contexts with the scripted model and actual auth D1. No production sign-up, mail, provider or payment calls are
part of these checks. The additive auth migration projects member usage account-wide; DO application metadata
stores context provenance, named readers, sealed interaction decisions and the passive projection outbox.
