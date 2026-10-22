# Run ledger

## Run ledger

Pi records what was said; goblin records how each turn ran, beside it (ADR 0024). `PiRunRecorder`
(`telemetry/pi.ts`) follows Pi's commit listener from the moment Pi opens (`pi/harness.ts`), so it sees every
conversation (main, threads, subagents, routine runs) without an extension, and reads only committed records.
Before scheduling resumes, `telemetry/rehydrate.ts` restores live runs and submission ids through supported Pi inspection
and `LiveDoc`; the synchronous listener never calls Pi or awaits it. Final-answer events are processed before clearing
a run. The ledger supplies exact submission/task correlation when a cache entry is gone:

- **Turn:** an input submission from admission to settlement, by its operation id. Its source comes from the id's
  prefix (`source-`, `routine-input:`, `subagent:`, `persona:`, …; anything else is `direct`, the owner or an MCP
  client). An unanswered turn keeps Pi's reason.
- **Model attempt:** a generation task entering `request`, ended by the assistant entry it appends (or the task's
  fault): model, finish reason, input, output, cache and reasoning tokens, fixed error summaries, cutoff and
  empty-answer markers. The first committed partial
  marks the first chunk; Pi commits partials at most every ~100 ms. A retried attempt is a new event.
- **Tool call:** a tool task, ended by its result entry: name, family (`mcp`, `app`, `subagent`, `memory`,
  `builtin`), argument and result sizes, the MCP server and tool of an `mcp_call`, and `blocked`, `interrupted` or
  `error` with the first diagnostic. A call to a tool that is not there is one event, from the generation.
- **Compaction** tasks, and any other task that faults or is orphaned (a subagent relay, an anchor).

Outside Pi, the agent's services report to the same telemetry (`telemetry/report.ts`):

- **Model calls outside a turn** (`model.aux`): one cheap model per purpose (`naming`, `memory`, `skill`,
  `app_llm`, `retrieval`), with tokens and errors (`memory/model.ts`).
- **Remote MCP steps** (`mcp.request`): every connect, tool call, skills request and Events request, with server,
  tool, outcome code (`UpstreamMcp:timeout`), expected blocked waits and duration (`mcp/connections/log.ts`). Resident callers pass
  explicit conversation/task metadata, stripped before SDK dispatch; shared connection discovery is marked without
  attributing it to a turn. Reporter failures cannot change or retry the call.
- **Sources** (`source.received`, `source.reply`): each message by its Source id and turn's operation id; each
  answer `sent` in pieces, or `given_up` after a day.
- **Flow steps** (`flow`, ADR 0037): one content-free step of a conversation flow, recorded where it happens through
  `FlowEvents.record` or `withFlow` (`observability/flows.ts`), which never fails the flow it describes. The agent
  records every flow `FlowName` names: an owner's send, a client's ask and a Source message as they are admitted, a
  thread started (`start`, `reply`, `empty`), a move, a share-back, a close and a Stop, a Persona's ask and answer, a
  Delegate's spawn and report, a thread's announcement, a Topic created or archived, an organize Undo, a routine
  firing and report, a Source delivery (and the Worker a browser crash). The operation id has its own column and
  the operation that caused it is
  `goblin.operation.parent`; the rest are allowlisted ids and closed classes. A `refused` step is stored `blocked`,
  an `error` step `error`. Ledger reads skip a row of a kind they do not know.

Each event goes to `app_run_events` (kept 30 days) and to one Workers Log line when it ends, through the logger below
(`event: "run"`, its ids,
`ms`, and attributes named after the OpenTelemetry GenAI conventions, `contracts/src/telemetry.ts`). Model and tool
calls also become spans (`chat {model}`, `execute_tool {tool}`, `telemetry/trace.ts`), with the same attributes and
the agent, conversation and operation ids. A call often starts in one invocation and ends in another, and a Workers
span cannot outlive its invocation, so each is one span written whole where it ends, its real start and duration in
`goblin.started_at` and `goblin.duration_ms`. Today only model calls outside a turn reach Traces: the spans of a
turn's calls, recorded from Pi's commit listener, are created but never exported (seen on dev 2026-10-06, cause not
yet found), so those calls are in the ledger and the log only. Never content:
ids, sizes, counts, timings, outcomes and fixed error summaries. Known fields are sanitized before fan-out and again
when read back; arbitrary provider, schema and remote error text stays in Pi inspection. Expected authority waits use
info log lines and an unset trace status. At start the agent marks whatever the last run left
`started` as interrupted and logs one `recovery` event; an event that ends after a restart says it resumed. Pi faults
the user's task if a commit listener throws, so the recorder and every sink are guarded and only log their own
failures. Verified with in-memory Pi (`test/telemetry.test.ts`) and local workerd (`native-telemetry.ts`, the
Source Events probe). Compaction summaries' model calls are not recorded yet.

The agent builds these pieces with `runTelemetry(storage, name, sinks)` (`telemetry/run.ts`, from
`telemetry/agent.ts`): its ledger, log and recorder. The recorder is attached and `recorder.restore(harness)` awaited
right after `Harness.open`, before scheduling resumes. Tests pass an in-memory sink (`CollectedRuns`, `test/telemetry-sink.ts`) to
read events in process, and `summarize(turn, events)` (`inspect/inspector.ts`) gives the per-turn numbers: attempts,
failures, tool calls and tokens. Attempt timing runs from the generation entering `request` to its assistant entry;
the first chunk is the first committed partial, so it is good to about 100 ms. The runtime package exports no
telemetry entry.

### Logs, failures and references

Every line the runtime writes goes through one logger (`observability/logger.ts`, the runtime's only `console`
writer): `GoblinLogger` for `Effect.log*`, `logEvent` for named events inside Effect, and `writeLine` for synchronous
code outside it (the run log, Pi's commit listener). A line is one JSON object: allowlisted keys, each only with a value
of its shape (`FIELDS` in `observability/logger.ts`: where, operation, request, ref, agent, route, method, status, code, error type, frames,
counts, timings and a few more), then run attributes through their own allowlist (`telemetry/safety.ts`). The logger
reads a fiber's log annotations and spans only, never a log message or a cause. Event names are a closed list
(`LOG_EVENTS`: `client_error`, `failure`, `flow`, `http.failure`, `job`, `mcp`, `rpc`, `run`, `skill-learner`, `wake`).

A failure that should be seen is reported by the failure reporter (`observability/report.ts`, on Effect's
`ErrorReporter`): one `failure` line with where it was reported (`goblin.where`), its type (its `_tag` or class name),
the `file:line:col` locations of its stack and a severity, never its message. The typed answers an owner gets in the
normal course (every `AppError` but `Internal`: a 404, a 409) are not reported when they arrive as failures.
`reportFailure(where)` reports and keeps failing; `reportAndRecover(where, fallback)` reports and falls back, for a
legitimate fallback only; `expectedFailure` marks an error to log at `Info` or not at all. Every program the bridge
runs, every owner API request and every change handler is reported this way, and `toAppError` (`http/errors.ts`)
reports an unexpected failure where it becomes `Internal`.

References join what the owner sees to the logs:

1. The browser sends a fresh `x-goblin-request` id (eight characters) with every API request, and a write its
   operation's `x-goblin-operation`.
2. The Worker's edge forwards both with its own reference, `x-goblin-ref` (the request's cf-ray), answers with that
   header and `error.ref`, and logs a failed answer as one `http.failure` line (see The owner API).
3. Inside the agent, owner admission (or the internal gate) annotates the request's lines with `goblin.rpc`,
   `goblin.operation` and `ref`.
4. The web quotes the reference with a failure ("… · ref 7f3a9c12"): the answer's, or the request id when nothing
   answered (`describeError` and `messageOf`, `lib/query/app-error.ts`). Sign-in and `/health`, outside the API, do the
   same (`AuthRefused`, `auth/queries.ts`).
5. `goblin lookup <ref|request|operation>` finds the Worker's log lines that mention it, then shows the details of the
   operation they name.

A crash nothing on the page caught (a route that failed with a defect, an uncaught error or unhandled rejection) is
reported to `POST /api/client-errors` (`lib/query/crash-report.ts`): each distinct crash once, at most five a page
load, with the route id, the error's type, at most twelve `url:line:col` frames, the build and the failing answer's
reference, within 2 KiB; never its message, the URL or anything the owner typed. An answer the API gave is not a
crash. The Worker logs it as one `client_error` line and writes a `client_error` flow point; nothing is stored.

For the operator, flow steps also go to Workers Analytics Engine (`observability/ae.ts`, ADR 0037): the optional
`FLOWS` dataset (`goblin-<stage>-flows`), one point per operation (its first step), indexed by a hashed agent id (an
HMAC of the user id under a key derived from `GOBLIN_CREDENTIAL_KEY`), with closed classes, counts and timings and no
chat or operation ids. Without the binding nothing is written. `goblin stats` sums them per flow and outcome through
the Analytics Engine SQL API with the operator's own Cloudflare token.

### Inspection

The `Inspection` service (`inspect/service.ts`, over the readers in `inspect/inspector.ts`) reads the agent back
without changing it or calling a model. The queries are in `contracts/src/inspect.ts`:

- `conversations`: every conversation the agent keeps.
- `conversation`: a page of one conversation's Pi entries, oldest first, in full. Text is cut at 4000 characters and
  arguments or data at 2000, with `truncated` set. A leading author tag becomes `author`.
- `turns`: recent turns as one-line summaries (source, outcome, attempts, tool calls, failures, `error` events,
  tokens). A chat filter
  resolves to its current Pi session; historical events keep their recorded Pi session.
- `turn`: one operation end to end. It joins Pi's own settlement of the submission (`done` with its answer entry, or
  `unanswered` with a reason) with every run event of the operation, in order, and `coverage` names what the
  timeline cannot show: a restart mid-turn, events still open, a missing final answer, or a compaction's model call.
  `steps` lists its model attempts, tool calls, compactions and errors in order with their start offsets and durations
  (model, tokens, finish reason, time to first chunk; tool, MCP server and tool, failure class), and `spent` says where
  its time went: wall, model and tool time, tool time by server, and the rest (ADR 0084).
- `problems`: events needing attention since a time (default the last day); expected authority waits and confirmed
  recovered model retries are filtered before applying the limit. Pass `all: true` for the full problem history.
  Cutoffs, empty answers and coverage gaps remain visible. Tool failures remain until reviewed; a successful turn
  alone never proves a failed tool recovered. Successful auxiliary model completions are excluded, including a
  `length` finish on a bounded memory call; actual auxiliary failures remain visible. A failed flow step is a problem;
  a refused one (an answer the owner already saw) only with `all: true`.
- `flows`: flow steps since a time, newest first, by chat or flow.
- `details`: what happened behind one message, by its operation id or by the chat entry that is its answer or tool
  result: the operation's timeline (with its turn when it ran one) and `related`, the operations it came from and
  led to.

The agent answers them on the owner API's `inspect` group (`GET /api/inspect/…`, ADR 0086): the owner's app reads
`details` for a message's Details sheet, and `/mcp`'s `inspect_*` tools call the same endpoints as their caller. The
two conversation reads need `transcripts`, which only an OAuth client consented with `goblin:transcripts` holds; the
content-free reads need `inspect`, which a key can hold too, seeing only the run events of chats within its reach
(`inspectReach`, ADR 0084; see Inbound MCP).

The agent reads itself too: main has a `diagnose` tool (`pi/diagnose.ts`, wired by `telemetry/agent.ts`), so the
owner can ask through a Source why something failed. Without an operation id it returns the last day's problems and turns;
with one, that turn's timeline. Each event comes in a line (kind, status, timing, tool or model, error), never
content, and the result is marked untrusted because its private details can come from remote servers. It grants nothing. A conversation
that is not in `app_conversations` (a routine's run) has no entries page; its turns and events are still in the ledger.
