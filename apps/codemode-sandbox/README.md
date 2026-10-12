# codemode sandbox Worker (spike)

Deploys `CodemodeSandboxDurableObject` from `@earendil-works/pi-codemode/cloudflare` as its own Worker, so durable
code mode scripts run outside the agent's Durable Object (pi-codemode README, "Why a separate Worker"). The agent
Worker binds it as `CODEMODE_SANDBOX` with `scriptName`; `apps/web/alchemy.run.ts` deploys it first.
