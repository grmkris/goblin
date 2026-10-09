---
name: pi-durable
description: Change goblin's Pi Durable and PiHarness integration - sessions, submission, extensions and tools, persona, event projection, or reconstruction tests.
---

# Pi Durable in goblin

Pi Durable owns transcripts, tasks, steering and recovery. Use the pinned native harness; do not rebuild these.

- `PiHarness` is registered with `lifecycle.use` in `PersonalAgent`. Main is the stable chat id `PRIMARY_CHAT` (`1`),
  resolved by `Chats` to its current Pi session; a fresh agent initially maps it to Pi's root. Inbound clients
  talk in the primary chat with an author tag (`pi/content.ts`). Threads are Pi forks of main at an entry, or
  `sessions.create()`; every one is registered in `app_conversations` (`conversations.ts`), and only registered chat
  ids resolve to sessions at the owner boundary. Raw Pi calls outside a task take `BACKGROUND` from `pi/context.ts`.
- Writing into another conversation (a thread's note into main) is a write submission, never `tx.appendEntry`:
  `submit({ type: 'write', entry, requestId })`. A busy conversation places it at its next boundary, the request id
  makes a replayed tool find the same entry, and a write starts no run.
- Extensions for one kind of conversation are installed in the registry but left out of `settings.extensions` (the
  default list), then added per conversation: `fork(..., { agent: { extensions: { add } } })` or `configure`.
- Agent apps (ADR 0021) are the exception that is live: `settings.extensions` is a getter over the defaults plus the
  apps' extensions (`pi/harness.ts`), read at every use, so `registry.install` of an app's extension is offered from
  the next model request. Never add one per conversation with `configure({ extensions: { add } })`: it replaces the
  stored add list (a thread would lose its own). The harness factory restores the apps (migrations, then installs)
  before `Harness.open`, because it runs before `onStart`. A generated tool pins its release with
  `api.memo('goblin.release', …)` and uses `c<conversation>:<call>` as its operation id.
- `configure` changes only the fields it is given (`null` clears one). goblin uses the per-conversation `tools`
  filter for one thing: `{ remove: [subagent] }` where a conversation switched subagents off (`capabilities/`, ADR
  0010). A fork starts from its parent's agent at the fork entry, so a new thread sets its extensions (the host's plus
  the thread's, `instructions: null` to drop a subagent's), and its filter, explicitly (ADR 0017).
- Observing Pi means its commit listener, not hooks: `subscribeCommits` sees every conversation's committed entries,
  tasks and submissions, and the run ledger (`telemetry/pi.ts`, ADR 0024) is attached in the harness factory as soon
  as `Harness.open` returns. A listener runs inside Pi's commit: if it throws, Pi faults the user's task, so guard it,
  keep it synchronous and never call Session APIs from it. Hooks do not pair reliably (no `afterTool` for a blocked
  call, no `afterResponse` after an abort) and subagents and routine runs keep their own extension lists.
- Submissions carry stable operation IDs. Acceptance is not completed external work; never claim exactly-once effects.
- Owner, inbound and Telegram submissions admit `(chat, operationId)` through `Chats` before calling Pi. The admission
  ledger pins the first Pi session for retries across a future rebind; the per-chat lock covers admission only and is
  released before model execution or waiting. `harness.wait` resolves through that operation binding. A rebind uses
  an epoch compare-and-set and closes the affected SSE streams; it does not move a running Pi turn. The application
  ledger prunes old operations opportunistically after 30 days. Passive reports, share-backs and thread-start notes
  use the shared `Chats.passiveWrite` admission lock to resolve their target chat's current session and submit with stable
  Pi write request ids; they start no model run. Subagent report admission uses that same directory and lock; never
  construct a private `ChatDirectory` outside composition or tests.
- The owner queue reads `InboxDoc` for Main and ordinary threads only. Removal validates the registered conversation
  and input type, then uses native `abortSubmission(id, BACKGROUND, conversationId)`: it withdraws queued input only.
  `already_placed` means the run continues; never implement row removal with `PiHarness.abort` or Stop. Passive writes,
  helpers and routine queues remain outside this API.
- Extensions: `persona.ts` (static system prompt sections, keep them static so prompt caches hold),
  `resident-mcp.ts` (`mcp_list`, `mcp_call`), `ask-user.ts` (`ask_user`), `budget.ts` (usage recording, tool
  blocking), `subagents.ts` (`subagent`, with the anchor task; a subagent gets this extension too, so they nest) and
  `subagent-relay.ts` (the relay task that carries each message and reports the final answer, ADR 0018) and, on threads only, `thread.ts`
  (`share_back`, titles). Tools with side effects are `replay: 'unsafe'`.
- Close aborts each closed conversation with `abort({ background: true })` so its relays stop too; never use a
  background abort on main, which owns memory and routine tasks. The workspace feed reads `watchTaskGraph()`:
  a non-background task means working, a live `goblin.subagent-relay` means waiting. Stop or Close of a subagent
  aborts the relays carrying to it first (`dropRelaysTo`): a relay parked on helpers would otherwise wake and report.
  A relay that waits on other tasks parks with `{ status: 'waiting', on, policy: 'allSettled' }` instead of holding its
  invocation.
- An extension's background tasks resume after a restart only while the extension is installed: keep task names and
  versions stable, and give a changed task a `migrate`.
- A task phase must commit durable progress: committing the same checkpoint again faults the task ("returned without
  durable progress"). A looping phase carries a counter. A faulted task skips its own clean-up, so whatever records a
  running task checks the task's record (`tx.task(id)`) instead of trusting a flag the task clears.
- A head marker (`head` on an entry: compaction, reset, goblin's `app.memory` view) starts the model's context and
  the snapshot at its head. Never write `head: 'self'` into a busy conversation: at a boundary it acts as a reset.
- A tool that needs a person ends the run (`control: { terminate: true }`) and leaves plain text in its result. The
  answer is the next ordinary user message: never hold a run open waiting for the owner. `ask_user` and `mcp_call`'s
  grant-required result both work this way.
- Pi's generation hooks may report and swallow exceptions. The pinned ToolTask's beforeTool catches a throw as a
  block, but a blocked call skips afterTool. Ask-first prepares in beforeTool and emits its terminating approval
  marker from the tool body; the body and shared dispatch seam independently recheck policy (ADR 0028).
- Tool implementations check resident authority, the conversation's capability scope (`Capabilities.scope`) and
  grants before any outbound call, and never hold a SQLite transaction across model or network work. Something
  switched off returns `capabilityOffResult` (`pi/capabilities.ts`); the owner turns it on from a card.
- Events are a snapshot plus committed batches with no cursor replay.
- Browser URLs, snapshots and SSE routes carry chat ids. Resolve them at the boundary, then use the returned Pi session
  for Pi APIs. `chatOf(session)` maps capability and task activity back to the current chat; unknown sessions fail
  closed. Pi-keyed approvals, App call records, run events, skill activations, fork entries and memory entry ids stay
  on their original Pi identities deliberately. A helper's `parent_session` is its parent chat; immutable
  `spawner_session` holds its original anchor and relays. Primary memory resolves the current session, with Builder
  state on the generation API's `conversationId`; the memory store remains agent-wide. See
  [ADR 0030](../../../docs/adr/0030-logical-chats-over-pi-sessions.md) and the development guide's permuted-primary
  native profile for unit/local workerd proof. Move to thread and per-Topic memory remain future work.
- Topics (ADR 0032): a Topic's Conversation is a **new** `sessions.create()` session configured explicitly (extension
  list and Personal's tool filter), never a fork of Personal. Threads, "+" threads and subagents inherit their
  parent's `topic_id`; a "+" thread announces itself in its Topic's Conversation (`conversationAbove`). Inbound,
  Telegram and `recentOwnerMessages` keep resolving `primary()`. Archive stops a Topic's chats through the owner's
  Stop, never a background abort of a Conversation, and refuses new work until Restore, which restarts nothing.
- Start thread (ADR 0034, `chats/thread-heads.ts`): a Thread is made once per owner operation (`origin_op`), forked at
  the chat's newest entry outside a running turn (`pi/turns.ts`, never inside one), then `app.thread_head` goes into
  the chat as a passive write (`thread-head:<op>`) before the message enters the Thread through `submitOwner`.
- Vendor tables (`pi_*`, `cf_agents_*` and the others in `storage/vendor.ts`) are never touched.
- Initialization, readback and reconstruction are separate proofs; local workerd reconstruction is not remote
  eviction.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/harnesses/pi/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

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

- Event routines consume the shared static Events handler at the confirmed revision. Seal scrubbed bounded metadata outside Pi commits, label it as untrusted data, preserve event run IDs across definition revisions and ingress retention, and commit a pending handoff with its consumer ACK. Admission is one event/minute per agent; controls never start model work.

- Home layout remains application metadata (`home/service.ts`), separate from Pi transcripts. The dashboard UI is deferred: do not offer Home tiles or imply layout edits are visible. Runtime tools still enforce operation ids, revisions, owner authority and terminating owner asks; routine/subagent extension lists exclude Home.

- The composer is a browser affordance over stable server-side selections. `/` chooses local commands or skills and `@`
  chooses connections, skills or helpers. Resolve each selection again before `useModel`; catalog labels never authorize
  a call. Helpers receive live MCP, skills, files, code, app calls and delegation, while owner-only questions, Home,
  routines, memory and skill learning stay absent. `subagent_config` adds exclusions only, and retained helpers receive
  the current execution extension selection after reconstruction.

- `code_run` may write owner files and is `replay: unsafe`; after an interrupted invocation, Pi reports the interruption and never automatically runs the script again. The native recovery regression writes, evicts, and reads the unchanged file through the reconstructed agent.
