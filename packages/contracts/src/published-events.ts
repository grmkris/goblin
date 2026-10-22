import * as Schema from 'effect/Schema'
import { ChatId } from './ids.ts'

// What goblin publishes as an MCP Events producer (ADR 0112, docs/architecture/published-events.md): one event,
// `conversation.updated`, and the wire shapes of `events/list`, `subscribe`, `unsubscribe` and `poll`, served over
// `/api/events/…` and `/mcp` alike. The shapes follow the draft Events profile goblin consumes (ADR 0011); a field
// goblin's own consumer reads is never optional here.

/** The one event goblin publishes: a chat changed. */
export const CONVERSATION_UPDATED = 'conversation.updated'

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/**
 * `conversation.updated`'s data: a thin wake, never content. `chat` changed: `entry` is its newest committed entry (the
 * cursor its `entries?after=` reads past), `activity` whether it, a Persona answering in it or one of its subagents is
 * working, and `attention` how many items in it wait for a person (its stream's `/attention`). `topic` is its Topic's
 * id, none in Personal.
 */
export const ConversationUpdated = Schema.Struct({
  chat: ChatId,
  topic: Schema.NullOr(Schema.String),
  entry: Count,
  activity: Schema.Literals(['working', 'idle']),
  attention: Count,
})
export type ConversationUpdated = typeof ConversationUpdated.Type

/** A Topic as a selector names it: its id, as a string. */
const TopicRef = Schema.String.check(Schema.isPattern(/^\d{1,12}$/u))

/** `conversation.updated`'s selector arguments: every chat in reach, one Topic's, or one chat's. */
export const ConversationSelector = Schema.Struct({
  topic: Schema.optional(TopicRef),
  chat: Schema.optional(ChatId),
})
export type ConversationSelector = typeof ConversationSelector.Type

/** A position in the published journal: 16 digits, as `cursor` comes back from a poll or a subscribe. */
export const EventCursor = Schema.String.check(Schema.isPattern(/^\d{16}$/u))

const EventName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128))
/** An event's arguments as a caller sends them: checked against the event's own selector by the agent. */
const EventArguments = Schema.Record(Schema.String, Schema.Unknown)
const Milliseconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** One event goblin offers, by the profile's standard fields. */
export const PublishedEventDescriptor = Schema.Struct({
  name: EventName,
  title: Schema.String,
  description: Schema.String,
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  payloadSchema: Schema.Record(Schema.String, Schema.Unknown),
  delivery: Schema.Array(Schema.Literals(['poll', 'webhook'])),
})

/** `events/list`. */
export const PublishedEvents = Schema.Struct({ events: Schema.Array(PublishedEventDescriptor) })
export type PublishedEvents = typeof PublishedEvents.Type

/** One occurrence as a poll answers it and a webhook carries it. */
export const PublishedOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: EventName,
  timestamp: Schema.String,
  data: ConversationUpdated,
  cursor: EventCursor,
})
export type PublishedOccurrence = typeof PublishedOccurrence.Type

/** A webhook endpoint as subscribe takes it: an https URL and the Standard Webhooks secret (`whsec_…`) to sign with. */
const WebhookDelivery = Schema.Struct({
  mode: Schema.Literal('webhook'),
  url: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  secret: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
})

/**
 * `events/subscribe`: a lease of `ttlMs` (at most a day, an hour when absent) on the event's webhook deliveries to
 * `delivery.url`. Subscribing again with the same name, arguments and URL renews it.
 */
export const SubscribeEvents = Schema.Struct({
  name: EventName,
  arguments: Schema.optional(EventArguments),
  delivery: WebhookDelivery,
  cursor: Schema.optional(Schema.NullOr(EventCursor)),
  ttlMs: Schema.optional(Schema.NullOr(Milliseconds)),
  maxAgeMs: Schema.optional(Milliseconds),
})
export type SubscribeEvents = typeof SubscribeEvents.Type

/**
 * A lease: its id, when to subscribe again (`refreshBefore`, ISO), the journal's position now (`cursor`), whether the
 * cursor sent is past what is kept (`truncated`), and whether deliveries reach the URL (`deliveryStatus`).
 */
export const EventsSubscribed = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: EventCursor,
  truncated: Schema.Boolean,
  deliveryStatus: Schema.Struct({ active: Schema.Boolean, lastError: Schema.NullOr(Schema.String) }),
})
export type EventsSubscribed = typeof EventsSubscribed.Type

/** `events/unsubscribe`: the lease of exactly this name, these arguments and this URL. */
export const UnsubscribeEvents = Schema.Struct({
  name: EventName,
  arguments: Schema.optional(EventArguments),
  delivery: Schema.Struct({ mode: Schema.Literal('webhook'), url: WebhookDelivery.fields.url }),
})
export type UnsubscribeEvents = typeof UnsubscribeEvents.Type

/** `events/poll`: the occurrences after `cursor` (none: from now on), at most `maxEvents` (100) of them. */
export const PollEvents = Schema.Struct({
  name: EventName,
  arguments: Schema.optional(EventArguments),
  cursor: Schema.optional(Schema.NullOr(EventCursor)),
  maxEvents: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  maxAgeMs: Schema.optional(Milliseconds),
})
export type PollEvents = typeof PollEvents.Type

/**
 * A page of occurrences, oldest first, and the cursor to poll from next; `truncated` when some after the cursor sent are
 * no longer kept, `hasMore` when another page waits, `nextPollMs` how long to wait before an empty poll again.
 */
export const EventsPolled = Schema.Struct({
  events: Schema.Array(PublishedOccurrence),
  cursor: EventCursor,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Milliseconds,
})
export type EventsPolled = typeof EventsPolled.Type
