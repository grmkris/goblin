# Operator scripts

Deployment scripts use Alchemy only. Secrets are read from mode-600 files under `.local/` and are never printed.

| Command                                                                                            | What it does                                                                                          |
| -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `bun dev`                                                                                          | Local stack on `http://localhost:18971` (workerd), model calls through CLIProxy.                      |
| `bun run plan:dev`                                                                                 | Preview changes to the dev stage.                                                                     |
| `GOBLIN_BREAK_GLASS=1 bun run deploy:dev`                                                          | Deploy the dev stage (`https://dev.goblin.surf`) by hand; CI normally does (see below).               |
| `GOBLIN_BREAK_GLASS=1 bun run destroy:dev -- --confirm-reset`                                      | Erase the dev stage: every account, conversation and MCP credential.                                  |
| `GOBLIN_BREAK_GLASS=1 GOBLIN_CONFIRM_PROD=1 bun run destroy:prod -- --confirm-reset`               | Erase the prod stage the same way, at a release the owner decided resets it.                          |
| `bun run promote <full-sha>`                                                                       | Pre-flight an accepted dev SHA and fast-forward `prod`; CI then deploys prod.                         |
| `bun scripts/state-copy.ts --stack <stack> --stage <stage>`                                        | One-off copy of a stack's Alchemy state between local files and the Cloudflare store.                 |
| `bun run smoke:dev`                                                                                | Acceptance against the deployed dev stage.                                                            |
| `bun run smoke:local`                                                                              | The same acceptance against the local stack.                                                          |
| `bun run ui:acceptance [session-file]`                                                             | Read-only UI checks and screenshots against dev (see UI acceptance below).                            |
| `bun run icons`                                                                                    | Redraw the app icons and favicon in `apps/web/public` from the shared goblin mark.                    |
| `heavy bun scripts/patch-shadcn-react.ts --test`                                                   | Rebuild the MessageScroller patch from upstream source (`patches/shadcn-react/README.md`).            |
| `GOBLIN_ORIGIN=… GOBLIN_WORKSPACE=… GOBLIN_TOKEN=$(goblin token) bun scripts/agui-client-check.ts` | One turn on a stage with a stock AG-UI `HttpAgent` and a script app's token; prints event types only. |

Stage configuration comes from `.local/<stage>.env` (see `.env.example`); `plan:dev`, `deploy:dev` and `destroy:dev`
also read the Cloudflare credentials in `.local/cloud.env` (mode 600, only `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`; `GOBLIN_CLOUD_ENV_FILE` names another file). Smoke loads only the stage file; its flows check
also reads those two variables when the environment has them. On dev and prod, `deploy:*` and `destroy:*` refuse unless
they run in GitHub Actions or `GOBLIN_BREAK_GLASS=1` is set (`deploy_runs_in_ci_or_GOBLIN_BREAK_GLASS=1`); `plan:*`,
`drift:*` and `smoke:*` run anywhere.

## UI acceptance

`bun run ui:acceptance` opens the stage named by a saved session file (`.local/dev-session.json` unless another
is given; a `http://localhost` session runs it against the local stack) in headless Chromium, as a phone (390×844,
touch), landscape phone (844×390), tablet (820×1180), hybrid pointer device and desktop (1440×900), light and dark,
on `/c/1`, a thread's panel, Threads, Activity, Work, Settings, Connections and Apps. It only taps and clicks what
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
call. It covers editable primitives and composer Return behavior across touch, desktop and hybrid pointers,
failed attachment retry/remove/send blocking, component styles and Thoughts closure under reduced motion,
and conversation-feed render isolation.
Its private receipts and screenshots go under `.local/goblin-acceptance/local-*`.

## Smoke

On dev and prod the smoke signs in as a checks account by emailed code
([ADR 0128](../docs/adr/0128-the-post-deploy-smoke-signs-in-for-real-and-runs-one-model-turn.md)). Through a mysi
trusted workload (the deploy job's GitHub OIDC token exchanged for a 15-minute mysi token, no stored key,
`scripts/smoke-workload.ts`) it takes the account's mailbox cursor with myinbox's `address_cursor`, asks the stage for a
code, reads it with `verification_wait` and signs in (`scripts/smoke-signin.ts`). The session stays in the smoke's
memory; it is never written or logged. It needs `GOBLIN_SMOKE_EMAIL` (the account's address), `GOBLIN_SMOKE_MAILBOX_WORKLOAD`
(the workload policy's client id) and a job with `permissions: id-token: write`; `MYSI_ORIGIN` names another mysi than
`https://mysi.lol`. The stage's `GOBLIN_SIGNUP_INVITE_CODE` goes with the sign-in, so the first deploy after a reset
makes the account again. Without any of them the smoke runs only the public checks and records why in `signIn`:
`skipped: no mailbox access (no test account configured)`, `(no workload configured)` or `(no OIDC token in this job)`.
Outside CI there is no OIDC request, so `smoke:dev` and `smoke:prod` from the box run the public checks.

The public checks: health and the client bundle's build, `/health`'s sign-in methods and sign-up policy, an anonymous
member path refused 401, the internal routes refused, a sign-up without the invite code refused (unless sign-up is
open), the MCP resource metadata, the page, and on prod the canonical `www` redirect.

The local stack has no real mailbox, so `smoke:local` signs in with a saved session: capture one through a real OTP
login (Alchemy's captured `.eml` code), save `{"origin":"http://localhost:18971","cookie":"<session cookie>"}` in a
mode-600 private JSON file, and set `GOBLIN_SMOKE_SESSION_FILE` and `GOBLIN_OWNER_EMAIL` in `.local/local.env`. The
smoke checks that origin and the session's email. Never print or commit the cookie.

Signed in, the smoke makes one model turn by default (ADR 0128; ADR 0106 keeps the others off): it runs steps 1 to 3,
step 4 without its turns (consent, token, `initialize`, the tool list, an inspection read, a read of main's recent
messages, revocation and a 401), then steps 9 and 10. That is what every dev and prod deploy runs. With
`GOBLIN_SMOKE_TURNS=1` it also runs the agent turns in steps 4 to 8, which spend more model tokens and write
conversation history: turns in main, a new side thread and a background subagent. It leaves the account's grants
unchanged and renews resident authority through its own requests. With `GOBLIN_SMOKE_MODEL` set (the stage's cheapest
offered model, `GOBLIN_MODEL_ID` or `GOBLIN_MODELS`), every turn runs on it and the account's own pick is restored in
`finally`, including after a failed step. Unset, turns use the account's pick. Housekeeping still uses
`GOBLIN_MEMORY_MODEL`.

1. health; the deployed client bundle names this checkout's commit (`VITE_GOBLIN_BUILD`, which `scripts/stage.ts`
   sets for every deployed stage, so crash reports name their release; skipped on the local stack); unless sign-up is
   open, a sign-up without the invite code is refused; sign-in, resident authority `active`, a main-thread snapshot;
2. a small text file uploaded to the owner's `/uploads`, listed, read back byte for byte and deleted (ADR 0022); then
   the typed API's edge: an unknown chat answers 404 in the error envelope quoting the response's `x-goblin-ref`, and
   a write without the CSRF header is refused 403;
3. each configured or owner-added MCP server's status; for a connected server, its tools, and a direct call of one
   probe: a tool the owner already allowed to run without asking, that the server says only reads (`readOnlyHint`), that
   the agent may call and that needs no input; a server without one is skipped;
4. an inbound MCP client: dynamic registration, owner consent including `goblin:inspect`, PKCE token, `/mcp`
   `initialize` and `tools/list` with the seven inspection tools (ADR 0086: every `inspect_*` tool, as the owner API's
   caller), an `inspect_problems` read, a model turn sent with `conversation_send` and followed with `conversation_send_status`, an agent turn that calls that probe through `mcp_call` (only if step 3 proved it),
   main's entries (`conversation_entries`) with the smoke client's author label, then revocation and a 401;
5. a new empty thread, a model turn there, `share_back` verified as a new `app.shared` entry in main, then close;
6. a `smokecount` subagent spawned from main and its attributed result posted back in main (a passive Delegate result, ADR 0033; with `synthesize` the report is an input main answers instead);
7. `/api/agent/memory`: a nonzero remembered-message count and the current view coverage;
8. an agent app (`scripts/smoke-apps.ts`): in a new thread the agent builds `smoke-counter` from exact code, the owner
   runs its schedule now and its revision moves by one, then the owner deletes it (typing its name) and the thread
   closes;
9. the integrator paths (`scripts/smoke-integrator.ts`) around the deploy's one turn: a fresh app registered with an
   https return URL; its install through `/api/install/:clientId` (the redirect carries `installation`, `workspace` and
   `state`) and its decline (`error=access_denied`); its `client_credentials` token (Basic auth, `resource=<origin>/mcp`,
   scope `goblin`) reads `/w/<slug>/api/access`, creates and lists a Topic, polls the Topic's Events and opens its
   stream; an MCP client connected by consent sends `Reply with the single word: pong` to that Topic with the Tasks
   extension and follows `tasks/get` to `completed`, after `tasks/get` without the extension is refused (`-32021`); the
   app's stream opened with `MESSAGES_SNAPSHOT` and reached `RUN_FINISHED`, Events saw the turn, and another workspace
   (404), the bare `/api/topics` (404) and `/api/members` (403) are refused. The Topic is archived, the app deleted and
   the client revoked;
10. the smoke's own sends reached the stage's Analytics Engine flows dataset (`goblin-<stage>-flows`, ADR 0037): a
    `send` point since the smoke started, waited for up to two minutes. It reads with the operator's own
    `CLOUDFLARE_API_TOKEN` (Account Analytics read) and `CLOUDFLARE_ACCOUNT_ID` from the environment; without them, or with a token that cannot read Analytics Engine, the receipt says why it was skipped.

Inbound turns run in main as `goblin-smoke`. The threads are archived, the apps deleted and the clients revoked through
`finally` cleanup; their history and the subagent remain. Cleanup requests can themselves fail.

On success the script writes `.local/smoke-<stage>-receipt.json` (mode 600) and prints it. A failure prints its reason
and completed HTTP steps but writes no new receipt; an older file may remain. Receipts contain model/server names,
statuses, counts and booleans, never tokens, cookies or message bodies.

| Receipt field                          | What it checks or records                                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `stage`, `signup`, `resident`, `model` | Target stage, sign-up mode, active authority, and the smoke model or `own pick`.                                |
| `signIn`                               | `email code via mysi`, `saved session` (local), or `skipped: no mailbox access (<why>)` with `mode: read-only`. |
| `integrator`                           | Step 9: install, decline, token, REST, stream, Events count, MCP, Task `completed`, turn `pong`, refusals.      |
| `build`                                | The commit the deployed client bundle names, or `skipped: <reason>` on the local stack.                         |
| `flows`                                | `ok`: a `send` point of the smoke reached the flows dataset; or `skipped: <reason>`.                            |
| `servers`                              | Server statuses, tool/grant counts and probe outcome (`ok`, `error` or `none`) with the tool probed.            |
| `files`                                | `ok`: the owner's file round trip, the file deleted again.                                                      |
| `edge`                                 | `envelope: ok` and `csrf: refused`: failures answer in the envelope with their ref; CSRF on every write.        |
| `app`                                  | `ok`: an agent app built, run by the owner (revision +1) and deleted.                                           |
| `inbound`                              | Initialization, inspection read, model turn and resident tool call (`skipped` without turns), history, 401.     |
| `inbound.author`                       | `ok`: the smoke user's message has author `goblin-smoke`.                                                       |
| `thread`, `shared`                     | `ok` and `true`: the empty thread ran and wrote a new `app.shared` entry to main.                               |
| `subagent`                             | `reported`: the Delegate's result reached main (passively, or answered when synthesis was asked for).           |
| `memory.messages`                      | Messages logged since memory activation; must be greater than zero.                                             |
| `memory.summarized`                    | Messages covered before the newest input by the last placed memory view; recorded without a minimum assertion.  |
| `utc`, `status`, `steps`               | Completion timestamp, `passed` and HTTP steps with status and the answer's ref (its log lines, ADR 0124).       |

Not covered here: the owner's Connect flow (it needs the owner at the remote server's consent screen), rendering
MCP Apps, the browser UI, thread branching, memory-summary quality, skills, and live Source message/reply or notice
delivery. Those use the separate [attended acceptance checklist](../docs/development.md#deferred-mysi-and-mygram-live-acceptance).

Prod commands use `.local/prod.env` and require `GOBLIN_CONFIRM_PROD=1` in the calling shell:
`bun run plan:prod`, `bun run deploy:prod` (break-glass outside CI), `bun run smoke:prod`.
`smoke:prod` is the same smoke; from the box it has no OIDC request, so it runs the public checks.

`GOBLIN_DOMAIN` with the required `GOBLIN_ZONE_ID` attaches the stage's custom domain through Alchemy: `dev.goblin.surf` on dev, `goblin.surf` on
prod, plus `www.goblin.surf` on prod. The Worker redirects alternate hosts to `GOBLIN_APP_URL`, preserving the path
and query (301 for GET/HEAD, 308 for writes). Dev sign-up must be closed or invite-only.

## Release operation

Branches: `dev` (the default) deploys dev, `prod` deploys prod. Everything runs in
`.github/workflows/ci.yml` on GitHub-hosted runners, each job in its own checkout.

- **Check** runs on every push and pull request: `bun run check`, no secrets.
- **Deploy dev** runs after Check for every push to `dev`, in the `dev` environment. `scripts/ci_credentials.py dev`
  masks every secret value of eight or more characters in the log, then writes the stage files mode 600; `--cleanup`
  removes them in an `always()` step. `scripts/release.py dev <sha>` requires a clean checkout at that sha, the sha to
  be the dev tip and the `Check` job of its `ci.yml` push run to have passed; it plans (no delete or replace, and no
  create of goblinAuth, Files or Web, which would mean lost state), deploys, runs the smoke, drift and the
  D1 migration inventory (the database found by exact name through the Cloudflare API), and writes `dev.json`, the
  run's `dev-acceptance` artifact (90 days). Its `acceptance` is `authenticated` when the smoke signed in, or `public`
  with the smoke's `signIn` reason while the checks account or its mailbox workload is not configured; once both are,
  a smoke that did not sign in fails the release (ADR 0128). The job's OIDC request reaches the smoke alone. Receipts go to `GOBLIN_RECEIPTS_DIR`, step logs to
  `GOBLIN_LOG_DIR` (default `.local/receipts` and `.local/release-logs`); a failed step prints its log's last 40 lines.
- **Promote** with `bun run promote <full-sha>` from any checkout with `gh` signed in and `.local/cloud.env`. It needs
  no prod credentials: it requires the sha to be the dev tip with a passing Check, its `dev-acceptance` receipt to be
  accepted (authenticated, or public because the smoke's sign-in is not configured) and name the live dev Worker
  version, and `prod...sha` to fast-forward, then moves `prod` with
  `force=false` and prints the started run.
- **Deploy prod** runs after Check for every push to `prod`, in the `prod` environment. `release.py prod` repeats the
  provenance and acceptance checks, requires the push to fast-forward from its `before` sha and not be forced, keeps the
  first release invite-only (until the `goblin-prod` Worker serves a version), then releases as on dev, with the same
  smoke. Its artifact is `prod-acceptance`. When a step fails, `release.py` leaves a content-free `failure.json` (the
  step and the smoke's machine reason) in `GOBLIN_LOG_DIR`, and `scripts/release-alert.ts prod` writes the job's step
  summary (the failed step, the prod commit before the push and the way back) and sends one Telegram line through the
  `GOBLIN_ALERT_WORKLOAD` workload, or says why it skipped it. Nothing is rolled back.

GitHub secrets per environment, each a whole file (`gh secret set <name> --env <stage> < file`, never echoed):
`GOBLIN_STAGE_ENV` (`.local/<stage>.env`), `GOBLIN_CLOUD_ENV` (only
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`), `ALCHEMY_STATE_STORE_CREDENTIALS` (the cached
`~/.alchemy/credentials/default/cloudflare-state-store.json`, because the Cloudflare token cannot read the Secrets
Store to mint it) and `GOBLIN_SMOKE_EMAIL` (the checks account's address, a secret so the public log masks it). The
`dev` environment admits only the dev branch and `prod` only prod; a pull request runs on its merge ref and reaches
neither. No session cookie is stored (ADR 0128).

GitHub variables (`gh variable set <name> --env <stage> --body <value>`): `GOBLIN_SMOKE_MAILBOX_WORKLOAD` on `dev` and
on `prod`, each the client id (`wl_…`) of that environment's mailbox policy; `GOBLIN_ALERT_WORKLOAD` on `prod`, the alert
policy's client id; optionally `MYSI_ORIGIN`. Unset, the smoke stays public and the alert skips, each saying why.

The owner makes three trusted-workload policies in mysi. Each policy's claims are exact:

| Policy        | `repository`     | `ref`             | `workflow_ref`                                            | `environment` | Saved access                                                                               |
| ------------- | ---------------- | ----------------- | --------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------ |
| Mailbox, dev  | `grmkris/goblin` | `refs/heads/dev`  | `grmkris/goblin/.github/workflows/ci.yml@refs/heads/dev`  | `dev`         | myinbox read (`address_cursor`, `verification_wait`) on the checks account's address only. |
| Mailbox, prod | `grmkris/goblin` | `refs/heads/prod` | `grmkris/goblin/.github/workflows/ci.yml@refs/heads/prod` | `prod`        | The same.                                                                                  |
| Alert, prod   | `grmkris/goblin` | `refs/heads/prod` | `grmkris/goblin/.github/workflows/ci.yml@refs/heads/prod` | `prod`        | mygram `message_send` at reply level, limited to the alerts chat.                          |

Alchemy state for dev and prod lives in the account's shared Cloudflare state store (`scripts/alchemy-state.ts`), as
`goblin/<stage>` beside myapps' and the retired Goblin Wallet's stacks. It has no lock: each stage deploys in one
non-cancelling concurrency group, and a deploy from the build box is break-glass (pause CI first, then
`GOBLIN_BREAK_GLASS=1`). `scripts/state-copy.ts` moved the box's local state into it once: it touches only those two
stacks, refuses a non-empty destination or an unsettled record, verifies sha256 by record name and copies back with
`--to local`. Never use Alchemy's `syncState` against this store: it deletes every stack the source lacks.

The first production release is invite-only with no configured invite or owner email, so it admits nobody until the
operator securely supplies those values. Its dedicated model key offers the approved five models and caps spending at
$10 per 30 days. Its smoke signs in as the checks account once the prod mailbox workload is configured (ADR 0128).

Roll back code with a revert commit on `dev`: CI deploys it to dev with full acceptance, then `bun run promote` it.
When prod cannot wait for that, roll the `goblin-prod` Worker back to its previous version in
Cloudflare (`wrangler rollback` or the dashboard) and follow with the revert, so the next deploy does not undo it. Leave
all auth, app and vendor data intact and never run down migrations: confirm that the older code supports every additive
schema already applied, then repeat acceptance and drift inspection.
