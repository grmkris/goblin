# ADR 0046: Daily development, deliberate production promotion and public source

Accepted 2026-10-12 with the owner. Amended 2026-10-13: the repository itself is the public source.

## Problem

Manual deployments from main do not make the daily environment or the public source track a verified release. The
persistent self-hosted runner that deploys holds stage secrets, so it must not execute code from public pull requests.

## Decision

`grmkris/goblin` is authoritative and public. Daily changes land on `dev`; successful exact-tip push checks automatically deploy and verify dev with authenticated smoke. The explicit Promote action accepts one full SHA, requires its passing dev push check and current authenticated dev receipt/version, advances `prod` by fast-forward and deploys/verifies that SHA directly. GitHub-token pushes do not trigger another Actions run. Existing stage resources, state directories, host locks, non-destructive plan checks, migration inventory and reset consent remain in force.

The repository's branches, history and Issues are public. An earlier plan projected sanitized history into a separate `grmkris/goblin-public`; the owner chose to publish this repository instead, after a secret and personal-data audit of its full history, and `goblin-public` is archived. Secrets never enter the repository: they live in mode-600 `.local/*.env` files, Worker secret bindings and GitHub environment secrets.

Only pushes and the owner's dispatches run on the self-hosted runner with environment secrets. Pull requests are checked on GitHub-hosted runners with read-only credentials and no secrets, and a workflow from an external contributor waits for the owner's approval, because a pull request can rewrite the workflow files themselves.

Goblin-owned code is available under MIT. The three Wallet workspaces (`apps/wallet`, `apps/wallet-web`, `packages/wallet`) retain workspace LICENSE files and package declarations. Preserve third-party notices and author-owned provenance in `NOTICE.md`. React Leaflet's Hippocratic-2.1 terms remain disclosed. Promote deploys core Goblin and Wallet production from the same accepted source snapshot. Wallet uses `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod`, its existing state and wallet deploy lock, and the mode-600 `.local/wallet-prod.env` materialized from the prod environment secret `GOBLIN_WALLET_PROD_ENV`. It requires live health, the production OAuth issuer and anonymous MCP refusal, then records the active Wallet Worker version. These public probes do not establish payment or financial-provider acceptance.

## Consequences

Deployed commit ids are public commit ids. Everything committed is public, including agent configuration and the operational records the repository keeps, so none of it may carry secrets or private personal data. Original author emails remain public by the owner's decision.

Production ref advancement can precede a failed deployment. The accepted receipt and live Worker version, rather than the ref alone, decide what is live. An applied migration edit still requires the explicit greenfield reset procedure; automation cannot silently destroy a stage to make a release pass.
