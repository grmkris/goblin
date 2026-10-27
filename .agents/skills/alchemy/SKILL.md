---
name: alchemy
description: Change goblin infrastructure, Cloudflare bindings, local development, or isolated dev deployment through Alchemy.
---

# Alchemy in goblin

Alchemy (a pinned beta) is the sole infrastructure source of truth; check its installed declarations before changing it.

- Bind the native Agent class directly; do not force PiHarness through an Effect-native DO superclass.
- Keep deployment code out of Worker/runtime imports and runtime migration SQL.
- Preserve stage-derived physical resource names and explicit dev ownership. `destroy:dev` needs `--confirm-reset`; prod has separate resources and mode-600 secrets; every prod command requires `GOBLIN_CONFIRM_PROD=1`. Destroying prod requires the owner's explicit reset decision and `--confirm-reset`.
- Put secrets in runtime bindings; never browser bundles, logs, transcripts, or iframe state.
- Declare a binding in `apps/web/alchemy.run.ts`, `apps/runtime/src/env.ts` and the integration stacks together; the
  `FILES` R2 bucket (the owner's files) is stage-named and local under workerd.
- Verify current TanStack Start/Vite integration compatibility before adding any Cloudflare Vite plugin; do not maintain two deployment systems.
- Record plan/build evidence, real dev deployment receipts, and smoke results separately. A local artifact is not deployed acceptance.

Before changing an API call, read the current [documentation](https://alchemy.run/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Custom domains require `GOBLIN_DOMAIN` and `GOBLIN_ZONE_ID`; the Worker canonical origin, auth and inbound MCP metadata come from `APP_URL`. A deploy needs a way in: an OTP mail sender (`GOBLIN_MAIL_SENDER`), an OpenID Connect provider (`GOBLIN_OIDC_ISSUER`, `GOBLIN_OIDC_CLIENT_ID`, the secret `GOBLIN_OIDC_CLIENT_SECRET`, `GOBLIN_OIDC_LABEL`) or both (ADR 0064). Dev sign-up is closed or invite-only. The dev and prod deploys' smoke signs in as the checks account once its mysi mailbox workload is configured, and runs its public checks until then (ADR 0128).
- Configuration, never the stage's name, decides what a deployment does (ADR 0064): the model endpoint (`GOBLIN_MODEL_*`) is optional, and `GOBLIN_LARGE_FILES`, `GOBLIN_AGENT_APPS` and `GOBLIN_FLOWS` (`off` to drop `FILES`, `LOADER` or `FLOWS`) turn optional bindings off; the runtime must start without each. `STAGE` reaches the Worker as a label only.

- Dev and prod keep their state in the account's shared Cloudflare state store (`scripts/alchemy-state.ts`: `Cloudflare.state()` for a cloud run of `dev` or `prod`, local `.alchemy/state` for every other stage and under `alchemy dev`). CI (`.github/workflows/ci.yml`) deploys goblin on every push to `dev` that passes Check and, after `bun run promote <full-sha>`, on the push to `prod`; `scripts/release.py` refuses a plan that deletes, replaces or re-creates a stateful resource. The store has no lock: `deploy:*` and `destroy:*` on dev or prod outside CI refuse without `GOBLIN_BREAK_GLASS=1` (pause CI's deploys first); `plan:*`, `drift:*` and `smoke:*` run anywhere. `.local/cloud.env` holds only `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. Never run Alchemy's `syncState` against the store: it deletes every stack the source lacks, and the store holds myapps' stacks too; `scripts/state-copy.ts` is the only copy tool. The read-only drift audit reads persisted attributes through the store and normalizes only beta.80 domain-zone bookkeeping and D1 default disabled replication; any other cloud difference fails.

- Bump the pinned alchemy beta together with myapps. The shared store's Worker is versioned with alchemy: a `deploy --yes` at another version upgrades (or downgrades) it for every stack in the account, and a CI `plan` at a mismatched version stops with "state store is out of date".

- No stage binds Workers AI (ADR 0067): every model call goes to the endpoint the deployment or the owner configures.
