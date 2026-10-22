# ADR 0112: goblin publishes MCP Events

Status: Accepted 2026-10-22; built. Amends ADR 0081 (a key's forward read is joined by a wake it can subscribe to) and
ADR 0086 (`/mcp` serves the Events methods beside its tools, each calling one owner endpoint as the caller).

## Context

A server that works through goblin with a key (Swarmm, ADR 0081) learns that a chat changed only by reading it:
`GET /api/conversations/:id/entries?after=` on a timer, for every chat it follows. That costs a request per chat per
poll, adds the timer's delay to every answer, and keeps a cron running when nothing happens. goblin already consumes
the draft MCP Events profile (ADR 0011) from Sidequest and mygram, so the integrators that build on it know its
methods, its signed webhooks and its leases. goblin had no way to say "this chat changed" to anyone but its own web.

## Decision

**goblin is an Events producer.** It publishes one event, `conversation.updated`, through the same profile it
consumes: `events/list`, `events/subscribe`, `events/unsubscribe` and `events/poll`, with `delivery: ["poll",
"webhook"]`; `events/stream` is unsupported (-32014). The profile for integrators is
[published-events.md](../architecture/published-events.md).

**A wake, never content.** Its data is `{ chat, topic, entry, activity, attention }`: the chat that changed, its
Topic's id (null in Personal), its newest committed entry (the cursor `entries?after=` reads past), whether it, a
Persona answering in it or one of its subagents is working, and how many items in it wait for a person (the length of
its stream's STATE `/attention`, folded from its entries as the stream folds them). A Persona's fork and a subagent
are never the subject of a wake: their work counts for the chat they work for. Whoever gets a wake reads the chat
with its own credential.

**When.** Pi's commits name the sessions they touched, Persona invocations and chats that open or close name theirs,
and one fiber looks at each chat 250 ms after a change and at most once a second. A wake goes out only when what it
says changed; so a turn ending, or attention changing, always sends one, and a streamed token never does. A change is
noted in `app_publish_dirty` before it is looked at, so one an eviction cut off is looked at after the restart. While
no lease runs and nobody polled within the journal's retention, nothing is journaled at all.

**Who sees what.** A lease belongs to its holder: a key (`key:<id>`), an OAuth client for the person it acts for
(`client:<id>:<user>`) or a member's session (`member:<user>`). A key's leases and polls reach only its own rooms'
chats (ADR 0108), checked at fan-out and in each poll; a client or member reaches every chat of the workspace, as
their other reads do. The selector's optional `{ topic }` or `{ chat }` narrows that, and naming one out of reach is
`NotFound`.

**Leases.** Subscribing names an https callback URL on a public host (no port, credentials, fragment, IP literal or
local suffix) and a `whsec_` secret. goblin sends a signed verification challenge, outside any transaction, which the
URL must echo within five seconds; a renewal with the same secret skips it. The lease lasts its `ttlMs` (an hour by
default, at least five minutes, at most a day); subscribing again renews it, and its id is the hash of holder,
selector and URL, so the same three always find the same lease. A holder holds at most 32 leases, a workspace 256. The
secret is sealed with the credential cipher, bound to the lease.

**Deliveries.** Standard Webhooks v1, signed with goblin's own `sign` (the one its consumer verifies with), at a fresh
timestamp per attempt; `webhook-id` is the occurrence's `eventId`, controls are `msg_<type>_<random>`, and
`X-MCP-Subscription-Id` names the lease. A lease is owed at most one waiting wake per chat: a newer one replaces the
waiting one's body and keeps its attempts. A failed attempt is retried 15 s·2ⁿ later (at most five minutes, with
jitter); a redirect, 410 or 413, the fifth attempt or fifteen minutes gives up, drops every wake owed to the lease,
owes it one `gap` control naming the position to poll from, and marks it failing until a delivery arrives again or it
is renewed. A lease that runs out, or whose holder's access ends, is sent `terminated`. Deliveries are claimed before
they are sent and settled under the claim after, and the agent's durable wake (`publishWake`) sends whatever is due
after a restart. Delivery is at least once.

**Polls.** A poll answers the occurrences after a 16-digit cursor, oldest first, at most 100, with `hasMore`, the
cursor to poll from next and `truncated` when some were pruned (the journal keeps seven days); a `null` cursor
answers where the journal is now.

**One way in.** The methods are the owner API's `events` group (`/api/events…`, scope `conversations`, never granting
resident authority), so a key uses them over REST, and `/mcp` serves the same methods by calling those endpoints as the
caller (`ownerCall`): admission, the scope, the minute's 600 requests and a key's reach are the owner API's own. `/mcp`
declares the extension `io.modelcontextprotocol/events` and the top-level `capabilities.events` to a caller holding
`conversations`; the pinned server SDK (2.3.1) keeps both on the wire, for `initialize` and `server/discover` alike. An
OAuth client that names its workspace on every call names it inside `arguments`.

**Access that ends ends the leases.** The Worker asks the agent (`POST /internal/publish/terminate`) to end a holder's
leases before it revokes or rotates a key, before a key loses `conversations`, and before it revokes an OAuth client
(in every workspace the client reached). A member removed from a workspace, or a client whose reach shrank, keeps its
leases until they run out, at most a day: their next renewal is refused by admission.

## Consequences

- Swarmm can drop its per-chat polling and its cron for a webhook that says which chat to read, and poll the journal
  when its receiver was down. Its own Standard Webhooks verifier checks goblin's signatures.
- A wake names ids and counts only; who receives one learns that a chat in its reach changed, nothing it says.
- A failed termination call is reported and the revocation still goes ahead; a lease it missed is delivered thin wakes
  until it runs out (a day at most), and its renewal is refused.
- Workers cannot pin the callback's resolved address between the check and the fetch: trusted DNS is the documented
  assumption, as for the consumer (ADR 0011).
- Five new application tables (`app_publish_*`) in an additive forward migration (`20261022230000_publish`).
- Verified in unit tests (policy, signing with goblin's verifier, retries, coalescing with a test clock, attention
  against the stream goldens, reach, polls) and on local workerd, where goblin's own consumer (`mcp/events/client.ts`)
  subscribes to goblin with a key; the deployed check is separate.

## Rejected

- **Content in the payload.** It would duplicate the stream and the forward read, and every integrator would have to
  treat a webhook body as sensitive. A wake is a pointer; the read stays the caller's own.
- **A webhook per occurrence.** A chat at work commits many times a second; one waiting wake per lease and chat, the
  newest, says the same with far fewer requests.
- **`events/stream`.** The chat's own stream is how to follow it live; the profile's streaming delivery would hold a
  connection for every integrator to say less.
