---
name: alchemy
description: Change goblin infrastructure, Cloudflare bindings, local development, or isolated dev deployment through Alchemy.
---

# Alchemy in goblin

Alchemy (a pinned beta) is the sole infrastructure source of truth; check its installed declarations before changing it.

- Bind the native Agent class directly; do not force PiHarness through an Effect-native DO superclass.
- Keep deployment code out of Worker/runtime imports and runtime migration SQL.
- Preserve stage-derived physical resource names and explicit dev ownership. `destroy:dev` needs `--confirm-reset`; prod has separate resources and mode-600 secrets; every prod command requires `GOBLIN_CONFIRM_PROD=1`. There is no destroy-prod command.
- Put secrets in runtime bindings; never browser bundles, logs, transcripts, or iframe state.
- Declare a binding in `apps/web/alchemy.run.ts`, `apps/runtime/src/env.ts` and the integration stacks together; the
  `FILES` R2 bucket (the owner's files) is stage-named and local under workerd.
- Verify current TanStack Start/Vite integration compatibility before adding any Cloudflare Vite plugin; do not maintain two deployment systems.
- Record plan/build evidence, real dev deployment receipts, and smoke results separately. A local artifact is not deployed acceptance.

Before changing an API call, read the current [documentation](https://alchemy.run/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Custom domains require `GOBLIN_DOMAIN` and `GOBLIN_ZONE_ID`; the Worker canonical origin, OTP auth and inbound MCP metadata come from `APP_URL`. Every stage requires an OTP mail sender. Dev sign-up is closed or invite-only. Prod smoke defaults to reads until an operator test account is supplied.

- Operator and CI stage commands share `/var/lib/goblin-release` state and `flock`; seed dev before first use. Deploy exact green main SHAs with `bun run release dev <full-sha>`, then the same SHA on prod. Keep sanitized receipts and private logs outside the checkout. The read-only drift audit normalizes only beta.80 domain-zone bookkeeping and D1 default disabled replication; any other cloud difference fails.
