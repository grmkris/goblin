# Infrastructure and release

## Infrastructure

`apps/web/alchemy.run.ts` declares the Vite Worker, the `PersonalAgent` namespace, the D1 database, the `FILES` R2
bucket, the `FLOWS` Analytics Engine dataset (`goblin-<stage>-flows`, ADR 0037), the `LOADER` Worker Loader
(Dynamic Workers, open beta, Workers Paid) and, on dev only, Workers AI as `AI` for typed decisions (ADR 0031; without
it decisions judge nothing); it is goblin's deployment entrypoint. `apps/wallet/alchemy.run.ts` deploys Goblin Wallet
(see Goblin Wallet).
`scripts/stage.ts` builds `packages/app`'s toolchain before Alchemy runs. The local stage runs in workerd with CLIProxy; the dev stage calls Railway LiteLLM with a
dedicated model-limited, budget-capped key. Offered models and Credit rates come from stage configuration; the per-account allowance comes from its plan or
operator override. The key's provider caps and shared quotas are managed outside this repository; source does not prove
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

`dev` is the daily source branch and the default; `prod` records the deliberately promoted SHA. One workflow,
`ci.yml`, runs on GitHub-hosted runners: Check on every push and pull request, then, for a push to `dev`, Deploy dev
(goblin dev and wallet-dev, exact-tip deployment and authenticated acceptance, published as the `dev-acceptance`
artifact), and for a push to `prod`, Deploy prod. `bun run promote <sha>` verifies the dev Check, that SHA's
`dev-acceptance` receipt at the live dev Worker version and a fast-forward, then moves `prod`; Deploy prod repeats the
checks, refuses a forced push and deploys core Goblin and the separate Wallet production Worker from the same commit.
Wallet keeps its own stage file and Alchemy stack; health, the stage's OAuth issuer and anonymous MCP refusal establish
its public smoke receipt.

Alchemy state for dev and prod lives in the account's shared Cloudflare state store (`scripts/alchemy-state.ts`), which
myapps also uses; local, test and bench stages keep local state. The store has no lock: each stage deploys through one
non-cancelling CI concurrency group, and a deploy from anywhere else is break-glass (`GOBLIN_BREAK_GLASS=1`).

The repository is the public source: its branches, history, Issues, workflow logs and artifacts are public, and deployed
commit ids are public commit ids. Stage secrets are GitHub environment secrets that only their branch's deploy job can
read, masked before use; pull requests run only Check, with read-only permissions and no secrets.
[ADR 0046](../adr/0046-production-promotion-and-public-source.md) records the boundaries.
