---
name: pi-durable
description: Change Purrable's Pi Durable and PiHarness integration - sessions, submission, extensions and tools, persona, event projection, or reconstruction tests.
---

# Pi Durable in Purrable

Pi Durable owns transcripts, tasks, steering and recovery. Use the pinned native harness; do not rebuild these.

- `PiHarness` is registered with `lifecycle.use` in `PersonalAgent`. The main thread is `ROOT_SESSION`; each inbound
  client gets a session from `sessions.create()`, mapped in `app_client_sessions` (ids are not choosable).
- Submissions carry stable operation IDs. Acceptance is not completed external work; never claim exactly-once effects.
- Extensions: `persona.ts` (static system prompt sections, keep them static so prompt caches hold),
  `resident-mcp.ts` (`mcp_list`, `mcp_call`), `ask-user.ts` (`ask_user`) and `budget.ts` (usage recording, tool
  blocking). Tools with side effects are `replay: 'unsafe'`.
- A tool that needs a person ends the run (`control: { terminate: true }`) and leaves plain text in its result. The
  answer is the next ordinary user message: never hold a run open waiting for the owner. `ask_user` and `mcp_call`'s
  grant-required result both work this way.
- Pi reports and swallows exceptions thrown by hooks (`beforeRequest`, `afterResponse`, ...). To stop work from a
  hook, return a result Pi honours, such as `beforeTool` `{ block }`; a throw does nothing.
- Tool implementations check resident authority and grants before any outbound call, and never hold a SQLite
  transaction across model or network work.
- Events are a snapshot plus committed batches with no cursor replay.
- Vendor tables (`pi_*`, `cf_agents_*` and the others in `storage/vendor.ts`) are never touched.
- Initialization, readback and reconstruction are separate proofs; local workerd reconstruction is not remote
  eviction.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/harnesses/pi/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.
