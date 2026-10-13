# ADR 0046: Daily development, deliberate production promotion and public source

Accepted 2026-10-12 with the owner. Amended 2026-10-13: the repository itself is the public source, with no self-hosted runner.

## Problem

Manual deployments from main do not make the daily environment or the public source track a verified release. A
persistent self-hosted runner on a public repository runs any workflow a fork's pull request adds once someone approves
it, and the build box it runs on holds every stage's credentials and release state.

## Decision

`grmkris/goblin` is authoritative and public. Daily changes land on `dev`. A dev tip whose push Check passed is released from the build box (`release dev`), which deploys it and verifies authenticated smoke. Promotion (`promote`) accepts one full SHA, requires its passing dev push check and current authenticated dev receipt/version, advances `prod` by fast-forward and deploys/verifies that SHA directly. Existing stage resources, state directories, host locks, non-destructive plan checks, migration inventory and reset consent remain in force.

The repository's branches, history and Issues are public. An earlier plan projected sanitized history into a separate `grmkris/goblin-public`; the owner chose to publish this repository instead, after a secret and personal-data audit of its full history, and `goblin-public` is archived. Secrets never enter the repository: they live in mode-600 `.local/*.env` files on the build box and in Worker secret bindings.

Every check, for pushes and pull requests alike, runs on GitHub-hosted runners with read-only credentials and no secrets. No self-hosted runner is registered on the repository and no stage secret is stored in GitHub, because a pull request can rewrite the workflow files themselves; an approval gate alone would leave the build box one click from outside code. Releases run only on the build box, from the operator's own mode-600 stage files. A workflow from an external contributor still waits for the owner's approval.

Goblin-owned code is available under MIT. The three Wallet workspaces (`apps/wallet`, `apps/wallet-web`, `packages/wallet`) retain workspace LICENSE files and package declarations. Preserve third-party notices and author-owned provenance in `NOTICE.md`. React Leaflet's Hippocratic-2.1 terms remain disclosed. Promote deploys core Goblin and Wallet production from the same accepted source snapshot. Wallet uses `GOBLIN_CONFIRM_PROD=1 bun run deploy:wallet-prod`, its existing state and wallet deploy lock, and the mode-600 `.local/wallet-prod.env`. It requires live health, the production OAuth issuer and anonymous MCP refusal, then records the active Wallet Worker version. These public probes do not establish payment or financial-provider acceptance.

## Consequences

Deployed commit ids are public commit ids. Everything committed is public, including agent configuration and the operational records the repository keeps, so none of it may carry secrets or private personal data. Original author emails remain public by the owner's decision.

Dev no longer deploys itself on push: someone on the build box releases each accepted tip. Production ref advancement can precede a failed deployment. The accepted receipt and live Worker version, rather than the ref alone, decide what is live. An applied migration edit still requires the explicit greenfield reset procedure; automation cannot silently destroy a stage to make a release pass.
