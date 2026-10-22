# Chat streams

> **Draft.** This is the profile third parties will implement against. Built: the translator from Pi's events to
> AG-UI (`apps/runtime/src/streams/agui.ts`), goblin's parts of it in the contracts (`packages/contracts/src/agui/`)
> and the producer that appends a joined chat's events to its streams (below). The reader's way in (the join endpoint
> and the signed stream URL) and the web's reader land next, with the ADR that decides them. Until then names and
> shapes here may still change.

## What a stream is

Every chat has one stream of [AG-UI 1.0](https://docs.ag-ui.com/concepts/events) events (`@ag-ui/core` 1.0.3, protocol
1.0), appended in order to a Durable Streams JSON stream, which gives readers offsets, resumption and live reads. The
same stream will serve goblin's own web app and any other reader (a server's app such as Swarmm or Sidequest).

It follows the chat, not one call: runs come and go, and some messages arrive between runs (a Persona's answer, a
routine's notice, a note shared from a thread), so events outside a `RUN_STARTED`…`RUN_FINISHED` pair are normal.

A stream lives in **epochs**. An epoch begins with:

1. `MESSAGES_SNAPSHOT`: the messages of the chat's newest entries (a window; older history is read in pages);
2. `STATE_SNAPSHOT`: the whole STATE document;
3. when a run is in flight, its `RUN_STARTED` and the answer so far (`TEXT_MESSAGE_START` and its content).

An epoch ends with the CUSTOM event `goblin.stream.moved` `{ epoch }`, and the chat goes on in that epoch's stream.

## Tiers

| Tier | Carries | Who reads it |
|---|---|---|
| `full` | everything below | the owner's sessions, OAuth clients holding transcripts |
| `answers` | `RUN_*`; `TEXT_MESSAGE_*` (people's and agents' messages, assistant and user); `ACTIVITY_*`; `SUBAGENT_*` lifecycle; `goblin.stream.moved`; `MESSAGES_SNAPSHOT` without reasoning and tool messages and without tool calls; STATE `/attention` only | servers' keys |

`answers` drops `REASONING_*`, `TOOL_CALL_*` (with `TOOL_CALL_RESULT`), `STEP_*`, `RAW`, `goblin.tool_progress`, the
other STATE members, and everything a subagent does but start, finish or fail (its answer reaches the parent as a
message of its own). An assistant turn that only called tools is an empty message in `answers`.

## Ids

| What | Id |
|---|---|
| `threadId` | the chat id (`1` is Personal's main) |
| `runId` | `<chat>:<submission>`, the run's first input; Pi always names one (`<chat>:0` stands in for none) |
| assistant message | `<chat>:a<timestamp>`: Pi keeps the request's start time (epoch ms) from the first partial to the committed entry, so the id is the same streaming, at `TEXT_MESSAGE_END` and in every snapshot |
| reasoning message | `<assistant>:r<index>` (the thinking block's index in the message); its span is `<assistant>:s<index>` |
| tool call | Pi's call id (the provider's; `<parent>/<key>` for a call a running tool made) |
| tool result message | `<chat>:t<call id>` |
| any other message | `<chat>:e<entry>` (`:<n>` for an entry's `n`th model message after its first) |
| interrupt | `<chat>:i<entry>`, the entry that raised it |

`metadata.goblin.entryId` names the Pi entry of every committed message (on `TEXT_MESSAGE_END`, `TOOL_CALL_RESULT`,
`ACTIVITY_SNAPSHOT` and in snapshots), so a reader can page history before it.

## What each Pi event becomes

Pi's events are its experimental `watchEvents` (spec §9.4), one batch per commit.

| Pi | AG-UI | Tier |
|---|---|---|
| `run_start` | `RUN_STARTED`, `metadata.goblin.operations` = the operation ids of its inputs when the stream saw them admitted. The inputs it placed follow it, though Pi announces the run after them | both |
| `run_end` | `RUN_ERROR` when its last answer's model call failed (`code: model_error`, the provider's first line), a generation faulted (`task_failed`) or Pi gave up an input; else `RUN_FINISHED` with outcome `cancelled` (stopped), `interrupt` (it raised attention items still open, carried as `interrupts`) or `success`. `usage` is its model calls' tokens. An answer or step still open closes first | both |
| `turn_start`, `turn_end` | `STEP_STARTED`, `STEP_FINISHED`, named `turn <n>` | full |
| `message_start`, `message_update` (assistant) | the answer streamed block by block: `TEXT_MESSAGE_START` (at its first text or tool call), `TEXT_MESSAGE_CONTENT`; each visible thinking block `REASONING_START`, `REASONING_MESSAGE_START`, `REASONING_MESSAGE_CONTENT`, closed when the next block begins; each tool call `TOOL_CALL_START` with `parentMessageId` | text both, the rest full |
| `message_end` (assistant) | the rest of each block, `TEXT_MESSAGE_END` (`entryId`, and `stop` when it failed, was stopped or cut off), then each tool call's `TOOL_CALL_ARGS` (the whole JSON, once: Pi's argument deltas are paths, not JSON text) and `TOOL_CALL_END` | as above |
| `message_end`, `entry_appended` (other entries) | the entry's messages, each written at once: user `TEXT_MESSAGE_*`; a Persona's answer an assistant `TEXT_MESSAGE_*` with `name`; a tool result `TOOL_CALL_RESULT`; an entry the app draws `ACTIVITY_SNAPSHOT`. Markers (memory view, compaction summary, reset) and system messages make none | as their kind |
| `tool_execution_start` | CUSTOM `goblin.tool_progress` `{ status: 'running' }`; a nested call (one a running tool made) is opened, given its arguments and closed here, with `metadata.goblin.parentToolCallId` | full |
| `tool_execution_update` | CUSTOM `goblin.tool_progress` with its output, details and diagnostics | full |
| `tool_execution_end` | a nested call's `TOOL_CALL_RESULT`; a model-issued call's result is its entry | full |
| `inbox_update` | `STATE_DELTA` `/queue` | full |
| `auto_retry_start`, `auto_retry_end`, `deferred_poll` | `STATE_DELTA` `/generation` | full |
| `compaction_start`, `compaction_end` | `STATE_DELTA` `/compactions` | full |
| `agent_changed`, `usage_changed` | `STATE_DELTA` `/agent`, `/usage` | full |
| an entry that raises or settles attention | `STATE_DELTA` `/attention` | both |
| `snapshot` (an overflow) | a catch-up: the entries past the last one carried, a run that ended or began meanwhile, the rest of the answer in flight, and each STATE member that changed; nothing is sent twice | as above |
| `submission`, `task_failed` | nothing of their own: they decide the run's operations and outcome | — |

## goblin's parts

**`metadata.goblin`** (`GoblinMetadata`) on events and messages, each field only where it applies:

- every committed message: `entryId`; a message's first event and snapshot messages: `at` (epoch ms);
- a user message: `author` (also its `name`) when someone other than the owner's composer wrote it (a Source, a key, an
  MCP client, a subagent, `Routine`), or `member` (also its `name`) in a workspace of several people; `own`, the owner's
  own turn from elsewhere; `attachments`; `context`, what an open App shared (untrusted); `selections`, the composer's
  choices; `outcome` and `kept`, how a held call ended; `thread`, where a shared note or report came from; `ask`, the
  Personas it went to instead of the agent. Its text is the words alone, without the tags and blocks the model reads;
- an assistant message: `persona` (a Persona's answer: id, name, revision, avatar, operation, routine, hold,
  questions) and `stop`;
- `RUN_STARTED`: `operations`;
- tool calls and results: `details` (Pi's details for UIs), `isError`, `parentToolCallId`.

**Activity types** (`ActivityType`), never CUSTOM events, since a reader that joins later sees only the snapshot:
`goblin.thread_head`, `goblin.thread_started`, `goblin.notice`, `goblin.topic_seed`, `goblin.delegate_result`, each with
its entry's data as its contract says.

**CUSTOM events**: `goblin.tool_progress` (`ToolProgress`: `toolCallId`, then `status: 'running'`, or `output` as
`{ set }` or `{ trimStart?, append? }`, `details`, `diagnostics`) and `goblin.stream.moved` (`StreamMoved`: `epoch`).

**STATE** (`GoblinState`): every member always present, each changed by a `STATE_DELTA` that replaces it whole.

| Path | Holds |
|---|---|
| `/queue` | inputs waiting for the next boundary: `id`, `mode` (`steer`, `followUp`), `text` when the producer read it |
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

Each epoch of a chat's stream in a tier is its own Durable Streams object (`@durable-streams/server-cloudflare`'s
`StreamObject`, pinned at 0.1.1, bound as `STREAMS`), keyed by its path `/s/<workspace>/<chat>/<tier>/<epoch>`. The
agent writes it directly through the object's stub and never mounts the library's router: a JSON stream, created with
a seven-day sliding TTL, each append a JSON array of events sent with the producer headers (`Producer-Id` `goblin`,
`Producer-Epoch` 0, `Producer-Seq` from 0), so a retry of the same bytes is answered 204 and counted as sent.

The producer (`streams/producer.ts`, one fiber per agent) follows only chats someone joined (a row in
`app_streams`). Pi's commits say which of them have activity (`subscribeCommits`, which only notes them); a watch
(`watchEvents`) then follows that chat, and stops after 30 idle seconds with nothing running. Each batch is translated
once per tier and appended at most every 250 ms, or at once at a boundary (`RUN_*`, `TEXT_MESSAGE_END`, a snapshot,
a CUSTOM event); an overflow's snapshot, a new watch and a restart of the agent catch up from the stored cursor. An
append is first an outbox row (`app_stream_outbox`, written with the row's new cursor in one short transaction), sent
outside any transaction by one drain per stream, and deleted once the stream answered 2xx; a write that may not have
arrived goes again, the same bytes, after a backoff.

An epoch begins when a chat's stream is first joined, at the end of a run once the epoch passed 4 MiB or a day, when
its stream is gone (expired or erased: 404 or 410) or out of step (409, 403), and when its stored cursor cannot be
read. It begins from a new watch's snapshot (so nothing the old watch still delivered is sent twice), and the old
epoch, unless its stream was lost, ends with `goblin.stream.moved` and is closed after what it still had to send.
Erasing the agent erases every epoch of every stream it made.

## What the producer adds

Pi's events do not carry everything; the producer supplies, or the stream leaves out:

- a queued input's words (`/queue` `text`): the translator takes them as a hint, which the producer does not pass yet
  (the owner queue read, `InboxDoc`, has them);
- a run's `operations` when its inputs were admitted before the stream was attached (left out);
- a held call decided outside the transcript before its outcome message arrives (it stays in `/attention` until then);
- on a catch-up, tools already running (their progress resumes with the next update; a nested call started meanwhile
  is not opened);
- event `timestamp`s: messages carry `metadata.goblin.at` instead.

Persona forks and subagents will be carried in their parent's stream, attributed by `subagentRunId`, in a later step.

## Where it is proven

`apps/runtime/test/streams/`: Pi batches recorded on a real Pi 1.3.0 Harness (in memory, in the test process, with a
scripted model that streams block by block; not workerd) for a plain reply, reasoning, a tool call with progress, a
member's message with attachments, a run that asks, a stopped run, a failed model call after a retry, Persona answers
and a hold, activities, a queued follow-up and an overflow mid-answer. The goldens keep each case's `full` and `answers`
events and an epoch opened on the idle chat; every event is checked against `@ag-ui/core`'s own schemas, goblin's parts
against their contracts, and the sequence for well-formed runs, messages, spans and calls. The same cases also run
against the installed Pi on every test run. `bun apps/runtime/test/streams/record.ts` records the fixtures again.
