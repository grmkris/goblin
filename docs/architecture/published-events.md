# Published events

goblin publishes MCP Events ([ADR 0112](../adr/0112-goblin-publishes-mcp-events.md)): the profile an integrator's
server implements against to hear, within about a second, that a chat it follows changed, instead of polling every
chat. It is the draft Triggers & Events profile goblin also consumes ([events.md](events.md), ADR 0011), served by each
workspace's agent (`apps/runtime/src/publish/`, the owner API's `events` group in `packages/contracts/src/api/events.ts`
and its shapes in `packages/contracts/src/published-events.ts`).

## Who can use it

Any caller holding the `conversations` scope: a server's API key (`Authorization: Bearer gbk_…`), an OAuth client of
the owner with `goblin:conversations`, or a member's own session. A key sees only its own rooms' chats (its Topics,
their threads, ADR 0108); a client or a member sees every chat of the workspace. Requests count toward the caller's
600 a minute, and never grant resident authority.

## The event

One event, `conversation.updated`, a thin wake that never carries content:

```json
{ "chat": "42", "topic": "7", "entry": 1093, "activity": "working", "attention": 0 }
```

| Field | Meaning |
| --- | --- |
| `chat` | The chat that changed: a Topic's Conversation or a thread. An opaque id. |
| `topic` | Its Topic's id, as a string; `null` in Personal. |
| `entry` | Its newest committed entry: read `GET /api/conversations/:chat/entries?after=<yours>` past your cursor. |
| `activity` | `working` while it, a Persona answering in it or one of its subagents is at work; else `idle`. |
| `attention` | How many items in it wait for a person (questions, held calls): the length of its stream's `/attention`. |

A Persona's fork or a subagent is never `chat`: their work counts for the chat they work for. A chat's wake goes out
250 ms after it changed, then at most once a second, and only when one of these fields changed: a turn ending
(`activity` turns `idle`) or attention changing always sends one; a streamed token never does.

Selector arguments: none for every chat in reach, `{ "topic": "<id>" }` for one Topic's chats, or `{ "chat": "<id>" }`
for one chat. Anything else is invalid; a Topic or chat out of reach is not found.

## REST, for a server's key

Every path is under the workspace's API (`https://<app>/api/…` with a key; a member's browser uses `/w/<slug>/api/…`).
Bodies are JSON.

| Method | Path | Body | Answer |
| --- | --- | --- | --- |
| `GET` | `/api/events` | | `{ events: [descriptor] }` |
| `POST` | `/api/events/subscribe` | `{ name, arguments?, delivery: { mode: "webhook", url, secret }, cursor?, ttlMs? }` | the lease |
| `POST` | `/api/events/unsubscribe` | `{ name, arguments?, delivery: { mode: "webhook", url } }` | `{}` |
| `POST` | `/api/events/poll` | `{ name, arguments?, cursor, maxEvents?, maxAgeMs? }` | a page |

Subscribe answers `{ id, refreshBefore, cursor, truncated, deliveryStatus: { active, lastError } }`: the lease's id
(the `X-MCP-Subscription-Id` every delivery carries), when to subscribe again (ISO), the journal's position now, whether
the cursor you sent is older than the journal keeps, and whether deliveries reach your URL.

A poll answers `{ events: [occurrence], cursor, truncated, hasMore, nextPollMs }`. An occurrence is
`{ eventId, name, timestamp, data, cursor }`. Cursors are 16 digits; poll again from the `cursor` answered. `cursor:
null` answers no events and where the journal is now; `truncated` says some occurrences after your cursor were pruned
(the journal keeps seven days); `hasMore` that another page waits; at most 100 events a page (`maxEvents`).

## Over /mcp

`/mcp` declares `capabilities.events` and the extension `io.modelcontextprotocol/events` to a caller holding
`conversations`, and serves `events/list`, `events/subscribe`, `events/unsubscribe` and `events/poll` with the same
parameters and answers, each calling its REST endpoint as the caller. `events/stream` answers -32014. An OAuth client
that reaches several workspaces names one inside `arguments` (`"workspace": "<id or slug>"`; in `params` for
`events/list`), as its tools take `workspace`. Errors use the profile's codes: -32602 invalid params (a refused URL,
secret, arguments or cursor), -32011 not found, -32012 forbidden, -32013 too many leases or too many requests, -32014
unsupported, -32015 the callback did not verify; `data` is goblin's error envelope.

## Leases

- **The URL** is https on a public host name, written exactly as a URL parser writes it, with no port, credentials,
  fragment, IP literal or local suffix (`.localhost`, `.local`, `.internal`, `.home.arpa`, `.invalid`, `.test`,
  `.example`). It is checked again before every delivery. Redirects are not followed.
- **The secret** is a Standard Webhooks secret you choose: `whsec_` and the base64 of 24 to 64 random bytes.
- **Verification.** Subscribing sends your URL a signed `{ "type": "verification", "challenge": "…" }` (its
  `webhook-id` is `msg_verification_<random>`); answer `200` with `{ "challenge": "…" }` within five seconds, or the
  subscribe fails (-32015, `Conflict` `event_callback` over REST). Renewing with the same secret sends none.
- **Length.** `ttlMs` asks for a lease: an hour unless you ask, at least five minutes, at most a day. Renew by
  subscribing again with the same name, arguments and URL before `refreshBefore`; a lease not renewed ends with a
  `terminated` control.
- **Identity.** A lease is its holder (your key, or your client for its person), its selector and its URL: subscribing
  again with all three finds the same lease (and may change its secret), unsubscribing with all three ends it.
- **Limits.** 32 leases per holder, 256 per workspace (-32013, `Conflict` `event_subscriptions`).

## Deliveries

Each delivery is a `POST` of the exact JSON body to your URL, signed with
[Standard Webhooks](https://www.standardwebhooks.com/) v1:

| Header | Value |
| --- | --- |
| `webhook-id` | the occurrence's `eventId`, or `msg_<type>_<random>` for a control |
| `webhook-timestamp` | Unix seconds when this attempt was sent (fresh on every retry) |
| `webhook-signature` | `v1,<base64 HMAC-SHA256(secret bytes, "<webhook-id>.<webhook-timestamp>.<body>")>` |
| `X-MCP-Subscription-Id` | the lease's id |
| `content-type` | `application/json` |

Verify the signature over the raw bytes and refuse a timestamp more than five minutes away; deduplicate on
`webhook-id`. Answer with any `2xx` within five seconds; your answer's body is read up to 256 KiB and ignored.

A lease is owed at most one waiting wake per chat: when a chat changes again before its wake reached you, the waiting
one is replaced by the newer, so you may see fewer wakes than changes, never a stale one last. A failed attempt
(no answer, a timeout, any other status) is tried again 15 s, 30 s, 60 s, 120 s later (±25%, at most five minutes);
a redirect, `410` or `413`, the fifth attempt or fifteen minutes gives up. Then every wake owed to the lease is
dropped and one control is sent instead:

- `{ "type": "gap", "cursor": "<16 digits>" }`: poll from `cursor` to catch up. The lease is failing (no new wakes)
  until a delivery reaches your URL again or you renew it.
- `{ "type": "terminated", "error": { "code", "message" } }`: the lease ended. `-32011` when it ran out unrenewed,
  `-32012` when its holder's access ended. Subscribe again to start a new one.

Delivery is at least once and in no promised order across chats. A wake says only that a chat changed: read it with
your own credential (`entries?after=`, or its stream).

## When access ends

Revoking or rotating a key, a change of its scopes that drops `conversations`, and revoking an OAuth client end every
lease they hold at once: each is sent `terminated` (`-32012`) before the access ends. A member removed from a workspace,
or a client whose reach no longer includes it, keeps its leases until they run out (a day at most); renewing is refused.

## Limits and assumptions

Bodies are at most 256 KiB, polls 100 events, requests five seconds. Workers cannot pin the callback's resolved address
between the check and the fetch: trusted DNS is the documented assumption, as for the consumer (ADR 0011). Verified in
unit tests and on local workerd, where goblin's own Events consumer (`mcp/events/client.ts`) subscribes to goblin with
a key (`test/integration/publish-case.ts`); a deployed check is separate.
