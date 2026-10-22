# ADR 0109: Every chat streams AG-UI events through a durable stream

Status: Accepted 2026-10-22, from the approved streams plan; built. Amends ADR 0081 (a server's key and an OAuth
client may read a chat's stream, in their tier; the old event streams are gone).

## Context

The web followed a chat over a private stream: `GET /conversations/:id/snapshot` answered Pi's raw snapshot,
`GET /conversations/:id/events` its committed batches over server-sent events, and the browser projected Pi's entries
itself (`lib/projection.ts`, `lib/entry-messages.ts`), parsing the blocks the runtime writes around a user's words and
asking `/queue` again whenever the inbox changed. Every reconnect started over from a fresh snapshot. ADR 0081 refused
those streams to keys, since they carry Pi's internals, so a server (Swarmm, Sidequest) could only poll
`entries?after=`.

A chat is now also an AG-UI 1.0 stream in a Durable Streams object per epoch, in two tiers, with a join endpoint, an
MCP tool and a signed URL any reader may follow ([chat streams](../architecture/streams.md)). Keeping both meant two
mappings of the same entries, and the web would never exercise the profile third parties depend on.

## Decision

**One stream per chat, read by everyone.** goblin's web app is an AG-UI client of the same stream third parties read:
it joins (`GET /conversations/:id/stream`), reads the `full` tier from its last offset at the signed URL, live over
server-sent events with long polls where those fail, and joins again when the link expires or the epoch moves. Its
reducer folds the events into the transcript the components already draw; what the browser read of Pi's entries
(where a Thread may start, which entries a moved turn leaves out, where older history starts, the newest entry) comes
from `metadata.goblin`, and what a queued input says from STATE `/queue`.

**One mapping.** The runtime maps entries to AG-UI messages once (`streams/messages.ts`): for an epoch's opening, for
what streams, and for older pages, which the history endpoint now answers as AG-UI messages (`{ messages, next, more }`).
The server reads the tags and blocks it wrote around a user's words; the browser no longer parses them.

**The old stream is gone.** `GET /conversations/:id/snapshot` and `GET /conversations/:id/events`, their handlers and the
Pi wire types only they used are deleted, with the browser's projection of Pi's entries. No compatibility path is
kept (goblin is greenfield until launch). The workspace feed stays its own stream for now.

**Amends ADR 0081.** "Everything else (event streams, …) refuses a key" no longer covers chat streams: a key with the
`conversations` scope joins its own Topics' chats in the `answers` tier, an OAuth client holding `transcripts` in the
`full` tier and any other in `answers`; reach and the tier rule are the join endpoint's, the URL carries no credential
of the caller's. The forward read (`entries?after=`) stays.

## Consequences

- The web reconnects without a snapshot round trip: a dropped read resumes from its offset, so a flaky network costs
  only what was missed, and nothing is shown twice.
- The browser's view of a chat is exactly a third party's `full` tier: a gap in the profile is a gap in goblin's own
  UI, found by its own tests (the reducer is held to the runtime's goldens).
- A chat someone follows is written to its stream object as it runs (bytes, a little latency from the 250 ms
  coalescing). A chat nobody joined writes nothing.
- The browser no longer sees Pi's raw entries: a feature that needs something of an entry adds it to
  `metadata.goblin` (as a tool result's `toolName` was here) or to STATE.
- Queued inputs show what they say from the stream; the separate `/queue` read is only for removal.

## Rejected

- **Keeping the private stream for the web**: two mappings to keep in step, and the public profile untested by its
  first reader.
- **`@durable-streams/client`**: the protocol the web needs (catch-up, server-sent events with their control frames,
  long polls) is a small reader, and a thin one keeps the reconnect rules (join again, epochs) in one place.
- **Mapping in the browser from the raw entries in the history endpoint**: the web would keep a second copy of the
  runtime's mapping for older pages.
