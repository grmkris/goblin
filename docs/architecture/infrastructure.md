# Infrastructure and release

## Infrastructure

`apps/web/alchemy.run.ts` declares the Vite Worker, the `PersonalAgent` namespace, the D1 database, the `FILES` R2
bucket, the `FLOWS` Analytics Engine dataset (`goblin-<stage>-flows`, ADR 0037) and the `LOADER` Worker Loader
(Dynamic Workers, open beta, Workers Paid); it is goblin's deployment entrypoint.

What a deployment does comes from its configuration, never from its stage's name
([ADR 0064](../adr/0064-openid-connect-and-config-driven-deployment.md)); the runtime reads `STAGE` only as a label
(mail subjects, robots, telemetry tags). Alchemy refuses a deploy only when it has no way in: neither
`GOBLIN_MAIL_SENDER` (the `MAIL` binding) nor a whole OpenID Connect provider (`GOBLIN_OIDC_ISSUER`,
`GOBLIN_OIDC_CLIENT_ID` and the secret `GOBLIN_OIDC_CLIENT_SECRET`; half of one is refused too). The model endpoint is
optional (`GOBLIN_MODEL_*`), and so are three bindings, each on unless its switch says `off`: `GOBLIN_LARGE_FILES`
(the `FILES` bucket; without it files up to 128 KiB stay in the agent's SQLite and a larger one is refused as too
large), `GOBLIN_AGENT_APPS` (the `LOADER`; without it the agent has no app or `code_run` tools, an app view or job
that needs an isolate is refused, and Apps has no Built for you) and `GOBLIN_FLOWS` (the dataset; without it no flow point
is written and `goblin stats` has nothing to read). None is needed for the agent to start, and `/health` lists what
the deployment has (`features`). goblin's own stages keep every binding.
`scripts/stage.ts` builds `packages/app`'s toolchain before Alchemy runs. The local stage runs in workerd with CLIProxy; the dev stage calls Railway LiteLLM with a
dedicated model-limited, budget-capped key. Offered models and the optional daily token cap per account come from stage
configuration. The key's provider caps and shared quotas are managed outside this repository; source does not prove
their active values. Secrets are Worker secret bindings, never in the browser bundle. Every stage turns on Workers
Logs (with invocation logs) and Workers Traces for every request (`scripts/stage-config.ts`); Cloudflare keeps both
seven days. The run ledger's log lines (see Run ledger) are among them.


## Stage origins

Dev runs at `https://dev.goblin.surf`; production runs at `https://goblin.surf` with `www` redirecting to the apex. The fresh Goblin stack creates
`goblin-dev-auth`, an empty native Agent namespace and new auth/encryption secrets. It imports no users, transcripts,
connections or grants. Production uses separate resources, secrets and a dedicated model key; its first release is invite-only until owner bootstrap. `GOBLIN_DOMAIN` and `GOBLIN_ZONE_ID` attach
the stage's custom domain; prod additionally has a `www` alias. Both Worker entry points redirect alternate origins
before auth, hooks or rendering: 301 for GET/HEAD, 308 otherwise, preserving path/query with `APP_URL` as authority.
Auth trusted origins and inbound MCP metadata derive from that origin. Dev mail subjects include its host; prod
subjects have no prefix. Domain reachability and actual OTP delivery require separate live checks.

The inbound Agents SDK handler explicitly allows only the configured `APP_URL` hostname for both Host and browser
Origin validation. The SDK defaults otherwise reject browser requests on custom domains. A native workerd regression
proves a custom-domain Origin succeeds and a foreign Origin is rejected.

## Release and public source

`dev` is the daily source branch; `prod` records the deliberately promoted SHA and is GitHub's default branch, so the
repository shows what is live (ADR 0077). One workflow,
`ci.yml`, runs on GitHub-hosted runners: Check on every push and pull request, then, for a push to `dev`, Deploy dev
(exact-tip deployment and authenticated acceptance, published as the `dev-acceptance` artifact), and for a push to
`prod`, Deploy prod. `bun run promote <sha>` verifies the dev Check, that SHA's `dev-acceptance` receipt at the live dev
Worker version and a fast-forward, then moves `prod`; Deploy prod repeats the checks, refuses a forced push and deploys
that commit.

Alchemy state for dev and prod lives in the account's shared Cloudflare state store (`scripts/alchemy-state.ts`), which
myapps also uses; local, test and bench stages keep local state. The store has no lock: each stage deploys through one
non-cancelling CI concurrency group, and a deploy from anywhere else is break-glass (`GOBLIN_BREAK_GLASS=1`).

The repository is the public source: its branches, history, Issues, workflow logs and artifacts are public, and deployed
commit ids are public commit ids. Stage secrets are GitHub environment secrets that only their branch's deploy job can
read, masked before use; pull requests run only Check, with read-only permissions and no secrets.
[ADR 0046](../adr/0046-production-promotion-and-public-source.md) records the boundaries.
