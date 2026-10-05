---
name: pi-durable
description: Change Purrable's Pi Durable and PiHarness integration - sessions, submission, extensions and tools, persona, event projection, or reconstruction tests.
---

# Pi Durable in Purrable

Pi Durable owns transcripts, tasks, steering and recovery. Use the pinned native harness; do not rebuild these.

- `PiHarness` is registered with `lifecycle.use` in `PersonalAgent`. Main is `ROOT_SESSION` (`MAIN_THREAD`); inbound
  clients talk in it with an author tag (`pi/content.ts`). Threads are Pi forks of main at an entry, or
  `sessions.create()`; every one is registered in `app_conversations` (`conversations.ts`), and only registered ids
  reach Pi. Raw Pi calls outside a task take `BACKGROUND` from `pi/context.ts`.
- Writing into another conversation (a thread's note into main) is a write submission, never `tx.appendEntry`:
  `submit({ type: 'write', entry, requestId })`. A busy conversation places it at its next boundary, the request id
  makes a replayed tool find the same entry, and a write starts no run.
- Extensions for one kind of conversation are installed in the registry but left out of `settings.extensions` (the
  default list), then added per conversation: `fork(..., { agent: { extensions: { add } } })` or `configure`.
- `configure` changes only the fields it is given (`null` clears one). Purrable uses the per-conversation `tools`
  filter for one thing: `{ remove: [subagent] }` where a conversation switched subagents off (`capabilities/`, ADR
  0010). A fork starts from main's agent at the fork entry, so a new thread sets its filter explicitly.
- Submissions carry stable operation IDs. Acceptance is not completed external work; never claim exactly-once effects.
- Extensions: `persona.ts` (static system prompt sections, keep them static so prompt caches hold),
  `resident-mcp.ts` (`mcp_list`, `mcp_call`), `ask-user.ts` (`ask_user`), `budget.ts` (usage recording, tool
  blocking), `subagents.ts` (`subagent`, with anchor and reporter tasks) and, on threads only, `thread.ts`
  (`share_to_main`, titles). Tools with side effects are `replay: 'unsafe'`.
- An extension's background tasks resume after a restart only while the extension is installed: keep task names and
  versions stable, and give a changed task a `migrate`.
- A task phase must commit durable progress: committing the same checkpoint again faults the task ("returned without
  durable progress"). A looping phase carries a counter. A faulted task skips its own clean-up, so whatever records a
  running task checks the task's record (`tx.task(id)`) instead of trusting a flag the task clears.
- A head marker (`head` on an entry: compaction, reset, Purrable's `app.memory` view) starts the model's context and
  the snapshot at its head. Never write `head: 'self'` into a busy conversation: at a boundary it acts as a reset.
- A tool that needs a person ends the run (`control: { terminate: true }`) and leaves plain text in its result. The
  answer is the next ordinary user message: never hold a run open waiting for the owner. `ask_user` and `mcp_call`'s
  grant-required result both work this way.
- Pi reports and swallows exceptions thrown by hooks (`beforeRequest`, `afterResponse`, ...). To stop work from a
  hook, return a result Pi honours, such as `beforeTool` `{ block }`; a throw does nothing.
- Tool implementations check resident authority, the conversation's capability scope (`Capabilities.scope`) and
  grants before any outbound call, and never hold a SQLite transaction across model or network work. Something
  switched off returns `capabilityOffResult` (`pi/capabilities.ts`); the owner turns it on from a card.
- Events are a snapshot plus committed batches with no cursor replay.
- Vendor tables (`pi_*`, `cf_agents_*` and the others in `storage/vendor.ts`) are never touched.
- Initialization, readback and reconstruction are separate proofs; local workerd reconstruction is not remote
  eviction.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/harnesses/pi/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how Purrable uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routines use `routine` for draft proposal/list/pause; only the owner confirms an exact revision through the strict-CSRF
  API. Native dated schedules are fenced by app revision/firing watermarks. Background Pi Anchor/Reporter tasks own
  empty run conversations; register them without copied main capabilities or an ordinary main-start note. The confirmed
  ceiling lives in `Capabilities.scope`; management, Skills, subagents, main memory and learner are absent from run
  extensions. Check the dedicated per-run provider on every model dispatch, including compaction, and MCP authority
  on every HTTP attempt after token refresh. Never depend on swallowed Pi hook exceptions to stop a model request.
- Project committed `pi.usage` through app-only cumulative watermarks and stable UTC-day receipts. Passive reports use
  the actual parent `Conversation.submit` write API; acceptance starts no main model turn. Sealed questions resume the
  same run, release executing slots while waiting, and retain the single-routine lock. Run Stop/archive fence and abort
  owned work; main Stop spares background runs. Frozen Telegram reports and remote receipts are separate from Pi
  acceptance. Local workerd evidence and retained-dev acceptance remain distinct.
