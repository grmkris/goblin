# ADR 0046: Daily development, deliberate production promotion and public source

Accepted 2026-10-12 with the owner. Amended 2026-10-13: the repository itself is the public source, with no self-hosted runner. Amended again 2026-10-13: two branches, CI/CD on GitHub-hosted runners with environment secrets, and the shared Cloudflare state store.

## Problem

Manual deployments do not make the daily environment or the public source track a verified release. A
persistent self-hosted runner on a public repository runs any workflow a fork's pull request adds once someone approves
it, and the build box it runs on holds every stage's credentials and release state.

## Decision

`grmkris/goblin` is authoritative and public. Daily changes land on `dev`, and CI deploys each dev tip whose Check passed and verifies authenticated smoke. Promotion (`promote`) accepts one full SHA, requires its passing dev push check and current authenticated dev receipt/version, and advances `prod` by fast-forward; CI then deploys and verifies that SHA. Existing stage resources, non-destructive plan checks, migration inventory and reset consent remain in force (second amendment below).

The repository's branches, history and Issues are public. An earlier plan projected sanitized history into a separate `grmkris/goblin-public`; the owner chose to publish this repository instead, after a secret and personal-data audit of its full history, and `goblin-public` is archived. Secrets never enter the repository: they live in GitHub environment secrets, in the operator's mode-600 `.local/*.env` files and in Worker secret bindings.

Every job runs on GitHub-hosted runners. No self-hosted runner is registered on the repository, because a pull request can rewrite the workflow files themselves; an approval gate alone would leave the build box one click from outside code. Pull requests run Check with read-only credentials and no secrets; only the deploy jobs of pushes to `dev` and `prod` read their stage's environment secrets. A workflow from an external contributor still waits for the owner's approval.

Goblin-owned code is available under MIT. The three Wallet workspaces (`apps/wallet`, `apps/wallet-web`, `packages/wallet`) retain workspace LICENSE files and package declarations. Preserve third-party notices and author-owned provenance in `NOTICE.md`. React Leaflet's Hippocratic-2.1 terms remain disclosed. Deploy prod deploys core Goblin and Wallet production from the same accepted commit. Wallet uses `deploy:wallet-prod` with its own Alchemy stack and wallet environment file. It requires live health, the production OAuth issuer and anonymous MCP refusal, then records the active Wallet Worker version. These public probes do not establish payment or financial-provider acceptance.

### Second amendment, 2026-10-13: CI/CD on GitHub-hosted runners

The repository has two branches. `dev`, the default, deploys goblin dev (`dev.goblin.surf`) and wallet-dev
(`wallet-dev.goblin.surf`); `prod` deploys goblin prod (`goblin.surf`) and Wallet production (`wallet.goblin.surf`).
`main` is retired. One workflow, `ci.yml`, runs everything on GitHub-hosted runners, each job in its own checkout: Check
on every push and pull request; Deploy dev after Check for every push to `dev`; Deploy prod after Check for every push to
`prod`. There is no release state on the build box, no snapshot and no host lock.

Stage secrets are GitHub environment secrets behind branch policies: the `dev` environment admits only the dev branch
and `prod` only prod. A pull request, a fork's included, runs on its merge ref, which neither policy admits, so it runs
Check with read-only permissions and no secret. The workflow never uses `pull_request_target` or `workflow_run`, the two
triggers that would run a pull request's influence with the base repository's secrets. Each secret is a whole file the
deploy job materializes mode 600 after masking every value of eight or more characters, because GitHub masks a
multi-line secret only line by line. The wallet secret carries only the keys the wallet stack reads (never the treasury
or Privy policy key), and the cloud secret only the Cloudflare token and account id.

Rulesets protect both branches: no deletion and no force push on `dev` and `prod`, without bypass, and on `prod` the
`Check` status from GitHub Actions is required, so an unchecked sha cannot reach it. Promotion is
`bun run promote <sha>`: it requires that sha to be the dev tip with a passing Check, its `dev-acceptance` artifact to
record authenticated acceptance at the live dev Worker version, and a fast-forward, then moves `prod`. Deploy prod
repeats those checks, refuses a forced push and a plan that would re-create goblinAuth, Files, Web or the Wallet Worker,
and keeps the first release invite-only.

Alchemy state for dev and prod moves from files on the build box to the account's Cloudflare state store, the
`alchemy-state-store` Worker that myapps also uses, at the same pinned alchemy version; a one-off, verified copy moved
the four stacks there and can copy them back. The store has no lock, so each stage deploys in one non-cancelling
concurrency group, and a deploy or destroy from the build box is break-glass only: CI's deploys paused first, then
`GOBLIN_BREAK_GLASS=1`. Plan, drift and smoke stay available anywhere.

## Consequences

Deployed commit ids are public commit ids. Everything committed is public, including agent configuration and the operational records the repository keeps, so none of it may carry secrets or private personal data. Original author emails remain public by the owner's decision.

Dev deploys itself on every push that passes Check, and each such deploy runs the authenticated smoke, which spends a
few model calls. Production ref advancement can precede a failed deployment. The accepted receipt and live Worker
version, rather than the ref alone, decide what is live, and a Deploy prod whose dev moved on in the meantime fails
until the new dev tip is promoted. An applied migration edit still requires the explicit greenfield reset procedure,
now break-glass end to end; automation cannot silently destroy a stage to make a release pass, nor re-create one.

Workflow logs and artifacts are public, so every secret value is masked before use and receipts hold no content,
credential or owner identity. The accepted risk: a compromised dependency inside a deploy job runs beside the stage's
secrets, the shared Cloudflare token and the state store's bearer token, and through those could reach myapps' state
in the same store. Deploy jobs install only the root workspaces and remove the materialized files when they end, which
narrows that window without closing it. An alchemy version bump is coordinated with myapps, because the shared store's
Worker follows the version that deploys.
