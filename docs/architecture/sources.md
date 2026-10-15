# Sources

A **Source** ([ADR 0066](../adr/0066-sources.md)) is an MCP connection whose events carry the owner's own messages into
goblin, and goblin's answers back, by a setup the owner confirmed at an exact revision. Nothing in it names a server:
the setup is JSON pointers and argument templates (`SourceSetup`, `packages/contracts/src/sources.ts`). The Telegram
channel ([events.md](events.md)) runs beside it until P7 makes Telegram one Source among others; a connection carries
one or the other (confirming a Source on the channel's connection is refused as `telegram_on`).

## The setup

Five facts and a default (`SourceSetup`):

- `wake`: the event that says new content exists, with the arguments it is subscribed with.
- `key`: one to four named RFC 6901 pointers into a message (`chat: /chat`, `thread: /threadId`); a conversation's key
  is the JSON of their values in order (`["dm",null]`), at most 512 characters.
- `speaksForMe`: `{ all: true }` or `{ pointer, equals }`; `others` says what becomes of anyone else's message
  (`notice`, an untrusted notice to the owner, or `drop`).
- `read`: `{ from: 'payload', items?, id?, text, direction? }` reads the event's data (a list at `items`, else the data
  is one message; without `id` a message is known by the event's id and its place); `{ from: 'tool', tool, arguments,
  items, cursor, id, text, direction? }` calls a tool from a cursor, `"{{cursor}}"` a whole argument value.
- `reply` (optional): `{ tool, arguments, maxChars }`, its arguments using `"{{key.<name>}}"`, `"{{text}}"` (required) and
  `"{{operationId}}"`.
- `newKeys`: the route a conversation seen for the first time takes (`held` unless the setup says otherwise).

Templates fill whole string values only (`placeholdersOf`, `fillTemplate`, `templateProblem`): a string that holds `{{`
and is not one placeholder is refused, and an unknown placeholder too; the contract checks a setup's templates when it
decodes. `sources/setup.ts` checks a setup against what the connection offers now: the event (subscribable by poll and
webhook), the read and reply tools, and every pointer against the event's `payloadSchema` or the read tool's
`outputSchema` (`sources/pointer.ts`: properties, items, local `$ref`s and `allOf`/`anyOf`/`oneOf` branches; a schema
that lists its properties without `additionalProperties` says a pointer to any other is absent; one that says nothing
lets it be).

A server may suggest a setup on an event as `_meta.suggest.source` (`eventSuggestion`, `mcp/events/protocol.ts`): its
key, speaks-for-me rule and read must hold for there to be one, and a reply, a rule for others, a route for new
conversations or arguments that do not hold are left out on their own. It reaches the owner as `EventStream.source`.

## Proposing and confirming

A proposal comes from the owner (Connections, from a server's suggestion: `POST /api/sources`) or the agent
(`source_propose`, `pi/sources.ts`, which ends its turn and leaves a review card in the chat). `proposeSource`
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
has words. A conversation seen for the first time gets a route from `newKeys` (`app_source_routes`, `updated_by`
`default`). A message the speaks-for-me rule matches is the owner's: in a Topic it becomes a turn
(`ChatOperations.send` through `submitTurn`, `sources/turns.ts`, receipt `source` from origin `source`, flow `source`
via `mcp`), with a Persona it is that Persona's ask in the Topic (`askPersonas`), with `listen` a passive `app.source`
note, with `ignore` nothing, and with `held` it waits in `app_source_held` (the twenty newest; the rest are counted and
the count goes before the first one delivered). The turn's operation is `source-<source>-<message id>` (a long id as
its digest), so the same message is the same operation. Its author is the connection's label and the conversation's
values (`Chat · chat dm`). Anyone else's message is a notice (`app.notice`, framed as untrusted data from the
connection, counted into the Source's hour of twenty) in the route's Topic, or Personal; it never starts a turn.

## Routes

The route table (`GET /api/sources/:id/routes`) lists each conversation, its values, its route, what it holds and its
revision. `PUT /api/sources/:id/routes` and the agent's `source_route` (only on the owner's direct request) set one
through the engine's permit, deliver what it held in order, and leave an organize receipt `source.route`
(`<source>:<key>`) whose Undo puts the route back with no delivery while its revision is the one the change left
(`undoSourceRoute`, `sources/undo.ts`). `source_routes` lists every Source's conversations in words for the agent.
`SourceView.waiting` carries the conversations held for a route; Activity offers each one with a route select and
lists Sources paused for review with Resume.

## Answers back

A turn of a Source with a reply is owed in `app_source_replies` and the alarm is set. Each alarm sends what is due
(`sources/replies.ts`, over `deliverReady`, `sources/delivery.ts`): an answer still running waits (a day at most, then
it is given up); a settled one (goblin's, or the Persona invocation's) goes out through the reply tool in pieces of
`maxChars` (`chunks`), each piece with its own operation id (`reply-<n>-<turn's operation>`), so a retry never sends one
twice to a server that honours them. The call is goblin's own under the owner's grant (`caller: 'model'`): an
Ask-first reply tool refuses it. A failed send is tried again after a minute, doubling to an hour, and given up after
five tries with a notice to the owner. A paused Source keeps what it owes until it runs again or the day is out. Each
delivery is a `source_delivery` flow and a `channel.reply` line with channel `source`; ids and counts only.

## Notify me via

`app_notify_sink` keeps one setting (`NotifySink`): a connection, a tool it offers and arguments whose whole string
values may be `{{text}}` (required) and `{{operationId}}`. `PUT /api/notify-sink` grants the tool, as the owner chose
it; `GET` reads it with the connection's label; `DELETE` clears it. Settings → Notify me via sets it, and copies a
confirmed Source's reply template with one of its conversations' keys filled in.

Two things send through it (ADR 0070, `sendThroughSink` in `sources/notify.ts`): a routine's notice copies
(`tellMe.copy`, [routines.md](routines.md)) and an agent app's `notify` power ([agent-apps.md](agent-apps.md)). Each
send fills the template with the words as written and its operation id, and is goblin's own call under the owner's
grant of the tool (`caller: 'model'`, so a tool set to Ask first refuses it). Resident authority and the sink's
revision (`sinkRevision`: when it was set and a digest of what it says) are checked before the call and again right
before it leaves, so a sink changed or cleared on the way refuses it. A notice of an event from the sink's own
connection gets no copy.

| Route | Purpose |
| --- | --- |
| `GET /api/sources` | Every Source with the conversations waiting for a route. |
| `POST /api/sources` | A proposal (`SourceProposal`), 201; the same operation finds it again. |
| `POST /api/sources/:id/confirm`, `/refuse` | The exact revision (`SourceRevision`); a stale one is 409. |
| `GET /api/sources/:id/routes`, `PUT` | The route table; one conversation's route (`SourceRoutePick`). |
| `POST /api/sources/:id/pause`, `/resume`, `DELETE /api/sources/:id` | Pause, bind again, remove. |
| `GET`, `PUT`, `DELETE /api/notify-sink` | Notify me via. |

## Storage and tests

Migration `20261102000100_sources` adds `app_source_setups`, `app_source_routes`, `app_source_held` and
`app_source_replies`; `20261102000200_notify_sink` adds `app_notify_sink` (`storage/sources.ts`). Unit tests run the
real migrations in `node:sqlite` with the engine's ports and the MCP host faked (`test/sources-*.test.ts`): pointers
against schemas and template leaves, the lenient suggestion, confirm granting and subscribing, an owner message as a
turn in the routed Topic, someone else's as a notice, a held conversation routed and undone, an answer in pieces once,
retries and the give-up notice, a terminated subscription made again and a changed grant pausing the Source. The
browser walk is `apps/web/test/ui-sources.ts`. None of it is deployed-stage evidence.
