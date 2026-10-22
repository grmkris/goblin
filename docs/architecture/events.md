# MCP Events

goblin as an Events client: what it consumes from the servers it connects. What it publishes for others, the
`conversation.updated` wake, is [published events](published-events.md) (ADR 0112).

Any connected server that advertises Events can offer streams for Sources, routines and skill invalidation.
Selectors are granted explicitly; a server name or a subscription already in use grants nothing. Sources carry
messages and answers through owner-reviewed mappings ([sources.md](sources.md), ADRs 0066, 0069).

`POST /hooks/mcp-events/<userId>/<connectionId>/<token>` verifies the token, bound to the user and the connection (each
connection has its own URL, ADR 0041), before lookup; ingress only matches that connection's subscriptions. Inside
the object, Standard Webhooks HMAC and five-minute freshness checks precede decoding. A pre-persisted subscribe intent accepts an early
signed verification challenge; remote ids are cross-checked when subscribe returns. Receipts and their frozen consumer
revisions commit in short transactions, with an already armed recovery schedule. The hook returns quickly and dispatch
runs asynchronously. Replay wakes unfinished handlers without duplicating their accepted intent. Before any of that,
the hook checks the agent may take events. The Worker hands the webhook to the agent's internal API (`mcpEvents`);
then ingress checks resident authority: the owner's own refusal (revoked authority, a forbidden connection) answers 410
and the producer drops the subscription, and any other failure of the check is reported and answers 503, so the
producer retries. A subscription is dropped as invalid only when its server is gone (`NotFound`) or its grant or
endpoint changed. A maintenance sweep keeps the next alarm only for when something is due (`SqliteEventStore.nextDue`:
the earliest lease refresh or poll of a running subscription, or a delivery's retry); with nothing waiting, no alarm is
kept. A failed sweep is reported, then retried a minute later while something waits (`mcp/events/wake.ts`).

Sources ([sources.md](sources.md), ADR 0066) are the Events consumers any connection can have: each confirmed Source
subscribes its wake event under consumer `source:<id>` (handler `source-wake`, registered by `SourcesLive` before the
agent runs anything), reads the owner's messages from the event's data or by a tool from a cursor, and answers through
its reply tool; nothing in it names a server. Multiple consumers can share a connection and exact selector without
introducing service-specific ownership.

Consumer revisions advance monotonically in the store: an older discovery that finishes late cannot retire a newer
binding. The last consumer tombstones its lease before remote cleanup starts. Each replacement lease adds a fresh,
opaque `goblin_generation` query value to the connection's authenticated callback URL (ADR 0073). The value grants
nothing; the authenticated hook path and signed delivery checks stay required. Since producers address subscriptions
by selector and complete callback URL, late subscribe or unsubscribe requests for an old generation cannot remove or
replace its successor. Failed cleanup can lapse at the producer's finite TTL without blocking immediate rebind.
Lease generation checks also fence asynchronous subscribe, poll and verification responses at their durable write,
including after encryption or alarm waits. Retirement finishes queued deliveries, and dispatch rechecks after
decrypting and between handlers, so an old gap or termination cannot change the next lease. A terminated lease is only
replaced by an explicit subscribe, with a fresh generation. A renewal the producer answers with another subscription
id (a gateway that now reaches the app through another of the owner's accounts) is a lease goblin no longer holds at
that URL: it subscribes a fresh generation in its place, keeping the local id, consumers and cursor, then unsubscribes
the old generation by its exact name, arguments and URL, best effort (`subscribeEvents`, ADR 0096); a second change of
id in the same renewal is the producer's error. No transaction spans a remote wait.

The dispatcher also binds myskills' `skills.updated` and `skills.list_changed`. Turning a server's skills on subscribes
to them only where its Events offer them to this connection; a server without them, or one that refuses its Events
(Sidequest's setup-only connection), still turns on, and its listing refreshes on its `ttlMs`. Their payload is
untrusted metadata; the handler persists a dirty catalog generation and invalidates the cache before acknowledgement.
A listing can clear only the generation it observed, and retained activations stay pinned. Gap controls trigger reconciliation;
termination stops lease refresh and surfaces health. Mail and workspace changes have no installed consumer yet.

The owner browses a connection's event streams before granting any (`GET /api/mcp/:id/events`, `Events.catalog`):
resident authority and a signed-in connection are enough, no selector grant is made, and each stream says
whether goblin can subscribe to it (poll and webhook). goblin reads a descriptor's standard fields only (ADR 0068):
`name`, `title`, `description`, `inputSchema`, `payloadSchema` and `delivery`, never its `_meta` (`eventWords`,
`mcp/events/protocol.ts`). The title is folded to one line of at most 120 characters (one that is not text is left out,
and never fails the list) and the description cut to 500; both are the server's claims, for the owner's eyes. Its
`payloadSchema`, the shape the server says each event's data has, is passed on as it came (here and in the agent's
`mcp_list` with `events: true`). Nothing a server says picks, grants or confirms an event. Through mysi an event is named
`<service>.<event>`, as subscribed and as delivered, so the name checks at ingress and dispatch are unchanged. Subscription health describes the lease, grant and last receipt without a service-specific flag.

A connection that sends events **offers** them (ADR 0041): `ServerView.events` is `open` until the owner sets up a
routine on it (`done`, recorded when an event routine on it is confirmed) or dismisses it
(`POST /api/mcp/:id/events/dismiss`); `app_mcp_event_offers` (`mcp/events/offers.ts`) keeps only those answers, and
a dismissal never undoes `done`. The connection's card shows an **Events** section (`components/connection-events.tsx`):
the offer while open, what is set up ("`<title>` → #Topic", "→ goblin, in #Topic" or "→ @Persona", with Pause or
Resume and Edit, which opens the routine editor and then its review), the **picker** for the rest
(`components/event-picker.tsx`, `lib/event-setup.ts`, `lib/events.ts`), and the subscriptions' health. An empty catalog
or streams without supported subscriptions show an explanation and Refresh event streams; read failures show their
reference and Try again. Settings → Notify me via configures outgoing delivery and links back to Connections for
incoming events. The picker
lists the streams in the server's order, each by its title (else every part of its name in words, `post.created` →
"Post created"; no part is read as a gateway's service, ADR 0096) with its description. Nothing is picked until the owner picks it; a picked stream goes to Tell me
in Personal until they choose otherwise. Each picked stream has one select for where it goes: Tell me in a Topic, or goblin acting on it in a Topic or a Persona acting on it (answering in Personal). A
hand-over adds a line saying who answers where; a Tell me pick adds none, since its
notice is the title and line its row already shows. **Advanced**
(folded) holds each stream's filters (a nullable or optional string is a plain optional field, with the server's
default as its hint), an instruction for a hand-over (else goblin's), Tell me and its optional Notify me via copy. One action, **Set up N
events**, proposes and then confirms each stream's own routine in turn (`setUpEventsMutation`), so each confirmation
grants exactly its selector; a filter the server requires and that is empty stops it and opens Advanced. Every stream remains selectable until a routine is configured for it; another consumer is not a service-specific
exclusion. A quiet line states the
limits: one run a minute, 20 notices an hour then a digest, events from before setup dropped. Activity lists each open
offer ("Set up events for `<label>`", linking to its card, with Not now); it is not counted in Activity's badge.

The client refreshes before the producer's ISO `refreshBefore` and polls on gaps or webhook outages. Bounds are
64 live subscriptions (maintenance reconciles every one; a tombstone is pruned once no delivery or binding
refers to it and its lease lapsed or its cleanup succeeded), 100 events per page, 256 KiB bodies, 15-second remote
requests (`EVENT_LIMITS.timeoutMs`) and 10,000 pending rows / 32 MiB.
Recovery sweeps process at most 256 deliveries and retain completed receipts for eight days; unfinished receipts
are never pruned. Workers cannot pin resolved DNS IPs; trusted DNS is the documented v1 deviation (ADR 0011).
