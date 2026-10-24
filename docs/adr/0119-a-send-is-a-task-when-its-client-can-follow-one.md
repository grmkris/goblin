# ADR 0119: A send is a task when its client can follow one

Status: Accepted 2026-10-24 (owner). Supersedes the `ask_agent` and `get_recent_messages` tools of ADRs 0003 and 0086,
and their `POST /api/agent/ask` and `GET /api/agent/recent`. Amends ADR 0086 (what `/mcp` serves besides its tools) and
ADR 0111 (what a send answers on `/mcp`).

## Context

On `/mcp` a send (`conversation_send`, `thread_start`) answered its receipt at once, and a client then read
`conversation_entries` until an answer appeared. Only `ask_agent`, a send into Personal's main conversation, waited for
the answer, for up to 110 seconds, and answered `running` past that. So a client could wait in one chat only, and
waiting held a request open for as long as the turn took.

The 2026-07-28 protocol moved tasks out of the core into the Tasks extension (`io.modelcontextprotocol/tasks`,
[SEP-2663](https://tasks.extensions.modelcontextprotocol.io/seps/2663-tasks-extension)):
- a client declares the extension in each request's envelope;
- a server may answer such a `tools/call` with a task (`resultType: "task"`);
- the client polls `tasks/get` until the task is `completed`, `failed` or `cancelled`, with `tasks/update` for input
  and `tasks/cancel` to stop it.

The extension has no progress notifications. A task's `statusMessage` says what it does.

## Decision

**A send is a task when its client follows tasks.** `conversation_send` and `thread_start` answer a `CreateTaskResult` to
a request that declared the extension, once Pi has accepted the send. Any other request gets the receipt, as before.
Nothing waits anywhere: a client polls, `tasks/get` with a task and `conversation_send_status` without one, or listens
to `conversation.updated` (ADR 0112).

**The task is the send.** Nothing is stored for a task. Its id is opaque to the client: `t1.` and base64url JSON of the
workspace's id, the chat, the send's operation id and when it was made. It grants nothing: each `tasks/*` call checks
the workspace against the caller's reach, as a `workspace` argument is checked, then reads the send. The read is
`GET /api/conversations/:id/sends/:operationId` (`SendStatus`, a credential's `read`, no resident authority), which
the new `conversation_send_status` tool also calls. So any isolate answers for any task.
- **Queued or running:** `working`, with `statusMessage` the send's step in plain words, read from the chat's newest
  entries (`chats/send-status.ts`): `waiting for its turn`, `thinking`, `calling <tool>` or `waiting for a person`.
- **Answered:** `completed`; its `result` is a `CallToolResult` with the answer as text, and the chat, operation id and
  text as structured content.
- **Stopped** (Pi's `aborted` or `withdrawn`): `cancelled`.
- **Ended without an answer otherwise:** `completed` with an `isError` result naming Pi's reason. `failed` is for a
  protocol error, which a send that was already accepted never becomes.
- **Timing:** `pollIntervalMs` is 2000 and `ttlMs` a day.

**The methods.**
- `tasks/get` reads the send.
- `tasks/cancel` stops it (`conversations.stop` with its operation id, `write`, as `conversation_stop`).
- `tasks/update` acknowledges: no send waits for input through a task yet, so every key is one not outstanding, which the
  extension says to ignore.

Each needs the extension declared on its request (else -32021, naming it) and a task id goblin made whose send the
caller reaches now (else -32602). `/mcp` declares `extensions["io.modelcontextprotocol/tasks"]` to a credential whose
grant reaches a send's status. A 2025-era client never sees a task: only a 2026-07-28 request has the envelope that
declares one.

**`ask_agent` and `get_recent_messages` go**, with `POST /api/agent/ask` and `GET /api/agent/recent`. Asking the agent
is a send into Personal's main conversation (chat `1`) like any other, and its newest messages are
`conversation_entries`.

## Consequences

- A client that follows tasks sends into any chat it reaches and is told when the answer is there, with its step in the
  meantime. One that does not gets the receipt and `conversation_send_status`, which answers the send's state and its
  answer in one read.
- goblin's questions, held calls and approvals are a task's `waiting for a person` step for now. Making them
  `input_required`, with their `inputRequests` answered through `tasks/update`, is a later step.
- The SDK's own client refuses a result type it does not know, so a client following tasks reads `/mcp` with a client
  that implements the extension (goblin's integration case speaks it by hand).

## Rejected

- **A blocking wait** (`ask_agent`'s, for every send). It holds a request open for as long as a turn takes and still
  answers `running` past a limit; a task answers at once and is polled.
- **A task store.** The send's own state already says everything a task does, and a store would need its own expiry and
  routing.
- **`notifications/tasks` over `subscriptions/listen`.** Optional in the extension; a client that wants a push has
  `conversation.updated`.
