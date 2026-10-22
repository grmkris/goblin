# Sources

A **Source** ([ADR 0066](../adr/0066-sources.md)) is an MCP connection whose events carry the owner's own messages into
goblin, and goblin's answers back, by a setup the owner confirmed at an exact revision. Nothing in it names a server:
the setup is JSON pointers and argument templates (`SourceSetup`, `packages/contracts/src/sources.ts`). All external
message transport, a chat app's included, directly or through a gateway, uses this path (ADR 0069). There is no
built-in channel or competing connection switch, and no code that knows a server: a Source configures itself from what
its server says ([ADR 0096](../adr/0096-a-source-configures-itself-from-its-servers-guide.md)).

## How a Source configures itself

The owner asks for one ("set up my chat"); the agent sets it up from the server, not from goblin:

1. **The server's guide.** `mcp_list` on the connection carries the server's own `instructions` (untrusted, cut to
   2000 characters), which name its guide skills. With skills on for the connection (ADR 0008), the agent activates the
   guide (`skill_activate`) and follows its recipe for a client; the skill grants nothing.
2. **What the connection offers.** `mcp_list` with `events: true` and the read and reply tools named in `tools` gives the
   event's `payloadSchema` and each tool's input and output schemas. The agent uses each name exactly as this connection
   lists it: through a gateway an app's `post_reply` may be `notes_post_reply`.
3. **The proposal.** `source_propose` sends the five facts. goblin checks them against the connection now (below); a
   refusal reaches the agent whole (at most 2000 characters), so it fixes every problem in one more call.
4. **The owner's one confirm.** The review card shows the facts, the exact setup, and a warning when the reply has no
   result rules; only Confirm of that revision runs it.

## The setup

Five facts and a default (`SourceSetup`):

- `wake`: the event that says new content exists, with the arguments it is subscribed with.
- `key`: one to four named RFC 6901 pointers into a message (`chat: /chat`, `thread: /threadId`); a conversation's key
  is the JSON of their values in order (`["dm",null]`), at most 512 characters.
- `speaksForMe`: `{ all: true }` or `{ pointer, equals }`; `others` says what becomes of anyone else's message
  (`notice`, an untrusted notice to the owner, or `drop`).
- `read`: `{ from: 'payload', items?, id?, text, title?, attachments?, direction? }` reads the event's data (a list at
  `items`, else the data is one message; without `id` a message is known by the event's id and its place);
  `{ from: 'tool', tool, arguments, items, cursor, id, text, title?, attachments?, direction? }` calls a tool from a
  cursor, `"{{cursor}}"` a whole argument value. `title` points at the conversation's name (a chat's title);
  `attachments` at a list of MCP content blocks (`resource_link`, `image`, `resource`, `audio`), shaped as a tool
  result's content is, that the message brought.
- `reply` (optional): `{ tool, arguments, maxChars, result }`, its arguments using `"{{key.<name>}}"`, `"{{text}}"`
  (required) and `"{{operationId}}"`; `result` (ADR 0072) says which value of the tool's structured result means
  accepted, retryable or rejected, and is required when the tool declares an output schema (ADR 0096).
- `newKeys`: what a conversation seen for the first time gets (`held` unless the setup says otherwise): a route, or
  `{ to: 'topic-per-key' }`, a new Topic of its own answered by goblin.

Templates fill whole string values only (`placeholdersOf`, `fillTemplate`, `templateProblem`): a string that holds `{{`
and is not one placeholder is refused, and an unknown placeholder too; the contract checks a setup's templates when it
decodes. `sources/setup.ts` checks a setup against what the connection offers now: the event (subscribable by poll and
webhook), the read and reply tools, and every pointer against the event's `payloadSchema` or the read tool's
`outputSchema` (`sources/pointer.ts`: properties, items, local `$ref`s and `allOf`/`anyOf`/`oneOf` branches; a schema
that lists its properties without `additionalProperties` says a pointer to any other is absent; one that says nothing
lets it be). When the reply tool declares an `outputSchema`, `reply.result` is required (the refusal lists the schema's
fields that name their values, `/status ("sent", "retryable", "rejected")`), each rule's pointer must be in that schema,
and each `equals` one of the values its field's `enum` or `const` allows when it lists them. A reply tool that declares
nothing may go without rules: its outcomes are unknown, and the owner hears of each one.

No server suggests a setup (ADR 0068): goblin reads an event's standard fields only, never its `_meta`. The agent
proposes one from the event's `payloadSchema`, the tools' schemas and the server's guide skill.

## Proposing and confirming

A proposal comes from the agent only (`source_propose`, `pi/sources.ts`, which ends its turn and leaves a review card
in the chat; the card is also on the connection's card, `components/connection-sources.tsx`), so a Source keeps no
proposer. `proposeSource`
(`sources/program.ts`) checks it and keeps it as revision 1 in `app_source_setups`; the same operation finds the same
proposal. Only the owner's `confirm` of that exact revision binds it (`bind`): resident authority is checked, the wake
selector is granted (`Events.grant`) and the read and reply tools (`McpGrants.setTool`), a tool read is started at the
end of what is there (`startCursor`), the event is subscribed under consumer `source:<id>` at a new binding revision
(handler `source-wake`), the old binding is ended, and the Source is bound to the connection's endpoint and a digest of
its tools' grant versions (`bound`). Confirming answers the connection's offer of events, as a routine does (ADR 0041).
`refuse` marks the revision refused; `pause` ends the subscription; `resume` binds it again as it is now, so what came
while it was paused is not taken; `remove` ends it and forgets the Source, its routes, what it held and what it owed.

## Messages in

`SourcesLive` (`layers/sources.ts`, after the routines whose notices it posts) makes the engine once and registers the
`source-wake` handler with Events before the agent runs anything. A delivery counts only for a Source that is active at
its binding (`consumeSourceEvent`). An occurrence more than five minutes older than the binding, or a day old, is
dropped (a producer replaying its backlog). While the Source is still bound as it was confirmed (else it pauses for
review), a payload read takes the event's messages at once (`takeEvent`); a tool read is marked due and pulled by the
Sources' alarm (`sourcesWake`, `sources/wake.ts`), a page at a time from the stored cursor (`pull`). A `terminated`
control marks the Source to be subscribed again; a `gap` pulls a tool read again.

Each message (`sources/messages.ts`) is read by the setup alone: skipped unless it is incoming (`direction`), keyed and
has words or attachments. Its conversation is named by the text at `read.title` (one line, at most 80 characters), and
the route keeps the newest name a message gave. A conversation seen for the first time gets a route from `newKeys`
(`app_source_routes`, `updated_by` `default`); with `topic-per-key` goblin makes it a Topic of its own (`sourceTopicFor`,
`sources/places.ts`, by operation `source-topic:<source>:<digest of the key>`), named after its title, else its values,
else the connection's label. If two keys have the same title, later Topics receive a numbered suffix; the operation id
remains the identity for retries. A Topic that cannot be made leaves it held, reported. A message whose speaks-for-me
rule does not match is dropped before route or Topic creation when `others: drop`; otherwise it becomes a notice. A message the speaks-for-me rule matches is the owner's: in a Topic it becomes a turn
(`ChatOperations.send` through `submitTurn`, `sources/turns.ts`, receipt `source` from origin `source`, flow `source`
via `mcp`), with a Persona it is that Persona's ask in the Topic (`askPersonas`), with `listen` a passive `app.source`
note, with `ignore` nothing, and with `held` it waits in `app_source_held` (the twenty newest; the rest are counted and
the count goes before the first one delivered). The turn's operation is `source-<source>-<message id>` (a long id as
its digest), so the same message is the same operation. Its author is the connection's label and the conversation's
title, else its values (`Chat · Trip planning`, `Chat · chat dm`). Its content carries goblin's mark after the words,
`{"ownTurn":{"via":"source"}}` (`OwnTurnMark`, the origin its receipt names), which the web reads to treat it as the
owner's own turn (a scroll anchor and a row of the turn map, which names the connection); the words are one block
before it, so nothing they say can add one. A passive note (`listen`) carries no mark. Anyone else's message is a
notice (`app.notice`, framed as untrusted data from the connection, counted into the Source's hour of twenty) in the
route's Topic, or Personal; it never starts a turn, and what it brought is never fetched.

The owner's own message's attachments are kept before it is routed, held or not, since a link may not last: the ports
read each block at `read.attachments` (a link, an image or audio with its bytes, or an embedded resource) and keep it
with `materialize` (`mcp/content/materialize.ts`, ADR 0065) under `/agent/received/<connection>/<day>/`, an image as an embedded
blob named `image`. Short embedded text also becomes a file, even below an ordinary tool result's inline threshold.
The turn names the kept files after its words as untrusted references from the connection
(`ReceivedBlock`: `received`, and a `notReceived` note for each block not kept or not MCP content), and a kept image of
at most 256 KiB is shown inline when the owner's model takes images. A held message keeps the files' references
(`app_source_held.files`), not the images; a Persona's ask carries the references only. A message with attachments and
no words is a turn that says so. A message read again after a failure may keep its files again.

## Routes

The route table (`GET /api/sources/:id/routes`) lists each conversation, its values, its title, its route, what it
holds and its revision; the route table and Activity's offer name a conversation by its title, else its values. `PUT /api/sources/:id/routes` and the agent's `source_route` (only on the owner's direct request) set one
through the engine's permit, deliver what it held in order, and leave an organize receipt `source.route`
(`<source>:<key>`) whose Undo puts the route back with no delivery while its revision is the one the change left
(`undoSourceRoute`, `sources/undo.ts`). `source_routes` lists every Source's conversations in words for the agent.
`SourceView.waiting` carries the conversations held for a route; Activity offers each one with a route select and
lists Sources paused for review with Resume. A `source.route` receipt the workspace feed brings, new or undone, makes
the web read the Sources and their route tables again (`lib/workspace/invalidations.ts`).

## Answers back

A turn of a Source with a reply is owed in `app_source_replies` and the alarm is set. Before the first dispatch,
`sources/reply-plan.ts` freezes its reply text as calls cut to `maxChars`, arguments, operation ids
(`reply-<n>-<turn's operation>`), connection, tool, reviewed setup and result rules. Every accepted piece advances a
durable `next_piece` before the next dispatch. Retries and reconstruction use these frozen calls without needing the
original Pi answer. A dispatch intent without a recorded result becomes terminal unknown, never an automatic resend.

The full MCP result is interpreted with the owner's `reply.result` rules ([ADR 0072](../adr/0072-source-reply-result-outcomes.md)).
One matching rule means accepted, retryable or rejected; `isError` is rejected. Missing, conflicting or unmatched rules
mean unknown. A transport failure is unknown. Accepted means tool acceptance, not external delivery. Only retryable
results permit another attempt, after local backoff and `retryAt`, at most five tries within a day of the original
message. The same day limit applies while a Source is inactive with its binding intact or its answer is not ready. Retiring
the binding (including owner Pause) rejects pending calls tied to that old binding. A future `retryAt` beyond that
deadline causes expiry without an early dispatch. Terminal failures remain due for idempotent reporting until their owner notice succeeds; each delivery records ids,
counts and its outcome in the `source_delivery` flow and `source.reply` ledger, never content.

Calls run as goblin under current resident authority and the owner's exact grant. Immediately before dispatch, the
Source must still be active with the original revision, binding and setup. The owner can edit reply rules from the
Source review card. `PUT /api/sources/:id/reply-result` requires the shown revision and creates an unconfirmed proposal;
only Confirm starts it again. Binding attempts reserve a unique durable `lastBinding` value and activate through
a compare-and-set against the reviewed revision, setup, state and reservation after network waits. A stale confirm,
resume, cleanup or resubscribe cannot overwrite a newer edit or binding. An entirely acknowledged plan can settle accepted after restart even if that setup has
since changed, because no further call is made.

## Notify me via

`app_notify_sink` keeps one setting (`NotifySink`): a connection, a tool it offers and arguments whose whole string
values may be `{{text}}` (required) and `{{operationId}}`. `PUT /api/notify-sink` grants the tool, as the owner chose
it; `GET` reads it with the connection's label; `DELETE` clears it. Settings → Notify me via sets it, and copies a
confirmed Source's reply template and result rules with one of its conversations' keys filled in.

Two things send through it (ADR 0070, `sendThroughSink` in `sources/notify.ts`): a routine's notice copies
(`tellMe.copy`, [routines.md](routines.md)) and an agent app's `notify` power ([agent-apps.md](agent-apps.md)). Each
send fills the template with the words as written and its operation id, and is goblin's own call under the owner's
grant of the tool (`caller: 'model'`, so a tool set to Ask first refuses it). Resident authority and the sink's
revision (`sinkRevision`: a fresh UUID per save, its time, and a digest of all its settings) are checked before the call and again right
before it leaves, so even an identical same-second save or clear/recreation refuses the old call.

The owner reviews `result` rules that compare pointers in the structured result with scalar values: accepted,
retryable or rejected. A missing or unmatched rule, or conflicting matches, leaves delivery unconfirmed (`unknown`)
and never automatically retries; `isError` rejects the message. Retryable results retain the same operation id and
respect optional `retryAt` in epoch milliseconds as well as local backoff. The app's notify power returns an error
for any outcome except accepted. No server-specific result vocabulary is assumed ([ADR 0071](../adr/0071-sink-delivery-rules-and-event-identity.md)).

Optional `echo` names one event and its exact arguments on the same connection. Only that stream is suppressed;
unrelated services sharing a connection still get notice copies. Copying a Source's reply into Settings copies its
wake selector for review too. Settings keeps both policies in its Delivery and echo rules field.

| Route | Purpose |
| --- | --- |
| `GET /api/sources` | Every Source with the conversations waiting for a route. |
| `POST /api/sources/:id/confirm`, `/refuse` | The exact revision (`SourceRevision`); a stale one is 409. |
| `PUT /api/sources/:id/reply-result` | Edit result rules into a new proposal (`SourceReplyResultChange`); a stale revision is 409. |
| `GET /api/sources/:id/routes`, `PUT` | The route table; one conversation's route (`SourceRoutePick`). |
| `POST /api/sources/:id/pause`, `/resume`, `DELETE /api/sources/:id` | Pause, bind again, remove. |
| `GET`, `PUT`, `DELETE /api/notify-sink` | Notify me via. |

## Storage and tests

The application baseline creates `app_source_setups`, `app_source_routes`, `app_source_held`, `app_source_replies`
and `app_notify_sink`, including conversation titles and held-message file references (`storage/sources.ts`). Unit tests run the real migrations in
`node:sqlite` with the engine's ports and the MCP host faked (`test/sources-*.test.ts`): pointers against schemas and
template leaves, confirm granting and subscribing, an owner message as a turn in the routed Topic, someone else's as a
notice, a conversation named by its title and given a Topic of its own, attachments kept and held by reference, a held
conversation routed and undone, an answer in pieces once, retries and the give-up notice, a terminated subscription
made again and a changed grant pausing the Source. The workerd canary (`test/integration/sources-probe.ts`, in the
native suite) runs a Source end to end on the real agent over the official Events producer, with neutral fixture names
(`post.created`, `feed_read`, `post_reply`, `/author/kind`): confirmed, a signed
webhook, a tool read from its cursor, the owner's message (with a photo and UTF-8 text attachment kept under
`/agent/received`) a marked turn in a Topic made for its chat, a same-title second chat in a separate Topic, someone
else's an untrusted notice, and each answer sent once under its operation id. Another canary verifies that
`others: drop` creates no foreign route or Topic and cannot retitle an existing route. The `source-propose` canary
(`test/integration/source-propose-probe.ts`, cases in `source-propose-case.ts`) has the scripted model set one up as
the agent would: activate the server's guide skill, list the event and tools with their output schemas, be refused
without result rules, propose with them; then the owner confirms it, a signed post is the owner's marked turn in its
chat's own Topic, and the answer goes back accepted with no notice. Its second case does the same through a gateway's
`notes_` names. A mail-shaped setup (read from the event's data, no cursor, no reply) is covered by the unit tests. The browser walk is `apps/web/test/ui-sources.ts`. None of it is deployed-stage evidence.
