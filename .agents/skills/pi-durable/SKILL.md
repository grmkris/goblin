---
name: pi-durable
description: Change goblin's Pi Durable and PiHarness integration - sessions, submission, extensions and tools, persona, event projection, or reconstruction tests.
---

# Pi Durable in goblin

Pi Durable owns transcripts, tasks, steering and recovery. Use the pinned native harness; do not rebuild these.

- `PiHarness` is registered with `lifecycle.use` in `PersonalAgent`. Main is the stable chat id `PRIMARY_CHAT` (`1`),
  resolved by `Chats` to its current Pi session; a fresh agent initially maps it to Pi's root. Inbound clients
  talk in the primary chat with an author tag (`pi/content.ts`). Threads are Pi forks of main at an entry, or
  `sessions.create()`; every one is registered in `app_conversations` (`chats/conversations/`), and only registered chat
  ids resolve to sessions at the owner boundary. Raw Pi calls outside a task take `BACKGROUND` from `pi/context.ts`.
- Writing into another conversation (a thread's note into main) is a write submission, never `tx.appendEntry`:
  `submit({ type: 'write', entry, requestId })`. A busy conversation places it at its next boundary, the request id
  makes a replayed tool find the same entry, and a write starts no run.
- Extensions for one kind of conversation are installed in the registry but left out of `settings.extensions` (the
  default list), then added per conversation: `fork(..., { agent: { extensions: { add } } })` or `configure`.
- Agent apps (ADR 0021) are the exception that is live: `settings.extensions` is a getter over the defaults plus the
  apps' extensions (`pi/harness.ts`), read at every use, so `registry.install` of an app's extension is offered from
  the next model request. Never add one per conversation with `configure({ extensions: { add } })`: it replaces the
  stored add list (a thread would lose its own). The harness factory installs the apps before `Harness.open`, because
  it runs before `onStart`; the agent's constructor made the application tables. A generated tool pins its release with
  `api.memo('goblin.release', …)` and uses `c<conversation>:<call>` as its operation id.
- `configure` changes only the fields it is given (`null` clears one). goblin uses the per-conversation `tools`
  filter for one thing: `{ remove: subagentTools }` where a chat may not start subagents (its Topic's setup or its
  spawner's exclusions; `setup/`, ADR 0040). A fork starts from its parent's agent at the fork entry, so a new thread sets its extensions (the host's plus
  the thread's, `instructions: null` to drop a subagent's), and its filter, explicitly (ADR 0017).
- Observing Pi means its commit listener, not hooks: `subscribeCommits` sees every conversation's committed entries,
  tasks and submissions, and the run ledger (`telemetry/pi.ts`, ADR 0024) is attached in the harness factory as soon
  as `Harness.open` returns. A listener runs inside Pi's commit: if it throws, Pi faults the user's task, so guard it,
  keep it synchronous and never call Session APIs from it. Hooks do not pair reliably (no `afterTool` for a blocked
  call, no `afterResponse` after an abort) and subagents and routine runs keep their own extension lists.
- Submissions carry stable operation IDs. Acceptance is not completed external work; never claim exactly-once effects.
- Extensions take the agent's bridge (`runtime/bridge.ts`) as their way into its services: `run`. A hook calls it; a
  program never calls it from inside an Effect. New Effect code reaches Pi through `PiSessions` (`pi/sessions.ts`): every call
  names its session, failures are a typed `PiFailure`, and interrupting a `wait` ends only the wait.
- Owner, inbound and Telegram submissions admit `(chat, operationId)` through `ChatOperations.send` before calling
  Pi. The operation's receipt pins the Pi session it was admitted to, so a retry submits there again; the per-chat lock
  covers admission only and is released before model execution or waiting. `PiSessions.wait` resolves through that
  binding. Nothing rebinds a chat (ADR 0030): Move to thread forks a new Thread instead. The application ledger prunes
  old operations opportunistically after 30 days. Passive reports, share-backs, thread-start notes, memory views and
  subagent reports take the target chat's admission lock (`ChatOperations.passiveWrite`) to resolve its current
  session and submit with stable Pi write request ids; they start no model run. There is one lock per chat
  (`ChatOperations.withChat`, `KeyedLock`); chat resolution is functions of the database (`chats/directory.ts`), read
  through `Chats`.
- The owner queue reads `InboxDoc` for Main and ordinary threads only. Removal validates the registered conversation
  and input type, then uses native `abortSubmission(id, BACKGROUND, conversationId)`: it withdraws queued input only.
  `already_placed` means the run continues; never implement row removal with `PiHarness.abort` or Stop. Passive writes,
  helpers and routine queues remain outside this API.
- Extensions: `persona.ts` (static system prompt sections, keep them static so prompt caches hold),
  `resident-mcp.ts` (`mcp_list`, `mcp_call`), `ask-user.ts` (`ask_user`), `budget.ts` (usage recording, tool
  blocking), `subagents.ts` (`subagent_spawn`, `subagent_send`, `subagent_stop`, `subagent_config` and
  `subagent_status`, with the anchor task; a subagent gets this extension too, so they nest) and
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
- Tool implementations check resident authority, the chat's scope (`Setups.scope`: its Topic's setup, ADR 0040)
  and grants before any outbound call, and never hold a SQLite transaction across model or network work. Something
  outside the scope returns `outsideScopeResult` (`pi/setup.ts`); outside the Topic's setup, the owner adds it
  to the Topic from a card.
- Events are a snapshot plus committed batches with no cursor replay.
- Browser URLs, snapshots and SSE routes carry chat ids. Resolve them at the boundary, then use the returned Pi session
  for Pi APIs. `chatOf(session)` maps capability and task activity back to the current chat; unknown sessions fail
  closed. Pi-keyed approvals, App call records, run events, skill activations, fork entries and memory entry ids stay
  on their original Pi identities deliberately. A helper's `parent_session` is its parent chat; immutable
  `spawner_session` holds its original anchor and relays. Each Topic Conversation's memory (`ChatMemory`, keyed by
  chat id) resolves the chat's current session on each use, with Builder state on the generation API's
  `conversationId`; the builder runs only for a Conversation, and `zoom` reads the Conversation above its caller. See
  [ADR 0030](../../../docs/adr/0030-logical-chats-over-pi-sessions.md) and the development guide's permuted-primary
  native profile for unit/local workerd proof.
- Topics (ADR 0032): a Topic's Conversation is a **new** `sessions.create()` session configured explicitly (extension
  list and Personal's tool filter), never a fork of Personal. Threads, "+" threads and subagents inherit their
  parent's `topic_id`; a "+" thread announces itself in its Topic's Conversation (`conversationAbove`). Inbound,
  Telegram and `recentOwnerMessages` keep resolving the primary chat. Archive stops a Topic's chats through the owner's
  Stop, never a background abort of a Conversation, and refuses new work until Restore, which restarts nothing.
- Start thread (ADR 0034, `chats/thread-heads.ts`): a Thread is made once per owner operation (`origin_op`), forked at
  the chat's newest entry outside a running turn (`pi/turns.ts`, never inside one), then `app.thread_head` goes into
  the chat as a passive write (`thread-head:<op>`) before the message enters the Thread through `submitOwner`.
- Personas (ADR 0033): a tagged send admits the operation, writes a passive `app.persona_ask` and creates background
  `goblin.persona-turn` tasks (guarded by `app.persona-asks`); it starts no Goblin run. A turn forks in a task commit
  (`tx.forkConversation`, task-owned), edits the fork's stored selection **by name** (`personaSelection`: `agent.extensions`
  and `agent.tools` are replaced as a whole, never merged by `configure`), puts the frozen revision in the context tail
  through a `beforeRequest` hook keyed on the `app.persona-turn` document, and writes the answer back as `app.persona`.
  The fork is a hidden `persona`-role thread with a `subagents` exclusion; it never has the delegating, organizing or
  asking tools. A task's passive writes go through `Conversations.writeEntry`, because a task's conversation
  handle submits inputs only. Delegate reports are passive `app.delegate_result` writes unless the spawn set
  `synthesize: true`. Organize tools write `app_organize_receipts` in the same synchronous step as the change.
- Cross-Topic retrieval (ADR 0035): `goblin.retrieval` is in the default extension list (Conversations and threads,
  not subagents or routine runs). The transcript index reads `Conversation.entries` in entry-id windows and indexes only
  entries whose `conversationId` is the session (never forked history, never `role = 'persona'` forks), redacted and
  bounded, into `app_transcript_*`; its `afterResponse` catch-up is fire and forget. `search_chats` records its frozen
  sources under the call id, so a replay returns them unchanged. Automatic retrieval is a `beforeRequest` hook: it picks sources once per input
  (task memo `goblin.retrieval:<entry>`), puts at most three in the context tail and records them; it never holds a
  transaction across its cheap-model rerank. Move to thread calls `reassignExcerpts(db, session, fromEntry, chat)`.
- Move to thread (ADR 0034, `chats/mover.ts`) moves only the newest finished turn: the Thread is a fork at the turn's
  last entry (`pi/moves.ts`, a witness document per operation so a restart never forks twice) and the chat omits the
  turn with Pi `edits` in its `app.thread_head`; it never rebinds the chat, whose session would otherwise deepen by one
  fork per move. The turn's helpers' relays are handed to the Thread with their delivery request ids (`handover` in
  `pi/subagents.ts`); stopping a relay waits for it, so never do it under the chat's admission lock. The chat's memory
  forgets the turn (`forgetFrom`), its collector skips entries a later entry omits, and the transcript
  index gives the turn to the Thread (`reassignExcerpts`).
- Vendor tables (`pi_*`, `cf_agents_*` and the others in `storage/vendor.ts`) are never touched.
- Initialization, readback and reconstruction are separate proofs; local workerd reconstruction is not remote
  eviction.

Before changing an API call, read the current [documentation](https://developers.cloudflare.com/agents/harnesses/pi/) and the installed package's declarations; the
lockfile pins the versions. [Architecture](../../../docs/architecture.md) describes how goblin uses it today.

Inner loop: `bun run check:files <paths>`. Before calling it done: `heavy bun run check`. This skill does not by
itself authorize model spend, external messages, deployment or production changes.

- Routines use `routine_propose`, `routine_list` and `routine_pause` (ADR 0027); only the owner confirms an exact revision through the owner
  API (every write needs the CSRF header). Native dated schedules are fenced by app revision/firing watermarks. Background Pi Anchor/Reporter tasks own
  empty run conversations; register them without copied main capabilities or an ordinary main-start note. The confirmed
  ceiling lives in `Setups.scope`; management, Skills, subagents, main memory and learner are absent from run
  extensions. Check the dedicated per-run provider on every model dispatch, including compaction, and MCP authority
  on every HTTP attempt after token refresh. Never depend on swallowed Pi hook exceptions to stop a model request.
- Project committed `pi.usage` through app-only cumulative watermarks and stable UTC-day receipts. Passive reports use
  the actual parent `Conversation.submit` write API; acceptance starts no main model turn. Sealed questions resume the
  same run, release executing slots while waiting, and retain the single-routine lock. Run Stop/archive fence and abort
  owned work; main Stop spares background runs. Frozen Telegram copies of notices and their remote receipts are
  separate from Pi acceptance. Local workerd evidence and retained-dev acceptance remain distinct.
- A routine handed to a Persona (ADR 0041) runs in its own run conversation with the Persona's text in the context tail
  (`markPersona`, `personaText(…, 'routine')`), never a Topic fork; its completed answer is the Persona's `app.persona`
  entry with the routine's link. A Persona turn that stops on goblin's own approval or grant marker writes its hold
  into the answer; the owner's reply resumes the same `goblin.persona-turn` task kind with `resume: { fork, text }`.

- Event routines consume the shared static Events handler at the confirmed revision. Seal scrubbed bounded metadata outside Pi commits, label it as untrusted data, preserve event run IDs across definition revisions and ingress retention, and commit a pending handoff with its consumer ACK. Admission is one event/minute per agent; controls never start model work.

- The composer is a browser affordance over stable server-side selections. `/` chooses local commands or skills and `@`
  chooses connections, skills or helpers. Resolve each selection again before `useModel`; catalog labels never authorize
  a call. Helpers receive live MCP, skills, files, code, app calls and delegation, while owner-only questions,
  routines, memory and skill learning stay absent. `subagent_config` adds exclusions only, and retained helpers receive
  the current execution extension selection after reconstruction.

- `code_run` may write owner files and is `replay: unsafe`; after an interrupted invocation, Pi reports the interruption and never automatically runs the script again. The native recovery regression writes, evicts, and reads the unchanged file through the reconstructed agent.
