# ADR 0111: AG-UI's run input is the send

Status: Accepted 2026-10-22, from the approved Watch, Act, Know plan (its Slice A); built. Supersedes the message body
the owner API and ADR 0081's keys sent (`SendMessage`: `{ input, operationId, appContext?, attachments?, selections?,
personaOrder? }`), ADR 0034's thread operation body (`StartThread`: `{ operationId, anchor, message,
personaOrder? }`) and ADR 0033's `SendMessage.personaOrder` (now `forwardedProps.goblin.personaOrder`). Hard switch: no
legacy body and no compatibility window; Swarmm switches back to back with the release.

## Context

ADR 0110 made every chat's stream plain AG-UI over server-sent events, so a stock AG-UI client could follow a chat. It
could not drive one: a send was goblin's own `SendMessage`, and the only answer was a receipt, after which a client had
to open the chat's stream and work out which run was its own. An AG-UI client sends `RunAgentInput` (`threadId`,
`runId`, the whole conversation in `messages`, `tools`, `context`, `state`, `forwardedProps`, `resume`) and reads that
one run's events back. goblin's web, Swarmm's server and any AG-UI client should send the same way.

## Decision

**The send is `RunAgentInput`.** `POST /api/conversations/:id/messages` takes AG-UI's `RunAgentInput` (`@ag-ui/core`
1.0.3; `RunInput` in `packages/contracts/src/agui/run-input.ts`), and so does the thread operation's first message
(`StartThread.message`). One mapper reads it (`chats/run-input.ts`), for the HTTP handlers and, through them, the MCP
tools:

- `threadId` must be the chat the path names (`thread_mismatch` otherwise). `runId` is the operation id
  (`OperationId`): the same run id is the same send, admitted once, as before.
- `messages` is read leniently, since a stock client resends the whole conversation: only the last one is decoded, and
  it must be a user message whose content is text, or parts of which every one is text (joined as AG-UI joins them).
  Goblin's transcript is the truth; earlier messages are not read. Refusals are `InvalidInput` with a reason:
  `no_user_message`, `last_message_not_user`, `user_message_shape`, `non_text_content` (files go in
  `forwardedProps.goblin.attachments`), `message_too_long` (over 20 000 characters).
- `forwardedProps.goblin` holds goblin's parts with their old schemas and limits: `attachments`, `selections`,
  `personaOrder` and `appContext`. A Persona tag is `selections: [{ kind: 'persona', personaId }]`, as Swarmm sends on
  every message. Other keys of `forwardedProps` are ignored; it must be an object.
- `tools` and `state` are ignored when empty and refused when not (`client_tools`, `client_state`): goblin runs its own
  tools and keeps its own STATE.
- `context` is ignored. An AG-UI context entry is free text with a description; goblin's App context names the App it
  came from by id (`appContext`), which the runtime resolves to its origin, so the two do not map cleanly. App context
  stays in `forwardedProps.goblin.appContext`.
- `resume` answers the chat's interrupts by their ids (`<chat>:i<entry>`, the stream's `/attention`). A `resolved`
  answer to an open `question` carries the owner's answer as text (`payload`, a string), and becomes the send's words
  when its last message is absent, not the user's, or says nothing; the owner's next message settles every question
  before it, as it always did. A `cancelled` entry is nothing. A `resolved` entry for any other reason is refused with
  the endpoint that answers it (`resume:approval:POST /api/mcp/approvals/:id`, `resume:grant:PUT /api/mcp/grants`,
  `resume:url:POST /api/mcp/url-requests/:id`, `resume:access|connect:POST /api/mcp/:id/connect`,
  `resume:setup:PATCH /api/topics/:id/setup`), and one for an interrupt that is not open is `interrupt_not_open`. A
  retry of an admitted run id is not checked against open interrupts: its first send settled them.

**The thread operation.** `POST /api/conversations/:id/threads` takes `{ anchor, title?, mcpServers?, message }`,
`message` a `RunAgentInput` for the chat the path names. Its `runId` is the operation's id (the same run id finds the
same Thread), and the Thread's first message is `<runId>:first`, as before; the Persona order is the message's
`forwardedProps.goblin.personaOrder`. It answers 201 with the Thread and the receipt; it does not stream.

**Answer by `Accept`.** Without `text/event-stream`, the send answers 202 with Pi's receipt, exactly as before: the
web's composer and Swarmm's relay send this way. With it, the answer is that send's run as AG-UI events over
server-sent events (`streams/run.ts` `RunFollow`, `layers/run-streams.ts`), framed as the chat's stream is (one `data:`
per event, a `: ping` every fifteen seconds, secrets redacted), and it ends after the run's end:

- A watch of the chat of its own opens before the send is admitted, and its batches are translated over its own
  cursor. Nothing is sent until the run that took the send's input starts (its `RUN_STARTED` names the operation, or its
  run id names the input); then `RUN_STARTED` under the send's `runId` and `threadId` (`metadata.goblin.run`, the
  chat's own run id), `STATE_SNAPSHOT`, and that run's events until its `RUN_FINISHED` or `RUN_ERROR`, re-labelled with
  the send's ids. A send queued behind another run streams nothing of that run.
- A send whose input is already in the run in flight (a retry of one under way) opens with what the run said so far; one
  placed into a run in flight opens with the starts of what is open in it.
- The send's own user message is left out (its client holds it), and so is a chat's children's work (`SUBAGENT_*`
  and anything with `subagentRunId`): AG-UI's verifier refuses `RUN_FINISHED` while a subagent is at work, and a
  Persona's fork or a subagent goes on past a run. The chat's stream carries them.
- `RUN_FINISHED`'s interrupts are the run's open questions only, the interrupts a send can answer with `resume`; a
  held call, a grant, a URL request or a sign-in shows in STATE `/attention` and is answered by its endpoint.
- **An ask of Personas** has no run of the chat's. Its run starts at once (`RUN_STARTED` naming the operation,
  `STATE_SNAPSHOT`), carries each tagged Persona's answer as the chat's stream writes it (an assistant
  `TEXT_MESSAGE_*` with `name` and `metadata.goblin.persona`), and ends once its invocations settled and their answers
  were carried: `RUN_FINISHED` `interrupt` with the questions an answer asked, `success` otherwise (an answer held for
  a decision too); `cancelled` when every Persona was stopped; `RUN_ERROR` with the first failure's reason when none
  answered. Its fork's own work stays in the chat's stream.
- A retry (the operation was admitted before): one that ended answers `RUN_STARTED` and its end at once, with
  `metadata.goblin.replayed` naming the input's entry and its answers' entries; one under way is followed as above. An
  input withdrawn before a run took it ends in `RUN_ERROR` (`withdrawn`). A send that no run of the chat takes (it
  answered a routine's question, or went to a subagent through its spawner) answers `RUN_STARTED` and `RUN_FINISHED` at
  once.
- An agent takes 32 run streams at once; one more is refused before anything is admitted, `Conflict` `stream_busy`. A
  run stream ends after fifteen minutes, or when the chat's watch ends, in `RUN_ERROR` (`stream_lifetime`,
  `stream_ended`): the run goes on in the chat, which its stream and entries tell.

**Bigger bodies for sends.** The edge caps a JSON body at 64 KiB; a send's and a thread operation's at 1 MiB, since a
stock client resends the conversation with every run.

**Callers.** The web's composer, thread starts and App continuations send `RunAgentInput` through the contract's
builders (`runInput`, `threadStart`). The MCP tools `conversation_send` and `thread_start` keep their plain fields
(`PlainSend`, `PlainThreadStart`), which a model writes more easily, and their adapters build the body with the same
builders, so a tool and a request are one handler.

## Consequences

- goblin's web, Swarmm and any AG-UI client send the same body. In local workerd a stock `HttpAgent` with a key runs a
  turn end to end, its own verifier accepting every event (`run-streams-case.ts`); `scripts/agui-client-check.ts` does
  the same against a stage, and has not been run against dev yet.
- Every sender changes at once. Swarmm builds `RunAgentInput` for its messages and job threads and deploys back to back
  with goblin's release; a message refused in between is sent again.
- A stock client's history costs bandwidth on every send, bounded by the 1 MiB cap; goblin reads only its last message.
- A send's run stream holds a Pi watch while it waits; the 32-stream cap and the fifteen-minute life bound what clients
  that went away unseen can hold.
- A Persona's hold ends its ask's run as `success`: a client that needs to know reads STATE `/attention` or the
  chat's stream.

## Rejected

- **A separate AG-UI route beside the old body**, or a compatibility window: two bodies for one operation, and every
  integrator is ours to switch.
- **Echoing the input in `RUN_STARTED`**: AG-UI allows it, but a stock client's input holds the whole conversation,
  up to 1 MiB, which one event is not for.
- **Mapping `context` to App context**: a context entry names no App, and goblin resolves an App's origin by its id.
- **A Persona's hold as a run interrupt**: `resume` cannot answer it, and a stock client must answer every interrupt
  of a run before its next one.
