# The agent object

## The agent object

`PersonalAgent extends Agent` and registers the native `PiHarness` with the Agent lifecycle. Pi owns transcripts,
tasks, submissions, recovery and tool replay. PiHarness and Pi Durable are experimental; Alchemy is a pinned beta and
Drizzle an RC. `@shadcn/react` is pinned at 0.3.1 and patched (`patches/shadcn-react/README.md`): its MessageScroller
carries unreleased upstream fixes. The owner reaches the object through its typed API (`onRequest`, see The owner
API) and the Worker's other callers through the internal one; one RPC method is left, `deleteAgentData`.

The object's constructor migrates the application tables first (synchronously, as the Agents SDK makes its own): the
lifecycle's start opens Pi, whose apps and run ledger read them, before `onStart`, and an RPC or the runtime may come
before either. The object builds one Effect `ManagedRuntime` lazily, on first use, from `AgentLive` (`layers/index.ts`).
A runtime that fails to start is dropped, so the next caller starts it again; `deleteAgentData` closes it. What the
services need from the instance (its storage and env, the Pi pieces and kits its constructor made, the schedules it
arms) is one record, `AgentInput` (`runtime/input.ts`). The layers build in a fixed order, each over everything before
it:

- **Core** (`layers/core.ts`): `AgentInput`, the application database (`Db`), the change bus (`Changes`), Pi's calls
  as Effects (`PiSessions`), the per-key lock (`KeyedLock`), keyed single flights (`SingleFlight`), conversation flow
  events (`FlowEvents`), resident authority (`Resident`), and goblin's
  content-free logger and failure reporter in place of Effect's defaults (see Logs, failures and references).
- **The start** (`layers/index.ts`): the agent's start, step by step in one fixed order, each step a layer in its
  owning area's file and built after every step before it, so each await holds up the steps after it. In order: the
  MCP host (each server's endpoint binding checked, so a re-pointed server loses what it had, the credential cipher,
  held calls a restart cut off recovered); the cheap models; helper execution restored; routine runs, with their
  usage projection subscribed to Pi's commits; main registered; the App
  registry; every Topic Conversation given memory; skills; and Events. The skills consumer is registered during
  start; the routines and Sources layers register their consumers before the agent runs anything. A stateful object is made once, by its step, and shared as that step's service;
  programs use the area's services. No step rewrites data an older version left: goblin is greenfield (ADR 0067).
  The conversation services publish `conversations.changed` with what each write changed, from inside the write; the
  App registry and the workspace feed follow that topic. A move a restart interrupted finishes once the conversation
  layer is built (`Moves` forks its reconcile in the layer's scope), never holding up the start.
- **One layer per area** after the start, in order: the daily token usage and picker (`Budget`, `Models`, which a
  send's admission reads), conversation (`Chats`, `ChatOperations`, `Conversations`, `Moves`), setup (`Setups`),
  knowledge (`Memories`, `Retrieval`), delegation (`Topics`, `Personas`, `Invocations`, `Receipts`), routines
  (`Routines`, `RoutineControl`), Sources (`Sources`), inspection (`Inspection`), apps (`AppEngine`, `Files`), the skill learner (`Learner`,
  after the owner's files and the routines' notices it writes), the workspace feed
  (`Workspace`) and HTTP (`AgentHttp`). The MCP host's `McpConnections`, `McpServers`, `McpGrants`, `Approvals` and
  `Cipher`, and `CheapModels`, `RoutineRuns`, `RoutineUsage`, `Apps`, `Skills` and `Events`, are served by
  their start steps.

`AgentServices`, every service a program may require, is derived from the layers, so no area edits a shared union. A
service is a `Context.Service` tag in its area (`<area>/service.ts`) whose methods are `Effect.fn` Effects with typed
`AppError` failures. A synchronous Drizzle store is a set of functions of the agent's database (`Db`), or a plain class
where it keeps state, wrapped once where its service is built; nothing builds a second of a stateful one. The Worker
runs its own programs (the edge, the Events webhook, the internal API's client) through `runAtEdge`
(`http/api/edge.ts`).

Inside the agent there are exactly two ways into Effect ([docs/agents/effect.md](../agents/effect.md)), and programs use
neither: they compose. `tools/graph.ts` closes both to the files it lists (`boundaries/no-closed-import`).

- **The bridge** (`runtime/bridge.ts`), for code the runtime does not own: the Pi extensions and kits, the alarms, the
  apps engine and its Dynamic-Worker powers, and `onRequest`. `run` rejects with the `AppError` the program failed with; `exit` returns
  the program's exit, which `onRequest` answers. Every program it runs reports an `Internal` failure or a defect with
  its code location (`runtime/instrument.ts`). `agent.ts` hands the bridge to what it builds; `AgentInput` does not
  carry it.
- **`promiseWith(context)`** (`runtime/boundary.ts`), for a foreign callback wired inside a layer that must answer a
  Promise: the MCP SDK's auth provider and dispatch guards, and the skills guard. It rejects with the typed failure
  itself, so an `AppError` crosses the SDK unchanged.

Erasing the agent disposes its runtime, whose layers' finalizers close every MCP connection.

- `KeyedLock` (`observability/lock.ts`): mutual exclusion per key, strictly first come, first served (Effect's
  `Semaphore` wakes waiters in no fixed order). It is held for admission only, never across a model call or another
  wait. Topic creates, retrieval catch-up, an agent app's state changes, chat admission (`chat:<id>`, which the mover
  and every passive write take too) and a thread operation (`thread-op:<op>`) take it.
- `SingleFlight` (`observability/single-flight.ts`): one keyed run at a time across waits, forked in the layer's scope
  so interrupting its first caller does not cancel it. `run` joins every caller to it: an MCP token refresh
  (`mcp.refresh:<server>`) and connect (`mcp.connect:<server>`), a skills listing (`skills.listing:<server>`) and a
  move's remaining steps (`move:<op>`). `skip` answers at once while one is in flight: naming a thread
  (`naming:<chat>`) and the skill learner (`skills.learn:<conversation>`).
- `Changes` (`runtime/changes.ts`): a synchronous topic bus with no fibers or timers. An area declares its topics where
  it publishes them, with ids as payloads (`conversations.changed`, `topics.changed`, `personas.changed`,
  `invocations.changed`, `receipts.changed`, `apps.changed`, `apps.removed`, `agent-apps.changed`), and
  the workspace feed reads each item as it is then. Handlers run inline in order; a failing one is reported and ends
  only itself.
- `PiSessions` (`pi/sessions.ts`): Pi's submit, write, wait, abort, model choice, event stream and reads as Effects
  with a typed `PiFailure`. Every call names its session, and interrupting a `wait` ends only the wait.

Conversations (`chats/conversations/`): every agent has one **main** conversation, stable chat id `1` (`PRIMARY_CHAT`),
where the owner's browser and every inbound MCP client talk. The chat directory (`chats/directory.ts`, read through
`Chats`) resolves that chat to its current Pi session. A fresh agent starts with Pi's root session `1`; `/c/1` stays the same whatever session it names. A message
from anyone but the owner's browser starts with an author tag block (`[from Claude Code]`, the `authorTag` contract),
so the model and the web both know who wrote it. Side
**threads** are Pi conversations of their own: branched from a message of any open conversation (a Pi fork at that
entry, so the thread sees its parent up to there and the parent never sees the thread), at any depth, or empty under
main (ADR 0017). `app_conversations` registers each one as a chat tree (`parent_session`: its parent chat), with its
kind, title, origin and close time. Its existing `session_id` primary key is the stable chat id (`chatId` in Drizzle);
`pi_session` names the current Pi session, uniquely owned by that chat, and `role = 'primary'` marks Main (`epoch`
is kept, unused: nothing rebinds a chat). Every chat row goes in through one inserter, `registerChat`
(`chats/directory.ts`; `Chats.register` for programs). A helper's immutable `spawner_session` keeps its anchor and
relays on the Pi session that started them.
A chat id reaches Pi only after the directory resolves its registered session, so no request opens a conversation by
guessing its number. Pi cannot delete a conversation, so Close stops a
conversation and everything under it and keeps it readable until Reopen; main never closes. The web
shows the Topics as channels in the app's sidebar (`components/shell/sidebar.tsx` over the pure `lib/topics.ts`):
Personal first, then by name, the archived folded at the end, each bold with a dot while it has unread replies and a
pulse while its agent works, with one flat level under it of its threads at work, unread, recently opened in this
browser or showing now (`topicThreads`); the open agent apps follow. A server without Topics implies Personal alone,
holding Main, and shows no Topic controls. With Topics, Add topic names a new one (`POST /api/topics`, one operation id
per opening of the dialog) and opens its channel; the channel's `#name` opens its menu: Rename, Exclude from search or
Include in search, and Archive or Restore (never Personal), all `PATCH /api/topics/:id`. An archived Topic's channel
shows a banner with Restore in place of its composer.
Unread is the server's: `read_at` on
`app_conversations` is the owner's read mark, set when a chat has been shown for a moment (half in view, the page in
front). A channel is `/c/:id`; its threads open in the thread panel beside it (ADR 0036, `components/shell`):
`/c/<channel>?thread=<id>` names the thread on top, `stack=` the threads under it where its parents would not derive
them, and `reply=<chat>-<entry>` or `reply=new` a draft on top (`lib/panel.ts`); a thread's or subagent's own `/c/<id>`
opens its channel with the panel showing it. Under the message a thread started from, a summary (reply count, when the
last reply came, a dot while unread, a pulse while it works) opens it; threads opened inside a thread stack with a back
crumb. A message offers Reply in thread, Copy and Details in a small toolbar over its top edge where a pointer rests,
and on a touch screen once the message is tapped. Reply in thread opens a draft in the panel, with the focus in its
composer, that branches the thread only when it is sent, because Pi cannot delete a conversation; `/new-thread` moves the
composer's draft into a new thread's draft the same way. A draft's (Reply's or "+"'s) first send is one call of the
thread operation under the draft's one operation id: it makes the thread and sends that message as its first. A send
meanwhile waits for the same thread and goes into it as a message of its own, and a retry asks for the same thread
again (`lib/draft-thread.ts`, `components/shell/thread-start.ts`). Details opens a sheet of what ran behind the message
(`GET /api/conversations/:id/details?entry=`, the inspect group): its operation in a few lines, its steps in order with
their status and duration, the operations it led to, and what was not recorded; a message with nothing recorded says
so. The channel and the panel follow conversations through one
stream pool (`lib/stream-pool.ts`): one event stream per conversation however many show it, at most eight following
beyond those on screen, and one off screen stops following after ten seconds, resuming from a fresh snapshot when it
comes back. Start thread, a toggle in the composer (and `/new-thread`), posts the message as the head of a new thread whose
reply lands there (`POST /api/conversations/:id/threads` anchored at `latest`; the runtime writes the
`app.thread_head` into the chat it started from), and the panel opens on it; turning it off keeps the draft, its
files and references. Move to thread, in the toolbar of a channel's newest owner message (`POST …/move`,
`movableEntry` in `lib/threads.ts`), waits while that turn's reply streams, then leaves the message as the thread's
head and opens the thread; a refused receipt's reason (`not_latest`, `awaiting_approval`, …) shows as one short line
under the message until the turn changes. The transcript draws what those runtimes write
(`components/parts/drawn-parts.tsx`): a thread's head with the thread's summary ("Moved to a thread" for a moved
turn, whose own entries a later entry's edits omit), the owner's message to Personas with whom it went to, a Persona's
answer and a Delegate's result as attributed messages (a mark, a name, Persona or Delegate), and a Topic's brief.
Personas still answering show after the transcript ("answering…", from the feed's invocations). With Personas on the
server the composer offers them as `@` references (with their avatars), and with two or more tagged a Together or
In turn choice that is sent as `personaOrder`. What an answer used from other chats shows as a strip under it: a
`search_chats` call's `SourcesDetails`, and automatic retrieval from `GET /api/conversations/:id/sources`
(`lib/sources.ts`), each source opening its chat.
A thread started with "+" tells its channel its name once it has one (ADR 0010): the channel gets one
`app.thread_started` note, `[thread started: "<title>"]`, and its transcript shows that thread's summary.
**The thread operation** ([ADR 0034](../adr/0034-move-to-thread.md), `chats/thread-heads.ts`) is one idempotent call for
Reply, "+" and Start thread: `POST /api/conversations/:id/threads` with `StartThread` (`{ operationId, anchor, message,
personaOrder? }`) makes the Thread at `anchor` (`{ entry }` forks there, `empty` starts one under the Conversation the
chat sits under, `latest` forks at the chat's newest entry outside a running turn, or starts empty when it has none),
in the same Topic, then submits `message` into the Thread through the ordinary owner path as `<operationId>:first`,
with its Persona order. For `latest` (Start thread) it first writes an `app.thread_head` entry (`ThreadHeadData`,
request id `thread-head:<op>`) into the chat as a passive write whose model text is a bounded `[the owner started a
thread: "…"]`. `app_conversations.origin_op` (unique) makes one Thread per operation id, also for concurrent repeats,
and `POST /api/conversations` with an `operationId` goes through the same path. The web keeps a Reply or "+" draft in
the browser until its first send, which is this one call.
**Move to thread** (ADR 0034, `chats/mover.ts`) moves a channel's newest finished turn into a new Thread:
`POST /api/conversations/:id/move` with `MoveToThread` returns a `MoveReceipt` (the same operation id, the same
receipt). The Thread is a Pi fork of the chat at the turn's last entry, made a thread in its Topic, whose setup it
works with; the chat keeps its session and gets an `app.thread_head` (`moved: true`, request id `thread-head:<op>`) whose
model text is only `[moved to thread "<title>"]` and whose Pi `edits` omit the turn's own entries from the chat's
model context. Helpers the turn started report to the Thread from then on (their relays are handed over), the threads
branched from the turn and its App placements move under it, the chat's memory forgets the turn
(`forgetFrom`; its collector skips omitted entries), and the transcript index gives it to the Thread. A
turn still running, an older turn, a turn already moved and a turn waiting on an MCP approval are refused with a
reason (`streaming`, `not_latest`, `moved`, `awaiting_approval`). Each move is an `app_chat_moves` row (`requested`,
`forked`, `settled` or `refused`) that a restart finishes; Pi cannot move a running turn, so this settled-turn move
is the only one (ADRs 0034, 0067).

Queued inputs in Main and ordinary threads stay in Pi's native `InboxDoc`. The browser projects native inbox IDs
and modes, then reads contents through `GET /api/conversations/:id/queue`; helper and routine queues are absent
from this view, and passive writes are excluded. The shared conversation stream owns one cancellable queue read,
refreshes on snapshots, inbox updates and accepted sends, retains last-known contents during errors, and retries with
backoff. Native membership filters every response so stale reads cannot resurrect placed inputs. Both full and inline
composers show the same ordered queue outside the transcript and turn map. An unchanged failed draft reuses its
operation ID; acceptance clears it, so deliberate repeated messages get distinct submissions.
Each queue row has a Remove action. `DELETE /api/conversations/:id/queue` checks the registered owner conversation
and input type, then calls Pi's native `abortSubmission` with the conversation ID. Pi removes only a waiting input;
placement winning the race returns `already_started` without interrupting the run. Repeated removal returns a settled
outcome. Only the selected row is busy, failures keep it visible, and native inbox updates refresh every view.

The conversation-scoped routes of the owner API: the `conversations`, `inspect`, `workspace`, `files`, `apps` and
`agentApps` groups (a raw handler marked raw). Like every owner write, each write needs the CSRF header.

| Route | Purpose |
| --- | --- |
| `GET /api/workspace/events` | Raw. The workspace feed (SSE): a `WorkspaceSnapshot` of every conversation and kept App and what each conversation that is not idle is doing (`working`, `waiting` on subagents), then batches of `WorkspaceChange` (`workspace/live.ts`, from Pi's task graph and the registries' writes). A tab skips any item or change it cannot read, so a newer server never stops it. |
| `POST /api/apps` | Keep the App of a call in a conversation (`{ conversation, callId }`): one made before Apps were kept, or one closed. The call must be an `mcp_call` whose tool still renders that App; the same call keeps the same App. |
| `GET /api/apps/:id/launch` | What loads an App (`AppLaunch`): an MCP App's server and `ui://` resource, and the call's arguments and redacted result read back from Pi; an agent app's view module, stylesheet, frame bundles and state. It grants nothing. |
| `PATCH /api/apps/:id` | Close or reopen an App (`{ closed }`). Closing a conversation closes its MCP Apps. |
| `GET /api/apps/:id/state` | An agent app's state now, with its revision and release (`AppSnapshot`). |
| `POST /api/apps/:id/call` | An action an agent app's view calls (`AppCall`: name, arguments, the frame's operation id). Answers the state after it, or the app's own error (`AppCallResult`). |
| `POST /api/apps/:id/diagnostics` | A failure an agent app's view reported (`AppDiagnostic`); kept with the app's events at most every ten seconds. |
| `GET /api/agent-apps` | The owner's agent apps, newest change first, those without a view too (`AgentAppSummary`). |
| `GET /api/agent-apps/:name` | One agent app in full: versions, powers, schedules, today's use, files, recent events (`AgentAppDetail`). |
| `POST /api/agent-apps/:name` | A change by the owner (`AgentAppChange`): roll back, pause or resume a schedule, run one now, move its home, allow or revoke a power. Only the owner answers a power; the agent cannot. |
| `DELETE /api/agent-apps/:name` | Erases an agent app once the owner typed its name (`DeleteAgentApp`): tools, schedules, files and rows. |
| `POST /api/conversations` | The thread operation without a message (`CreateConversation`): an empty thread (`{}`, under `topic`'s Conversation when given) or a branch of an open conversation at an entry (`{ from: { conversation, entry } }`); 201 with its `ConversationView`. With an `operationId` the same id finds the same thread; without one each call makes a new one. |
| `PATCH /api/conversations/:id` | Rename, close or reopen (`closed`) a thread or subagent, or pin a subagent open (`keepOpen`). Closing stops it and everything under it; main cannot be changed this way. |
| `PUT /api/conversations/:id/read` | The owner has seen its newest reply: `read_at` moves forward to now, and the feed carries it as `readAt` (a later `lastReplyAt` is unread). |
| `GET /api/conversations/:id/composer` | Conversation-scoped connected servers, enabled skills by stable URI, existing helpers and unavailable libraries. |
| `GET /api/conversations/:id/queue` | Ordered queued input IDs, modes and contents for Main and ordinary threads, from Pi InboxDoc. Passive writes, helpers and routine inputs are excluded. |
| `DELETE /api/conversations/:id/queue` | Remove a queued input by positive safe-integer `submissionId`. Returns `removed`, `already_started`, `already_settled` or `not_found`; never stops a running input. |
| `POST /api/conversations/:id/threads` | The thread operation (ADR 0034): `StartThread` makes a Thread of this chat at `anchor` (`{ entry }`, `empty` or `latest`, which also posts the message as its head here) and sends `message` there as `<operationId>:first`. Returns 201 `{ thread, receipt }`; the same `operationId` returns the same Thread (another chat's is 409). |
| `POST /api/conversations/:id/move` | Move to thread (ADR 0034): `{ entry, operationId }` moves the newest finished turn the owner's message `entry` started into a new Thread. Returns the `MoveReceipt` (`state` `settled` with `thread`, or `refused` with `reason`); the same `operationId` returns the same receipt (another chat's is 409, a move already in flight in the chat is 409). |
| `POST /api/conversations/:id/messages` | Submit `input`, a stable `operationId`, optional `appContext` (by App id), up to eight `attachments` (owner file paths that must exist) and up to sixteen stable composer `selections`; skill-only input is allowed. Returns 202 acceptance. |
| `GET /api/files?dir=` | A directory of the owner's files (`FileListing`): `/uploads`, `/agent` or a folder under one, with the storage in use. |
| `GET`, `PUT`, `DELETE /api/files/content?path=` | Download or write (raw: the body streams, `content-length` required) or delete one of the owner's files. Downloads are attachments, except PNG, JPEG, GIF and WebP, which open in place; all are sandboxed by CSP. No files endpoint renews resident authority. |
| `POST /api/conversations/:id/stop` | Stop a conversation or one `operationId`, and the subagents it started (not its threads); answers `{ stopped }`, whether anything was running. |
| `GET /api/conversations/:id/snapshot` | The chat's Pi snapshot as JSON. |
| `GET /api/conversations/:id/events` | Raw. The chat's Pi events (SSE): a snapshot followed by committed batches. |
| `GET /api/conversations/:id/history?before=<entry>` | Earlier entries, oldest first, with a `more` flag. |
| `GET /api/conversations/:id/sources` | What the chat's answers retrieved from other chats (`SourceUse[]`, newest first, empty results left out): the source strips (ADR 0035). |
| `GET /api/conversations/:id/details?operation=` or `?entry=` | The `inspect` group: what happened behind one message, its operation's timeline (with its turn when it ran one) and the operations related to it (`InspectDetails`, ADR 0037). |

Every thread runs the `goblin.thread` extension (`pi/thread.ts`), added to that conversation alone when it is made;
main never has it. It tells the model it is in a side thread and offers `share_back`: when the owner asks (the
thread's "Share to …" button sends that request), the model writes a short note into the conversation the thread
branched from as a Pi write submission, an `app.shared` entry labelled `[from thread "<title>"]` that keeps the
thread's id, so the label in that transcript opens the thread. The parent's model sees it from its next request and
answers nothing, since a write starts no run. A thread branched from a subagent is made a thread: it gets the host's
extensions and `ask_user`, without the subagent's own selection and instructions. After each response an untitled thread is named by the memory model
from its latest exchange, in the background; the owner can rename it. A thread started with "+" is created with
`app_conversations.main_note = 'owed'`; once it has a title (the model's or the owner's) the same hook writes main
an `app.thread_started` entry with request id `thread-started:<id>` and marks the note `written`. The note carries
only the name, never what was said in the thread, and a later rename does not rewrite it. Branched threads already
show under their message in main and get no note.

Main and threads can start **subagents** with the subagent tools (`pi/subagents.ts`, after Pi Durable's background
subagent example): `subagent_spawn`, `subagent_send`, `subagent_stop`, `subagent_config` and `subagent_status`, one typed tool per action
(ADR 0027). A subagent is a Pi conversation owned by a background anchor task of its spawner, so the spawner's Stop
and idle waits do not reach it. It starts with the spawner's model and is given exactly the persona, the owner's MCP
and budget extensions, skills, files, code execution, app calls and the subagents extension again. Owner questions,
routine and app management, memory and skill learning remain absent. Spawn exclusions and `subagent_config`
narrow servers, tools, skill libraries, apps and delegation against every live ancestor. Retained helpers get the
current extension selection through Pi configuration on reconstruction (ADRs 0018 and 0029). Each message goes through a relay task in the
spawner (`pi/subagent-relay.ts`): it delivers the message, waits until the subagent is done (idle, with none of its
own relays live; it parks on those), then posts the newest answer once into the spawner's chat as a passive `app.delegate_result` (`[from
subagent <name>]` to the spawner's model, which sees it at its next turn and does not answer it), or as an input the
spawner answers once when the spawn set `synthesize: true` ([ADR 0033](../adr/0033-personas.md)). Request ids keep a restart from delivering or reporting twice; of
several messages on their way to one subagent only the last relay reports, quoting what the owner wrote. The subagent
then closes as done unless the owner wrote to it, branched from it or pinned it; a later message from its spawner
opens it again, while one the owner closed refuses its spawner. The owner's message to a subagent pins it open and
steers it when it is busy. Stop and Close stop the relays carrying to each subagent before aborting it, so a job cut
short reports nothing. The relay registers the subagent in `app_conversations` under its spawner, so the web lists it
there. In the spawner's transcript a spawn or send shows the subagent itself, live from the workspace feed
(`components/parts/subagent-block.tsx`, `lib/subagent-state.ts`): its state and clock, how many work under it, and
Stop (which asks first), Keep open, Dismiss or Reopen, opening to its task and its own subagents at any depth. A
report reads as "<name> reported back" with the report quoted, a subagent opens in the thread panel with "Task from
<spawner>", and
its composer steers it.

The shared native-textarea composer (`components/composer.tsx`, ADR 0029) opens `/` for skills and local commands and
`@` for connections, skills and helpers. Selected chips submit stable identities; unselected tokens remain prose.
`composer.ts` resolves current labels, live scope and verified skill instructions before model work. A connection
selection is a neutral hint; a helper selection adds its newest reported answer as bounded untrusted context here.
Structured composer metadata keeps selected labels and prose readable in the transcript. Failed resolution rejects
the complete send and marks its chip. `/new-thread` transfers the draft and portable attachment store to a new
thread's draft in the panel.

**Chat admission** ([ADR 0030](../adr/0030-logical-chats-over-pi-sessions.md), `chats/operations.ts`): every input into a
chat (the owner's message, an inbound client's ask, the owner's Source message) takes one admission sequence,
`ChatOperations.send`: within the budget, under the chat's lock (`KeyedLock`), the chat open, its **receipt** recorded
in `app_chat_operations` with the selected Pi session, a routine's waiting question answered, the session on the
owner's model, then Pi's submit (or the subagent relay), the receipt moved on to `submitted` (or `refused` with the
failure's type), and one flow event. A Persona ask takes the same admission (`ChatOperations.admit`). A retry uses the
recorded session; the receipt alone proves no Pi acceptance, so a retry still submits the same operation for Pi to
deduplicate. A receipt (`chats/receipts.ts`) says what the operation was (`kind`: send, ask_client, source,
persona_ask, start, reply, empty, move, `write:<entry kind>` for a passive write…), who started it (`origin`), the
chat it made (`target_chat`), the operation that led to it (`parent_op`), how it ended (`state`, `reason`,
`settled_at`); every admission writes its kind and state, so a row without them reads as `Internal`, and `receiptOf`
reads one synchronously by operation id. Passive writes (`ChatOperations.passiveWrite`: thread heads, shares, announcements, routine reports,
Persona answers, memory views) write their receipt and Pi's write under the same lock. Rows older than 30 days are
pruned opportunistically. The lock covers admission only, and releases before model execution or waiting for an
answer. Nothing rebinds a chat: Move to thread (ADR 0034) forks the moved turn's Thread and records a `move` receipt;
Topics and their memory are below.

**Setup and scope** (`setup/`): each chat works with its Topic's setup ([ADR 0040](../adr/0040-topic-and-persona-setup.md)).
`sessionScope(db, session)` (`setup/scope.ts`) maps the calling Pi session through `chatOf` to its current chat; `chatScope(db, chat)`
reads, live, the setup of the Topic at the top of its chain (a chat's `topic_id`), joined in a Persona's fork with the
Persona's, and narrows it for a subagent by the exclusions of every spawner above it (`subagent_config`, ADR 0018;
`app_conversation_capabilities` and `app_execution_exclusions` hold them), at any depth, then by a routine run's
allowed tools (an unknown or no-longer-owned session, a chat whose Topic is gone, or a broken or cyclic chain of
spawners, may use nothing). The scope also answers for agent apps (`app`) and names its Topic, so a refusal can say
what held it back. What the scope leaves out is hidden from the model: `mcp_list` leaves it out, the `skills` section
does not list or fetch that library, and Pi's per-conversation tool filter (`configure({ tools: { remove } })`) drops
the subagent tools, whose section then hides too. A chat's filter is set when it is made or configured, and applied
again to every chat of a Topic whose setup's subagents change (`retoolTopic`, which skips Persona forks and routine
runs, whose filters are set when they are made). A call that still arrives runs nothing: `mcp_call`, `skill_activate`,
`skill_read`, `subagent_spawn` and `subagent_send` check the scope before anything else (before the grant check or any
connection) and return an error result (`pi/setup.ts`, `outsideScopeResult`): when the Topic's setup does not hold the target,
details `{ kind: 'not-in-topic', target, topic }` (`NotInTopic`) that ask the owner to add it to the Topic, and Goblin
waits; in a subagent, a Persona or a routine the result has words only. The ask shows in the chat's `attention`. The
owner's console and an App view and job calls carry no conversation. Agent-initiated app calls carry their
conversation through nested apps and MCP powers, so its scope is checked live at dispatch; Sources use their routed Topic, and inbound clients
talk in Personal's Conversation, so Personal's setup covers them.

The per-conversation switches of ADR 0010 are gone; the only rows of their tables are a subagent's exclusions.

The persona contributes two static system-prompt sections (`pi/persona.ts`): who the agent is (it speaks of the
owner's connected MCP servers in general and names none of them, ADR 0063), and that remote content is untrusted data. The system prompt holds only text that does not change between requests: pi-ai folds every change
of it into the one leading system message, which empties the provider's prompt cache. What does change (the apps with
their versions, members and last errors; the skills on offer) goes into one trailing `<goblin-context>` message that
`beforeRequest` hooks add to each request (`pi/context-tail.ts`), marked as goblin's note and not the owner's. Its
`PARTS` table says what each part holds, which decides its quoting: the channel's and a Persona's owner guidance only
lose closing tags, retrieval's sources keep the tags they write, and runtime state keeps no tag at all, so remote text
can never pose as owner guidance. Pi never stores the block, so everything before it stays a cacheable prefix. The `mcp_list` and `mcp_call` tools
(`pi/resident-mcp.ts`) are how the model reaches the owner's MCP servers; both require current resident authority, and
`mcp_call` is marked unsafe to replay. `mcp_list` lists the connections with the owner's labels (two accounts of one
server are told apart by them; ADR 0041), connected ones first, so a connection never signed in does not win over the
one the owner connected; it names no server of its own accord (ADR 0063). A connection's tools come in brief, since the result stays in the model's
context and is paid for again on every later call: each tool's name, its description cut to one line of 160
characters, and only the flags that differ (`granted: false`, `askFirst: true`), with no
schemas. The tools the model names in `tools` come in full, with their input schemas (the server's, untrusted data),
and names it is not offered come back as `unknown`; the persona tells it to ask for the schemas of the tools it will
call. Asked with `events: true`, for a connection whose server offers Events, it adds the first 64 event streams with
their argument schemas (`events`, from `Events.catalog`, also untrusted), so the model can propose a routine on one;
unasked, `sendsEvents` says there are some. A catalog the connection's sign-in or the server does not let it read
leaves `events` out and the tools listed. A connection with more than forty tools whose names fall into services
(the prefix before the first `_`; one mysi connection lists about 130 as `<service>_<tool>`, ADR 0052) answers an
unfiltered listing with its `services` instead: each prefix, its tool count and its first few names, and goblin's own
`next` line telling the model to call again with `service` (one service's tools) or `query` (every word in a tool's
name or description). Both filters also narrow any listing, and naming tools in `tools` lists them in full as before. Refusals, held calls and the `skills` section name a connection the same way, `"<label>" (<connectionId>)`
(`named` in `mcp/servers/labels.ts`); labels never enter telemetry. `mcp_call` takes its `arguments` as an object or the JSON string of one, and returns the server's result as
Pi's MCP tools shape it (content blocks, `details.structuredContent`, `_meta` and the origin).
Remote result details and signed routine event metadata share `mcp/oauth/redaction.ts`: it scrubs exact credential-shaped
keys such as `accessToken`, `refresh_token` and `apiKey`, recursively. Public asset and usage fields such as
`rewardToken`, `token`, `tokens` and `tokenAddress` remain readable.

`ask_user` (`pi/ask-user.ts`) is how the agent asks the owner something. It takes one to five short questions:
single choice, multiple choice or free text. The tool result is the questions as numbered plain text, with details
`{ kind: 'question', questions }` (the `QuestionSpec` contract). It ends the run with `control: { terminate: true }`,
so no model call waits on a person. The answer is the owner's next ordinary message, whether it comes from the web
card or any other channel. A question counts as settled once a later user message exists.
A tagged Persona asks the same way ([ADR 0082](../adr/0082-personas-ask-with-ask-user.md)): `ask_user` ends its fork's
run, its `app.persona` answer carries `questions`, and the owner answers by tagging it again, so the next fork reads both.
Readers that show only text use `personaAnswerText` (the words, then the numbered questions). A routine's Persona run
has no `ask_user`.

The browser URL, snapshot, history and queue use chat ids. Server-Sent Events resolve the current Pi session at
connection: a snapshot of committed Pi entries, then batches, with a heartbeat. A chat keeps its Pi session, so its
stream is that session's; a reconnect starts again from a fresh snapshot. The workspace feed maps Pi task activity back
to current chat ownership. `ConversationView.primary` is an optional boolean; `WorkspaceSnapshot.primary` is an optional
chat id for compatible readers.

Every signed-in page sits beside the app's shell (`components/shell`, ADRs 0036 and 0078): one moss sidebar. At its
head goblin's mark (the channel this tab showed last), Jump to (⌘K, `jump-to.tsx`) and the places Activity, Work and
Apps; in the middle, which scrolls, the owner's pins and the Topics as channels, each with its live threads, then
Archived, Add topic and All threads; at its foot Connections, Personas, Settings and the account menu with Sign out.
Exactly one row shows where the page is (`lib/nav-highlight.ts`): an App's page marks its pin or Apps, never its
Topic. Its counts (`lib/rail.ts` `railCounts`): Activity what needs the owner plus the unread notifications, Work the
Delegates at work and the Personas answering, All threads the unread threads. On a desktop it collapses to a strip of
icons (⌘B; `data-sidebar` on the root, restored before the first paint from this browser's storage); on a phone it is
a drawer from the left edge (`DrawerSide` in `@goblin/ui`, `tone="shell"`) that the page's top bar opens, with a dot
while Activity has something, and a swipe left closes. The pages (`components/shell/pages`, over the pure
`lib/rail.ts`): All threads lists every thread, unread first, the closed folded; Activity collects what needs the owner
across Topics (each chat's `attention` from a server that reports it, and agent apps whose schedules need the owner),
Tell me's notifications (unread first, with Mark all read), the unread chats, and organizing receipts with Undo
(`POST /api/organize/:id/undo`, offered while the receipt is undoable); Work lists what runs (the Delegates at work,
the Personas answering), the routines with their controls, every agent app's schedules, and the recent results.
`/personas` lists the Personas; a click opens the profile (`/p/<id>`), never a chat: its definition (a glyph on a hue,
name, role, instructions, a model from the offered ones, and what it may use, which only narrows the owner's grants) saved as a new revision with the revision it was read at (`PATCH /api/personas/:id`, a conflict asks for a
reload), Archive or Restore, and its revisions. `/p/new` creates one (one operation id per visit). Connections and Settings are columns of titled sections (`PageSection`)
whose states read in words (`lib/labels.ts`), never the raw value the runtime sends. The workspace fills the page beside it. The transcript scrolls in a `MessageScroller` (from `@shadcn/react`, patched with upstream fixes that are not
released yet; `bun run check:patches` proves the patch is installed). Each of
the owner's turns (typed in the app or marked as the owner through a Source, `isOwnTurn` in `lib/parts.ts`) is a scroll anchor; a
message from an MCP client, a subagent, a routine or a thread's share-back arrives without moving the view. Until its
snapshot arrives a chat shows nothing. Conversations open at their end. A turn map in the transcript's right gutter
(`components/turn-map.tsx`) marks each of the owner's turns where it sits, with a band for what is on screen; hovering it
lists the turns and a click jumps to one. Without a fine pointer, or in a narrow window, an edge tab opens the list as a
bottom drawer that a swipe down closes. A new turn of the owner's pins near the top while its reply fits beneath it; once the turn is answered
past the fold, whether the reply grew there or arrived with it (a snapshot after the tab was away, a Source turn),
the view follows the bottom. It follows a streaming reply only while the reader is at the end, and otherwise offers a
jump back. A message just sent shows at once, before the stream confirms it (`lib/echo.ts`; the server's entry takes
its row), and a `Thinking…` row stands in after it and after every tool result until the model's thinking, answer or
next tool arrives, because a model's first content can take tens of seconds. A turn's thinking and tool calls fold into one
line each (`lib/work-groups.ts`): while it runs it names the step, settled it counts them, and it opens to the rows,
with calls in a row to one MCP server merged. A failed call, a request to the owner, a subagent, an App build and a
call whose App is open stay in the flow. The chat's bar and the composer float over the transcript as translucent chrome. Assistant Markdown is parsed by Streamdown (`components/parts/markdown.tsx`) and set by shadcn/typeset, whose append-stable rules keep earlier blocks still
while a reply streams. Streamdown splits a reply into blocks and renders each on its own, so a streamed batch renders
only the block being written; it stays in streaming mode once the reply settles, so the blocks are not remounted. Every
Streamdown renderer is replaced by its plain element. A reply may use a little HTML (`lib/reply-html.ts`: line breaks,
folds, keys, sub/superscripts, marks and edits, with no styles, handlers, frames or scripts), and its links and images
keep only absolute web addresses (and mail or footnotes for links); everything else becomes text
([ADR 0039](../adr/0039-chat-markdown-through-streamdown.md)). A code block is Goblin's own (`CodeBlock`): typeset's
code with a copy button, coloured by Shiki for the theme once the first code block loads it in the browser; Shiki and
its grammars never reach the first load or the Worker. A table in a reply (`ReplyTable`) scrolls sideways and has a
corner menu to copy it as Markdown, CSV or TSV, or download it as CSV, read from what is on screen. Math between `$$`
marks sets in KaTeX, loaded with its stylesheet the first time a reply holds `$$`; a single `$` stays a dollar sign.
While a reply streams, a caret follows its last paragraph, heading or list item, and its words fade in over 150 ms
(Streamdown's `animated`); with less motion asked for, they just appear. An image in a reply is a button naming it and its host; it is fetched only when the owner asks,
without a referrer, so a reply cannot make the browser call an address by itself (a prompt-injected image URL would
otherwise carry data out). A link stays a real link, but in the shell a click or middle click opens one shared dialog
(`LinkConfirmProvider`) showing the whole address and its host first, since a reply can name one place and point at
another; it then opens in a new tab without a referrer or opener.

Tool calls remain quiet expandable lines (`ToolCall` in `packages/ui`). Opening one shows labelled Input and Output
sections (`ToolPayload`), with the local `JsonView` adapted from MIT-licensed `mnove/json-view-cn`. The root opens,
nested branches fold, long strings expand on request, and each object or array shows 50 children at a time. The web
selector (`lib/tool-payload.ts`) reads the existing redacted MCP envelope: structured output first, then individual
content blocks, suppressing a duplicate JSON text block while keeping additional prose and non-text blocks as data.
Text that reads as Markdown opens Formatted (`lib/markdown.ts`), judged by the CommonMark and GFM grammar the renderer
parses: a table, two kinds of anchor (an ATX heading on its own line, a fenced code block, a table), or one anchor
among three kinds of signal. YAML and script comments, diffs, tracebacks and listings stay plain, because a missed
document is still readable and a false one would mangle data. `ToolMarkdown` sets it, through Streamdown's static mode, in the compact `typeset-tool`
preset as untrusted text: images are named and never loaded, only absolute http(s) and mailto links work and they
show their host, raw HTML shows as written and fences stay code. Reference definitions and link titles show only in
Raw. A long payload scrolls in place and fades at its bottom edge while more lies below (`scroll-edge-bottom`, driven
by its own scroll position). Ordinary or incomplete result text stays readable. Raw and its Copy action preserve the complete original text;
the tree copies complete values rather than its shortened display. No renderer fetches URLs or changes authority.

When the agent waits on the owner, the request is pinned above the composer until their next message
(`lib/interactions.ts`). This covers `ask_user` questions (a questionnaire) and grant-required results (an Allow card
for the exact server and tool). The reply is an ordinary message with a stable operation ID: `answer:<callId>` or
`grant:<callId>`. Allow first sets the exact grant through `PUT /api/mcp/grants`, and the allowed tool stays allowed.
In the transcript, both requests leave a quiet receipt. An Allow card is only trusted from goblin's own result for
the tool that was called, never from a remote result, which always carries `origin`. A held call and a URL request
are kept in goblin's store, not settled by a message: each stays pinned while its store says it is under way
(`stillOpen`: an approval pending, approved or dispatching; a URL request pending or retrying) and leaves once it
ended or its store forgot it, read from the queries its card keeps (`approvals/hooks.ts`); its outcome row then says
how it went. Only one that is pending counts as the agent waiting on the owner (`waitingOnOwner`), so presence says
Working, not Waiting for you, while the turn the owner's answer started runs. Each change of a held call or URL request
publishes `conversations.changed` for its chat, so attention (the sidebar's counts, Needs you) follows it at once.

At a keyboard and mouse Enter sends and Shift+Enter breaks the line; on a touch screen Return breaks the line and
the Send button sends, with ⌘/Ctrl+Enter from a hardware keyboard (`lib/keys.ts`). The composer carries the agent's presence (`lib/presence.ts`): one state for the whole agent, with the most urgent
first. In order: offline, waiting for the owner, retrying, using a tool (named `server · tool`), writing, thinking,
budget spent, no answer, and ready. A small orb of moving colour (a Paper Shaders `MeshGradient`, loaded lazily)
shows it beside a text label, and its pace follows the work. While the agent waits on the owner, a pulsing border
frames the composer. Under reduced motion, in a hidden tab, before the shader loads, and in a channel while the thread
panel is open over it, the orb is a still gradient (no WebGL context of its own), and
the border is absent. Colours come from the theme's `--presence-*` tokens, resolved to RGB at runtime.
