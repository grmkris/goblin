# ADR 0110: The agent serves every chat's stream to every reader

Status: Accepted 2026-10-22, from the approved Watch, Act, Know plan (its Slice W); built. Supersedes ADR 0109's
transport: its join endpoint, signed stream URL, Durable Streams objects, epochs and tiers (0109's mapping of Pi's
events to AG-UI stays). Amends ADR 0081 and ADR 0098: a server's key with the `conversations` scope reads a chat's
stream in full; `transcripts` still gates only the inspect endpoints.

## Context

ADR 0109 put each chat's AG-UI events into a Durable Streams object per epoch and tier: a reader joined
(`GET /conversations/:id/stream`), got a signed URL valid for ten minutes, read the Durable Streams protocol from an
offset, and joined again after `goblin.stream.moved` or once the link expired. A review on 2026-10-22 found that:

- a stock AG-UI or server-sent events client could not follow a chat without goblin's join, links, epochs and
  framing;
- a server's key read only the `answers` tier, so Swarmm could not show its customers a Persona's thinking or tool
  calls, and still polled `entries?after=`;
- every chat anyone ever joined was produced into its stream object forever, readers or not, with a row written per
  append (`app_streams`, `app_stream_outbox`), on a library (0.1.1) whose upstream had gone quiet.

## Decision

**The agent serves the stream.** `GET /api/conversations/:id/stream` (a member's browser under `/w/<slug>/api/…` with
its session, a server's key on `/api/…` as its bearer; scope `conversations`; a key only in its own room's chats;
no resident authority) answers `text/event-stream` itself: one `data:` frame per AG-UI event, LF line ends, a
`: ping` comment every fifteen seconds. Each connection opens with `MESSAGES_SNAPSHOT`, `STATE_SNAPSHOT` and the run in
flight with its answer so far (and each child working, `SUBAGENT_STARTED` and its work so far), then carries the
chat's events live. A reconnect is a new connection with a fresh opening, as in Pi Durable and AG-UI 1.0: no offsets,
`Last-Event-ID`, epochs, signed tokens or join.

**One tier.** Every caller that reaches the chat reads everything: text, reasoning, tool calls with their results,
steps, STATE, a child's work under its `subagentRunId`. The tiers, `goblin.stream.moved` and the join contract
(`ConversationStream`, `StreamTier`) are gone. A key still never holds `transcripts`; the inspect endpoints keep that
scope.

**Produced for connected readers, kept nowhere.** The producer (`streams/producer.ts`, one fiber per agent) follows a
chat only while a reader is connected: each reader is a row with its own cursor and a bounded sink (512 batches); a
burst of joins opens one Pi watch, whose snapshot opens each new reader and catches every other up; each batch is
translated over each reader's cursor and handed over at once. The fiber never waits for a reader: one whose sink is
full is let go, and one connected for fifteen minutes too (its connection ends; it reconnects for a fresh opening).
Since the platform may never tell the agent that a client went away, those two bounds are what free a gone reader's
place. The last reader to leave stops the chat's watch and its children's. A chat takes 32 readers at once and the
agent 256; one more is refused before anything streams, `Conflict` `stream_busy`. Pi's snapshot names its inputs
without their operation ids, so on a new watch the producer reads the submissions of the run in flight and of the
queue, and a reader that opens mid-run still gets `RUN_STARTED.metadata.goblin.operations`.

**A last pass for secrets.** The frame writer (`streams/frames.ts`) sends every string that holds something shaped
like a secret goblin issues or keeps (`gbk_…`, `swt_…`, `whsec_…`, `streams/redact.ts`) as `[redacted]`. Credentials
never enter the events; this is the tested backstop for the readers it now serves in full.

**Durable Streams leaves the runtime.** The outbox, store, writer, read token, tiers, the `/streams/` route and its web
forward, the `conversation_stream` MCP tool, the `STREAMS` binding of the runtime's env and the stream tables go (a
forward migration drops `app_streams` and `app_stream_outbox`; erasing an agent no longer erases streams). The
`StreamObject` class, its `STREAMS` binding and apps/web's dependency stay deployed but dormant: deleting a Durable
Object class is a destructive plan CI refuses, and goes in a reviewed infrastructure step.

**Amends ADR 0081 and ADR 0098.** A key with `conversations` reads its own room's chats' streams in full, the work of
the room's Personas' forks included; 0109's `answers` tier for keys no longer exists. An OAuth client of the owner has
no stream tool on `/mcp` any more, and the edge admits only keys on `/api/…`, so for now it follows a chat by
`conversation_entries`.

## Consequences

- goblin's web, Swarmm's server and any AG-UI client follow a chat the same way: one GET, standard server-sent events,
  standard events, goblin's metadata on top.
- A reconnect costs a fresh opening (the chat's newest entries, and its STATE) instead of the bytes missed; a
  flaky network shows the transcript as the new opening has it.
- A chat nobody reads costs nothing: no stream object, no rows, no watch.
- A reader that went away unseen holds its place for up to fifteen minutes; 32 of them on one chat refuse the next
  reader until one is let go. In local workerd the agent is never told of a closed client (checked from outside the
  dev proxy and from inside the Worker); whether Cloudflare tells it in production is not yet known.
- The stream carries a Persona's and a tool's full output to servers' keys: the redaction pass is the one guard
  against a secret-shaped value a tool or a server put in an answer.

## Rejected

- **Keeping Durable Streams with the tiers relaxed**: the join, links and epochs would still stand between a stock
  client and a chat, and every chat ever joined would still be produced forever.
- **One watch per connection** (the plan's first sketch): the producer's one fiber already kept a cursor per stream;
  rows on one watch share Pi's work and its children across a chat's readers.
- **Resuming from an offset or `Last-Event-ID`**: it needs an event log per chat, which is what was removed; a fresh
  opening is what Pi Durable and AG-UI do.
