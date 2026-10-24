# Chat streams

The profile third parties implement against, and the only way goblin's own web app follows a chat
([ADR 0110](../adr/0110-the-agent-serves-every-chats-stream-to-every-reader.md); the mapping is
[ADR 0109](../adr/0109-every-chat-streams-ag-ui-through-a-durable-stream.md)'s). Built: the translator from Pi's events
to AG-UI (`apps/runtime/src/streams/agui.ts`), goblin's parts of it in the contracts (`packages/contracts/src/agui/`),
the producer that serves a chat's events to the readers connected to it, with its children's work (Personas' forks and
subagents), the endpoint (`chats/api.ts` `stream`), and the web's reader (`apps/web/src/lib/agui/`). A chat is driven
with AG-UI too: a send is AG-UI's `RunAgentInput`, answered with its receipt or with its own run's events
([ADR 0111](../adr/0111-agui-run-input-is-the-send.md), "Driving a chat" below). The workspace feed is still its own
stream.

## What a stream is

Every chat has one stream of [AG-UI 1.0](https://docs.ag-ui.com/concepts/events) events (`@ag-ui/core` 1.0.3, protocol
1.0), served by the chat's agent as server-sent events to each reader connected to it. The same stream serves goblin's
own web app and any other reader (a server's app such as Swarmm or Sidequest), and every reader gets all of it: text,
reasoning, tool calls with their results, steps, STATE, and a child's work.

It follows the chat, not one call: runs come and go, and some messages arrive between runs (a Persona's answer, a
routine's notice, a note shared from a thread), so events outside a `RUN_STARTED`…`RUN_FINISHED` pair are normal. So
are a child's (below): a Persona answers without a run of the chat's, and a subagent goes on after the run that
started it ended.

## Reading a stream

1. **Connect.** `GET /api/conversations/:id/stream`: a member's browser under `/w/<slug>/api/…` with its session
   cookie, an OAuth client under the same path with its token as its bearer
   ([ADR 0116](../adr/0116-an-oauth-client-uses-the-owner-api-too.md)), a server's key on `/api/…` with the key as its
   bearer (a credential's grant's `read`, ADR 0114). A credential reaches only the chats of the Topics its grant
   reaches; any other answers `access_insufficient` (403), and a chat that is not
   there 404, in the error envelope. The answer is
   `text/event-stream`, never cached.
2. **Frames.** Each event is one `data:` frame, its JSON on one line, LF line ends: `data: {"type":"RUN_STARTED",…}`
   and a blank line. Nothing else a reader must know of is sent: no `event:` names, ids or retry hints. A `: ping`
   comment comes every fifteen seconds; a reader that hears nothing, not even a comment, for 45 seconds gives the
   connection up and connects again.
3. **The opening.** Each connection begins with:
   1. `MESSAGES_SNAPSHOT`: the messages of the chat's newest entries (up to 50, fewer when they would not fit one
      event of 512 KiB; older history is read in pages);
   2. `STATE_SNAPSHOT`: the whole STATE document;
   3. when a run is in flight, its `RUN_STARTED` (with the operations it answers) and the answer so far
      (`TEXT_MESSAGE_START` and its content, its thinking);
   4. for each child working now, its `SUBAGENT_STARTED` and what it did so far (below).

   Then it carries the chat's events live, each batch as Pi commits it.
4. **Reconnect.** A reconnect is a new connection, and opens afresh: its `MESSAGES_SNAPSHOT` replaces what the reader
   built, so nothing is resumed, read twice or lost. There are no offsets and no `Last-Event-ID`. The server ends a
   connection cleanly after fifteen minutes, or when the reader fell 512 batches behind; connect again then.
5. **Refusals.** Before anything streams, a refusal answers in the error envelope: 404 for a chat out of reach, 401
   for a session or key that is not valid, 403 for a key without `conversations`, and 409 `Conflict` `stream_busy`
   when the chat already has 32 readers, or the workspace's agent 256 (try again later).
6. **Older history.** `GET /api/conversations/:id/history?before=<entry>` answers the page of entries before `before`
   as the same AG-UI messages a snapshot holds (one mapping, `streams/messages.ts`), oldest first, with `next`, the
   entry to read the page before, and `more`. Start at the snapshot's `before`.

```sh
curl -N "$GOBLIN_ORIGIN/api/conversations/<chat>/stream" -H "authorization: Bearer $GOBLIN_KEY"
```

No string in any frame holds a secret goblin issues or keeps: one that holds something shaped like a server's key
(`gbk_…`), a thread server's token (`swt_…`) or a webhook secret (`whsec_…`) is sent as `[redacted]`
(`streams/redact.ts`). Credentials never enter the events; this pass is the backstop.

## Driving a chat

On `/mcp` a send is a tool call instead (`conversation_send`), answered by its receipt or, to a client that follows the
Tasks extension, by a task that completes with the answer ([ADR 0119](../adr/0119-a-send-is-a-task-when-its-client-can-follow-one.md));
`GET /api/conversations/:id/sends/:operationId` says how one send stands over HTTP too. Over HTTP a send is AG-UI's
`RunAgentInput` ([ADR 0111](../adr/0111-agui-run-input-is-the-send.md), `RunInput` in the
contracts), posted to `POST /api/conversations/:id/messages` with the caller's credential (its grant's `write`):

```json
{
  "threadId": "<chat>",
  "runId": "<operation id, 1 to 200 characters: the same id is the same send>",
  "messages": [{ "id": "<any>", "role": "user", "content": "Can you design my cover?" }],
  "forwardedProps": { "goblin": { "selections": [{ "kind": "persona", "personaId": 7 }] } }
}
```

- `threadId` is the chat in the path. Only the last of `messages` is read, and it must be the user's text (a string,
  or text parts); a stock client's history before it is ignored. Files, composer tags (a Persona tag makes the send an
  ask of that Persona instead of the agent), the Persona order and App context go in `forwardedProps.goblin`
  (`attachments`, `selections`, `personaOrder`, `appContext`). `tools` and `state` must be empty; `context` is ignored.
  A body may be up to 1 MiB.
- `resume` answers the chat's questions by their interrupt ids (`/attention`, `<chat>:i<entry>`): `{ "interruptId",
  "status": "resolved", "payload": "<the answer, as text>" }` makes the answer the send's words when its own say
  nothing. A `cancelled` entry is nothing; other interrupts are answered by their own endpoints, and resolving one is
  refused with its endpoint as the reason.
- A refusal answers the error envelope before anything is admitted: 400 `InvalidInput` with a reason
  (`thread_mismatch`, `last_message_not_user`, `non_text_content`, `client_tools`, `interrupt_not_open`, …), 404 for a
  chat out of reach, 409 `stream_busy` past the agent's 32 run streams.

Without `Accept: text/event-stream` it answers 202 with Pi's receipt (`{ operationId, session, accepted }`;
`accepted: false` for a retry). With it, it answers that send's own run as server-sent events, framed as a chat's
stream is, and ends after the run's end:

1. nothing until the run that took the send's input starts (a send queued behind another run waits, and nothing of that
   run is sent); then `RUN_STARTED` with the send's `runId` and `threadId` (`metadata.goblin.run` is the chat's own run
   id), `STATE_SNAPSHOT`, and the run's events: steps, thinking, text, tool calls with their results, STATE changes;
2. `RUN_FINISHED` with the send's ids (`outcome` `interrupt` holds only the run's open questions, which a `resume`
   answers), or `RUN_ERROR`; then the connection ends.

The send's own user message and the chat's children (a Persona's fork, a subagent) are left out; the chat's stream
carries them. A send that tags Personas has no run of the chat's: its run carries each Persona's answer (an assistant
message with `name`) and ends once they all answered (`interrupt` when an answer asked questions), were stopped
(`cancelled`) or failed (`RUN_ERROR`). A retry of a send that ended answers `RUN_STARTED` and its end at once
(`metadata.goblin.replayed`); one under way opens with what its run said so far. A run stream ends after fifteen
minutes in `RUN_ERROR` `stream_lifetime`; the run goes on in the chat.

A stock `@ag-ui/client` `HttpAgent` does all this: its URL is the endpoint, the key its `authorization` header, the chat
its `threadId`; `scripts/agui-client-check.ts` runs one turn on a stage with it.

`POST /api/conversations/:id/threads` (the thread operation) takes `{ anchor, title?, mcpServers?, message }`, `message`
such a send for the chat in the path; its `runId` is the operation id, and it answers 201 with the Thread and the
receipt, never events.

## Ids

| What | Id |
|---|---|
| `threadId` | the chat id (`1` is Personal's main) |
| `runId` | `<chat>:<submission>`, the run's first input; Pi always names one (`<chat>:0` stands in for none) |
| assistant message | `<chat>:a<timestamp>`: Pi keeps the request's start time (epoch ms) from the first partial to the committed entry, so the id is the same streaming, at `TEXT_MESSAGE_END` and in every snapshot |
| reasoning message | `<assistant>:r<index>` (the thinking block's index in the message); its span is `<assistant>:s<index>` |
| tool call | Pi's call id (the provider's; `<parent>/<key>` for a call a running tool made); a child's is `<child>:<call id>` |
| tool result message | `<chat>:t<call id>` |
| any other message | `<chat>:e<entry>` (`:<n>` for an entry's `n`th model message after its first) |
| interrupt | `<chat>:i<entry>`, the entry that raised it |
| `subagentRunId` | the child's chat: a Persona's fork, or a subagent's chat (`<chat>` in a child's own ids is that chat, so they never meet the parent's) |

`metadata.goblin.entryId` names the Pi entry of every committed message (on `TEXT_MESSAGE_END`, `TOOL_CALL_RESULT`,
`ACTIVITY_SNAPSHOT` and in snapshots), so a reader can page history before it.

## What each Pi event becomes

Pi's events are its experimental `watchEvents` (spec §9.4), one batch per commit.

| Pi | AG-UI |
|---|---|
| `run_start` | `RUN_STARTED`, `metadata.goblin.operations` = the operation ids of its inputs, as the stream saw them admitted or, for a run already under way when a watch began, as the producer read them. The inputs it placed follow it, though Pi announces the run after them |
| `run_end` | `RUN_ERROR` when its last answer's model call failed (`code: model_error`, the provider's first line), a generation faulted (`task_failed`) or Pi gave up an input; else `RUN_FINISHED` with outcome `cancelled` (stopped), `interrupt` (it raised attention items still open, carried as `interrupts`) or `success`. `usage` is its model calls' tokens. An answer or step still open closes first |
| `turn_start`, `turn_end` | `STEP_STARTED`, `STEP_FINISHED`, named `turn <n>` |
| `message_start`, `message_update` (assistant) | the answer streamed block by block: `TEXT_MESSAGE_START` (at its first text or tool call), `TEXT_MESSAGE_CONTENT`; each visible thinking block `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`, closed when the next block begins; each tool call `TOOL_CALL_START` with `parentMessageId` |
| `message_end` (assistant) | the rest of each block, `TEXT_MESSAGE_END` (`entryId`, and `stop` when it failed, was stopped or cut off), then each tool call's `TOOL_CALL_ARGS` (the whole JSON, once: Pi's argument deltas are paths, not JSON text) and `TOOL_CALL_END` |
| `message_end`, `entry_appended` (other entries) | the entry's messages, each written at once: user `TEXT_MESSAGE_*`; a Persona's answer an assistant `TEXT_MESSAGE_*` with `name` (then `SUBAGENT_FINISHED` for its fork, when the stream carries it); a tool result `TOOL_CALL_RESULT`; an entry the app draws `ACTIVITY_SNAPSHOT`. Markers (memory view, compaction summary, reset) and system messages make none |
| `tool_execution_start` | CUSTOM `goblin.tool_progress` `{ status: 'running' }`; a nested call (one a running tool made) is opened, given its arguments and closed here, with `metadata.goblin.parentToolCallId` |
| `tool_execution_update` | CUSTOM `goblin.tool_progress` with its output, details and diagnostics |
| `tool_execution_end` | a nested call's `TOOL_CALL_RESULT`; a model-issued call's result is its entry |
| `inbox_update` | `STATE_DELTA` `/queue` |
| `auto_retry_start`, `auto_retry_end`, `deferred_poll` | `STATE_DELTA` `/generation` |
| `compaction_start`, `compaction_end` | `STATE_DELTA` `/compactions` |
| `agent_changed`, `usage_changed` | `STATE_DELTA` `/agent`, `/usage` |
| an entry that raises or settles attention | `STATE_DELTA` `/attention` |
| `snapshot` (an overflow) | a catch-up: the entries past the last one carried, a run that ended or began meanwhile, the rest of the answer in flight, and each STATE member that changed; nothing is sent twice |
| `submission`, `task_failed` | nothing of their own: they decide the run's operations and outcome |

## goblin's parts

**`metadata.goblin`** (`GoblinMetadata`) on events and messages, each field only where it applies:

- every committed message: `entryId`; a message's first event and snapshot messages: `at` (epoch ms);
- a user message: `author` (also its `name`) when someone other than the owner's composer wrote it (a Source, a key, an
  MCP client, a subagent, `Routine`), or `member` (also its `name`) in a workspace of several people; `own`, the owner's
  own turn from elsewhere; `attachments`; `context`, what an open App shared (untrusted); `selections`, the composer's
  choices; `outcome` and `kept`, how a held call ended; `thread`, where a shared note or report came from; `ask`, the
  Personas it went to instead of the agent. Its text is the words alone, without the tags and blocks the model reads;
- an assistant message: `persona` (a Persona's answer: id, name, revision, avatar, operation, routine, hold,
  questions), `stop` and `usage` (its model call's tokens, as Pi counts them);
- a child's final answer (a Persona's answer, a Delegate's result): `subagentRunId`, the child it closes;
- a Persona's `SUBAGENT_*` events: `persona`, `invocation` and, on its end, `entryId` (below);
- `branchable` on the owner's own words and the agent's answers: a Thread may start at their entry (ADR 0034);
- `omits` on the messages of an entry that leaves earlier entries out of the chat (a turn moved to a Thread): a reader
  hides the messages of those entries, also ones it read in older history;
- `MESSAGES_SNAPSHOT`: `before`, the entry older history is read before, a page at a time; absent when the snapshot
  starts at the chat's beginning;
- `RUN_STARTED`: `operations`;
- tool calls and results: `details` (Pi's details for UIs), `isError`, `parentToolCallId`; a result names its tool
  (`toolName`), for a reader that does not hold the call.

**Activity types** (`ActivityType`), never CUSTOM events, since a reader that connects later sees only the snapshot:
`goblin.thread_head`, `goblin.thread_started`, `goblin.notice`, `goblin.topic_seed`, `goblin.delegate_result`, each with
its entry's data as its contract says.

**CUSTOM events**: `goblin.tool_progress` (`ToolProgress`: `toolCallId`, then `status: 'running'`, or `output` as
`{ set }` or `{ trimStart?, append? }`, `details`, `diagnostics`), the only one.

**STATE** (`GoblinState`): every member always present, each changed by a `STATE_DELTA` that replaces it whole.

| Path | Holds |
|---|---|
| `/queue` | inputs waiting for the next boundary: `id`, `mode` (`steer`, `followUp`), and what each says as a user message carries it (`text`, `author`, `attachments`, `selections`, `context`) |
| `/generation` | the model call in flight (`attempt`, `retry { at, error }`, `deferred { pollAt }`), or null |
| `/compactions` | `running` (reason, blocking, attempt, retry) and the newest `failure` |
| `/agent` | the model (`provider`, `modelId`) and thinking level |
| `/usage` | the chat's tokens by `provider/modelId` and by tool |
| `/attention` | what waits for a person, as AG-UI interrupts (below) |

**Attention** (`AttentionItem`, an AG-UI `Interrupt`): `reason` is `question` (`ask_user`), `approval` (an ask-first
call), `grant` (a tool to allow), `url` (a URL request to finish), `access` or `connect` (a sign-in), or `setup`
(outside the Topic's setup); `message` is a short label and `toolCallId` the call that raised it.
`metadata.goblin` holds the entry, the questions, the held call's or request's id, the connection and tool, and for a
Persona's hold its Persona and its own chat. Items come only from goblin's own markers (a remote result never raises
one). The owner's next message settles every item before it, and is how a question is answered; a Persona's next answer
settles its own; a held call's outcome settles the items on that call. Approvals, grants, URL requests and sign-ins
are answered through the app's own controls.

## How a stream is produced

The producer (`streams/producer.ts`, one fiber per agent) follows a chat only while a reader is connected to it, and
keeps nothing of it once the last one left. Each reader is a row: its own cursor of the translator, its own sink (512
batches) and its connection. A reader joins with a message to the fiber, which answers once the reader's opening is in
its sink, or refuses it (`stream_busy`, or Pi's failure) so the endpoint answers the error envelope instead of a
stream.

A burst of joins shares one new watch of the chat (`watchEvents`): its snapshot opens each reader that joined and
catches every other up from its own cursor, so nothing a reader read comes again. Then each batch Pi commits is
translated over each reader's cursor and handed to its sink at once; the fiber never waits for a reader. A reader whose
sink is full is let go, as is one connected for fifteen minutes: its connection ends, read or not, and it connects again
for a fresh opening. The platform may never tell the agent that a client went away, so those two bounds are what free
a gone reader's place; the last reader to leave stops the chat's watch and its children's.

A watch with nothing running stops after 30 idle seconds, its readers still connected; Pi's commits say which chats
have activity (`subscribeCommits`, which only notes them), and the next one watches the chat again, its snapshot
catching every reader up. When something waits in the chat's queue the producer reads what it says (`InboxDoc`) for
`/queue`; on a new watch it reads the operation ids of the run in flight's inputs and the queue's, which Pi's snapshot
does not carry.

The endpoint writes each reader's batches as frames (`streams/frames.ts`): an event bounded to 512 KiB (a tool result
too large loses its details first, anything still larger is left out; the transcript keeps it), its secrets redacted
(`streams/redact.ts`), and a comment every fifteen seconds.

## What the producer adds

Pi's events do not carry everything; the producer supplies, or the stream leaves out:

- a run's `operations`, from its inputs' submissions, when the watch began after they were admitted;
- a held call decided outside the transcript before its outcome message arrives (it stays in `/attention` until then);
- on a catch-up, tools already running (their progress resumes with the next update; a nested call started meanwhile
  is not opened);
- event `timestamp`s: messages carry `metadata.goblin.at` instead.

## Children: Personas' forks and subagents

A Persona tagged in a chat answers in a fork of the chat (ADR 0033), and a subagent works in a chat of its own; their
work is carried in their parent chat's stream with AG-UI's subagent attribution, and their final answer arrives in the
parent as a message of its own.

- **Lifecycle.** `SUBAGENT_STARTED` (`subagentRunId`, `name`: the Persona's, or the subagent's), then the child's
  work, then `SUBAGENT_FINISHED` (`outcome` `success`, or `suspended` with the `/attention` items its answer raised in
  `interruptIds`) or `SUBAGENT_ERROR` (`code` and a line to show). A Persona's work starts when its invocation starts
  (its fork registered, before its model is asked) and ends at its answer, after the answer's message, or when its
  invocation fails (`code` its `reason`: `no_answer`, `model_error`, `budget`, `unavailable`) or is stopped
  (`stopped`). A subagent's work is its runs: each starts at its run's start and ends at its run's end (`model_error`
  or `task_failed` when the run failed, `stopped` when it was stopped); its result arrives in the parent later, once
  its own helpers are done, as `goblin.delegate_result` (or as an input the agent answers, when it was spawned to be
  synthesized). Lifecycle events go out at once, like a run's.
- **`subagentRunId`** is the child's chat id: the fork's (`PersonaInvocationView.fork`, `PersonaAnswerData.fork`) or
  the subagent's (`DelegateResultData.delegate`). A child given more work later starts again under the same id: a
  Persona going on after its hold (AG-UI's `suspended` outcome, continued), a subagent's next job.
- **Its work**: the child's own events as its own stream would have them, each carrying
  `subagentRunId`: its input (a Persona's prompt, a subagent's job) and answers (`TEXT_MESSAGE_*`), `REASONING_*`,
  `TOOL_CALL_*` with its results, `STEP_*` and `goblin.tool_progress`; never its runs (its lifecycle stands for them),
  snapshots or STATE. Its message ids start with its chat, and its tool call ids are prefixed with it
  (`<child>:<call id>`, `parentToolCallId` too).
- **`metadata.goblin` on a Persona's lifecycle**: `persona` (`id`, `name`, `revision`, `avatar`, `operationId`; on its
  end, `hold` and `questions` as its answer has them), `invocation` (`{ state, reason? }`: `running` on its start,
  then `answered`, `failed` with its `reason`, or `stopped`: the state and reason `PersonaInvocationView` gives in the
  forward read's `invocations`), and on `SUBAGENT_FINISHED` `entryId`, the answer's entry (the `id` of its `persona`
  entry in `entries?after=`, the invocation's `answerEntry`). A subagent's lifecycle carries none.
- **Pairing a child with its answer.** The answer is the parent's own message: an assistant message with `name` for
  a Persona, the `goblin.delegate_result` activity for a subagent, without AG-UI's `subagentRunId` (it is the chat's
  own) and with `metadata.goblin.subagentRunId`, the child it closes. A reader that persists answers once keys
  them by `entryId`; `operationId` with the Persona's `id` names the invocation.
- **A key's chats.** Their children are their Personas' forks and helpers, carried in that chat's own stream only, in
  full to the key that reads it.
- **Late readers.** A connection opens with each child working then: `SUBAGENT_STARTED`, then what it did so far: a
  Persona's work from its invocation's prompt on, a subagent's run in flight with its answer so far.
- **Producing them** (`streams/children.ts`, `streams/child-follow.ts`): the producer follows the children of each
  chat with readers: Personas' forks from their invocation's start to its end (`invocations.changed`, each change
  read as the write left it), and open subagents (`conversations.changed` and the chat registry), each with a watch of
  its own over the same translator, its cursor kept in each reader's (`StreamCursor.children`) and its events sent to
  each reader of the parent. A watch with nothing carried stops after 30 idle seconds, and a child's commit starts it
  again; the parent's last reader leaving stops it. A subagent's own subagents are not carried yet.

## goblin's web app

The web reads the stream as any reader does (`apps/web/src/lib/`):

- `agui/reader.ts` connects (`event-streams.ts` `chatStream`: a `fetch` of the endpoint under the page's workspace,
  same origin, with the session's cookie) and reads its frames (`readEvents`), each chunk's events handed on at once.
  A connection the server ended after its events connects again at once; a dropped or unreachable one, or one silent
  for 45 seconds, after a backoff (`lib/reconnect.ts`). A 404 or 403 stops (`stopped`, the chat out of reach), and a
  401 goes to sign-in through the query client's handling (`failedOutside`). Every connection's opening starts the
  reducer over.
- `agui/reducer.ts` folds the events into the transcript's projection: the committed messages (a connection's
  `MESSAGES_SNAPSHOT` replaces them), the answer and thinking in flight, the tools running (with the times this browser
  saw), the queue and the run's progress from STATE, from the marks the entries a Thread may start at, those left
  out and where older history starts, and the children working (`children`: each one's name, a Persona's avatar and
  its answer so far, from its `SUBAGENT_*` lifecycle; its own events stay with it). The rows after the transcript show
  them ("answering…", "working…"), with a Persona that waits its turn in a sequence from the workspace feed.
  `agui/messages.ts` maps AG-UI messages to the transcript's, once per message, for
  the projection and for older pages alike; the transcript keeps its ids (`<entry>:<index>`) from `entryId`.
- `stream-pool.ts` shares one reader per chat among the panes that show it; one nobody sees for a while is suspended
  (its connection closed) and connects again, for a fresh opening, when it is seen again.

## Where it is proven

`apps/runtime/test/streams/`: Pi batches recorded on a real Pi 1.3.0 Harness (in memory, in the test process, with a
scripted model that streams block by block; not workerd) for a plain reply, reasoning, a tool call with progress, a
member's message with attachments, a run that asks, a stopped run, a failed model call after a retry, Persona answers
and a hold, activities, a queued follow-up, an overflow mid-answer, and a Persona's fork (a tool call, then thinking
and an answer) recorded beside its parent. The goldens keep each case's live events and the opening of a connection
to the idle chat; every event is checked against `@ag-ui/core`'s own schemas, goblin's parts against their contracts,
and the sequence for well-formed runs, messages, spans and calls, a child's within its own lifecycle. The same cases
also run against the installed Pi on every test run. `bun apps/runtime/test/streams/record.ts` records the fixtures
again. `children.test.ts` holds the fork's work under its `subagentRunId` (its ids its own), the Persona its lifecycle
names, a late reader's opening mid-answer and one taken after the fork worked, its failure and stop, and the same
batches as a subagent's run. `producer.test.ts` drives the producer over the recordings with Pi's watch scripted: a
reader that joins mid-answer gets its own opening while the first reads on as if alone (a catch-up of STATE alone), a
burst of joins opens one watch, the last reader to leave stops the chat's watch and its child's, a full sink lets only
that reader go, a reader connected fifteen minutes is let go, a reader opening mid-run gets its run's operations, and
the 33rd reader of a chat is `stream_busy`. `frames.test.ts` holds the frames: one `data:` frame per event, LF only,
comments while idle, and a tool result echoing a key, a thread server's token and a webhook secret sent with each as
`[redacted]`.

In local workerd (`apps/runtime/test/integration/streams-case.ts`, `streams-children-case.ts`): a member reads their
chat through `/w/<slug>/api` with their session, the opening then a turn's run, thinking, tool call and result and
answer live; after the reader went away and the chat went on, a reconnect's opening holds what came meanwhile; a key
reads its own Topic's chat in full (thinking and steps included) and gets 404 for another key's Topic and the owner's
chat; a chat's 33rd reader is `stream_busy`. The owner tags a Persona held at its model call and reads its start, its
work, its end naming the answer and the answer; a key reads the same of its own Topic's chat, the fork's own work included,
matching the forward read's invocation and entry; a subagent's run streams the same way, and a reader that connects
while it works opens with it in flight. Not proven there: that the agent hears of a client that went away (local
workerd never tells it, from outside the dev proxy or from inside the Worker), so a gone reader is freed by the
fifteen-minute bound or a full sink.

A send's run (`streams/run.ts` `RunFollow`, `layers/run-streams.ts`) is held by `run.test.ts` over the same
recordings, every case's events through `@ag-ui/client`'s own `verifyEvents`: a plain run, thinking, a tool call, a
failed and a stopped one, a send queued behind another run, a retry of a run under way (its answer so far) and one
placed into a run in flight, a run that asks, finished retries, a withdrawn input, the stream's life, and an ask of
Personas (its answer, its questions, a failure, a stop, a retry; never a fork's own work). In local workerd
(`run-streams-case.ts`): a run with thinking and a tool call under the send's id, then its retry at once; a send queued
behind a held run; a question answered by a `resume` alone; a Persona ask; a key sending as Swarmm does; a 300 KB
history taken and a body past 1 MiB refused; and a stock `HttpAgent` running a turn with a key.

The web holds its reducer to the same goldens (`apps/web/test/agui-reducer.test.ts`): for every case the transcript
built from the live events, all at once or one event at a time, is the one a new connection opens with; a child's
events stay with it (`ConversationProjection.children`), never in the transcript. The reader is tested against an
in-memory server (`agui-reader.test.ts`: the opening then live, a server-ended connection reconnecting at once, a
drop backing off, a silent connection given up, a refusal stopping, frames across chunks). The browser fixtures
`apps/web/test/ui-channel.ts` and `ui-queue.ts` serve the real components AG-UI events as server-sent events
(`agui-route.ts`) and screenshot them at 1440 and 390 px, light and dark.
