# MCP Events and Telegram

## MCP Events and Telegram

The owner selects one Telegram connection with its **Telegram** switch (ADRs 0011, 0055). Its authenticated discovery
must advertise Events (top-level `capabilities.events` or the `io.modelcontextprotocol/events` extension, ADR 0041):
the action grants mygram's inbox, send, question, chat-list and topic-list tools and the exact Events selectors
`message.received`, `question.answered` and, once the server offers it, `chat.changed`. A read of every chat
(`inbox_read { chat: 'all' }`) tells how far the grant reaches: when it answers, the selectors take
`{ chat: 'all' }`; when mygram refuses it (`access_insufficient`), they take `{}` (the DM) and the channel keeps the
widen URL the refusal carried (https only), which the mysi card shows as "Let goblin see your groups". Each name is
the connection's own spelling (ADR 0052), decided in one place
(`packages/contracts/src/service-names.ts`): mygram's (`inbox_read`, `message_send`, `message.received`) on a direct
connection, mysi's (`mygram_inbox_read`, `mygram_message_send`, `mygram.message.received`) through mysi, read from the
tools it lists and the Events its `events/list` offers. Consumers stay keyed by mygram's own event name, and every
later call (the pull, replies, notice copies, an app's `notify`) asks the live connection's tool list for the name.
Every finite webhook subscription must confirm before `app_telegram_channel` copies the checkpoint and fences older
cursor writes. The channel pulls immediately; a failure before that fence leaves the old channel checkpoint intact.
There is no other transport: the doorbell is gone with mygram's. A subscription the server ends (a widened or revoked
grant ends them all) is subscribed again by the next pull, with the reach the grant has then; one that cannot be
subscribed again marks the channel `ended` for the owner instead of looping.

`POST /hooks/mcp-events/<userId>/<connectionId>/<token>` verifies the token, bound to the user and the connection (each
connection has its own URL, ADR 0041), before lookup; ingress only matches that connection's subscriptions. Inside
the object, Standard Webhooks HMAC and five-minute freshness checks precede decoding. A pre-persisted subscribe intent accepts an early
signed verification challenge; remote ids are cross-checked when subscribe returns. Receipts and their frozen consumer
revisions commit in short transactions, with an already armed recovery schedule. The hook returns quickly and dispatch
runs asynchronously. Replay wakes unfinished handlers without duplicating their accepted intent. Before any of that,
the hook checks the agent may take events. The Worker hands the webhook to the agent's internal API (`mcpEvents`),
whose gate refuses an account without a plan (402); then ingress checks the plan the agent keeps and resident
authority: the owner's own refusal (revoked authority, a forbidden connection) answers 410 and the producer drops the
subscription, and any other failure of either check (a plan lookup that failed) is reported and answers 503, so the
producer retries. A subscription is dropped as invalid only when its server is gone (`NotFound`) or its grant or
endpoint changed. A maintenance sweep keeps the next alarm only for when something is due (`SqliteEventStore.nextDue`:
the earliest lease refresh or poll of a running subscription, or a delivery's retry); with nothing waiting, no alarm is
kept. A failed sweep is reported, then retried a minute later while something waits (`mcp/wake.ts`).

Every Telegram Event schedules the channel's pull alarm at once (`channelPull`); `chat.changed` also marks the server's
chat list to be read again (`sync_due`). The pull runs there, one at a time: it reads `chat_list` (and each forum's
`thread_list`) into the routes when due, then the inbox from its one cursor. Each entry names its `chat` (`dm` or an
opaque group handle) and forum topic; an entry whose chat is not a handle is skipped, and `out` or `archive` entries
are context only. Routing (ADR 0055, `channel/routes.ts`, `channel/channel.ts`) sends each owner message where its
chat's or topic's route says (`app_telegram_routes`): a turn in the route's Topic, through `ChatOperations.send` or,
for a Persona, `askPersonas`, authored `Telegram · <chat title>`; a passive `app.telegram` note (`listen`); nothing
(`ignore`); or held (`app_telegram_held`, twenty a chat) while a new chat waits for the owner. A chat or topic seen for
the first time is offered in the DM with `question_ask` buttons (`channel/offers.ts`, operation
`telegram-offer:<chat>:<thread>`) or routed by the default for new chats; an answer entry carrying an open offer's
question id sets the route and starts no turn. A route change goes through the channel between pulls, so what was held
is delivered in order. The id mapping is preserved: `tg:123` becomes `telegram-tg-123`. `app_channel_replies` keeps
where each answer goes (the goblin chat, the Telegram chat and thread, the answering Persona); goblin's answer, or the
Persona invocation's, goes back with `message_send { chat, threadId }`, escaped and chunked, and one that stopped on a
single-choice `ask_user` goes as `question_ask` buttons with short ids (`o0`, `o1`, …; Telegram carries
`<question>:<option>` in 64 bytes), the reply row keeping the question id and each button's label. An answer entry is
read by structure, never by its words (mygram's display text): its `questionId` is looked up with
`inbox_read { questionId }`, whose `choice` (or `answer`, for typed words) becomes the owner's reply as the kept label,
and an offer's question sets the route the same way, typed words naming a button being the fallback. A send refused
with `chat_paused` or `chat_left` marks the chat so and gives the answer up. Notices and an app's `notify` always go
to `chat: 'dm'`. Submission acceptance is distinct from external Telegram completion. Disabling cleans up Events
while authority is available, drops held messages and replies to send, keeps the routes, then tombstones locally;
finite remote leases expire if authorized cleanup cannot run.

The dispatcher also binds myskills' `skills.updated` and `skills.list_changed`. Turning a server's skills on subscribes
to them only where its Events offer them to this connection; a server without them, or one that refuses its Events
(Sidequest's setup-only connection), still turns on, and its listing refreshes on its `ttlMs`. Their payload is
untrusted metadata; the handler persists a dirty catalog generation and invalidates the cache before acknowledgement.
A listing can clear only the generation it observed, and retained activations stay pinned. Gap controls trigger reconciliation;
termination stops lease refresh and surfaces health. Mail and workspace changes have no installed consumer yet.

The owner browses a connection's event streams before granting any (`GET /api/mcp/:id/events`, `Events.catalog`):
the plan, resident authority and a signed-in connection are enough, no selector grant is made, and each stream says
whether goblin can subscribe to it (poll and webhook). Descriptions are the server's claims, cut to 500 characters.
A stream also carries what the server suggests for it, read leniently field by field from the descriptor's `title`
and `_meta["lol.mysi/suggest"]` (`eventSuggestion`, `mcp/events/protocol.ts`; a malformed one never fails the list):
`title`, `summary`, `group`, `recommended`, `tellMe` and `rate` (`often`, `daily`, `rare`). They are claims that only
pre-select in the picker; nothing is granted or confirmed by them. Through mysi an event is named
`<service>.<event>`, as subscribed and as delivered, so the name checks at ingress and dispatch are unchanged. A
subscription the Telegram channel consumes is marked `telegram: true` in the connection's Events health.

A connection that sends events **offers** them (ADR 0041): `ServerView.events` is `open` until the owner sets up a
routine on it (`done`, recorded when an event routine on it is confirmed) or dismisses it
(`POST /api/mcp/:id/events/dismiss`); `app_mcp_event_offers` (`mcp/events/offers.ts`) keeps only those answers, and
a dismissal never undoes `done`. The connection's card shows an **Events** section (`components/connection-events.tsx`):
the offer while open, what is set up ("`<title>` → #Topic", "→ goblin, in #Topic" or "→ @Persona", with Pause or
Resume and Edit, which opens the routine editor and then its review), the **picker** for the rest
(`components/event-picker.tsx`, `lib/event-setup.ts`, `lib/events.ts`), and the subscriptions' health. The picker
lists the streams by group (the server's, else the service before the first dot of a three-part name, else the
connection), each by title (else its name in words, `message.received` → "Message received") with its summary and a
quiet rate. While the offer is open, a recommended stream the server says to tell the owner about is picked, to Tell me
in Personal; one it recommends without `tellMe` is handed to goblin there on Pro and left unpicked without it.
Each picked stream has one select for where it goes: Tell me in a Topic, or (Pro) goblin acting on it in a Topic or a
Persona acting on it (answering in Personal); without Pro those show disabled, with Get Pro
(`/subscribe?return=<this page>`). A hand-over adds a line saying who answers where; a Tell me pick adds none, since its
notice is the title and line its row already shows. **Advanced**
(folded) holds each stream's filters (a nullable or optional string is a plain optional field, with the server's
default as its hint), an instruction for a hand-over (else goblin's), Tell me and Telegram. One action, **Set up N
events**, proposes and then confirms each stream's own routine in turn (`setUpEventsMutation`), so each confirmation
grants exactly its selector; a filter the server requires and that is empty stops it and opens Advanced. A stream the
Telegram channel already takes says "Already arrives through Telegram" instead of being offered. A quiet line states the
limits: one run a minute, 20 notices an hour then a digest, events from before setup dropped. Activity lists each open
offer ("Set up events for `<label>`", linking to its card, with Not now); it is not counted in the rail's badge.

The client refreshes before the producer's ISO `refreshBefore` and polls on gaps or webhook outages. Bounds are
64 live subscriptions (maintenance reconciles every one; a tombstone is pruned once no delivery or binding
refers to it and its lease lapsed or its cleanup succeeded), 100 events per page, 256 KiB bodies, 15-second remote
requests (`EVENT_LIMITS.timeoutMs`) and 10,000 pending rows / 32 MiB.
Recovery sweeps process at most 256 deliveries and retain completed receipts for eight days; unfinished receipts
are never pruned. Workers cannot pin resolved DNS IPs; trusted DNS is the documented v1 deviation (ADR 0011).
