import * as Schema from 'effect/Schema'

/** The draft Events extension (SEP-3415) as a server may declare it, beside the top-level `capabilities.events`. */
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events'

/** Draft MCP Triggers & Events profile selected by goblin. */
const EventName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
/**
 * How a server says it can deliver an event. Modes goblin does not know (a newer draft's `push`) are kept as they came
 * and ignored: goblin subscribes only to a stream that offers both poll and webhook.
 */
const DeliveryMode = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64))

/**
 * One event a server offers, by its standard fields only (ADR 0068): goblin reads no `_meta` of it. `title` is read
 * leniently (`eventWords`): whatever it holds, a malformed one never fails the list.
 */
export const EventDescriptor = Schema.Struct({
  name: EventName,
  title: Schema.optional(Schema.Unknown),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.Record(Schema.String, Schema.Unknown),
  payloadSchema: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  delivery: Schema.Array(DeliveryMode),
})
export type EventDescriptor = typeof EventDescriptor.Type

/** How long an event's title and description may be; the rest is cut. */
const TITLE = 120
const DESCRIPTION = 500

/** One line of the server's text, controls and runs of space folded, cut to `max`; none when it is not text or empty. */
const line = (value: unknown, max: number): string | undefined => {
  if (typeof value !== 'string') return undefined
  const folded = value.replaceAll(/[\s\p{Cc}]+/gu, ' ').trim()
  return folded === '' ? undefined : folded.slice(0, max)
}

/**
 * An event's own words as the owner reads them (ADR 0068): its `title` on one bounded line, when it is text, and its
 * `description`, cut. Claims for the owner's eyes; nothing is picked, granted or confirmed by them.
 */
export function eventWords(descriptor: EventDescriptor): { readonly title?: string; readonly description?: string } {
  const title = line(descriptor.title, TITLE)
  const { description } = descriptor
  return {
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description: description.slice(0, DESCRIPTION) }),
  }
}
export const EventsListResult = Schema.Struct({
  events: Schema.Array(EventDescriptor),
  nextCursor: Schema.optional(Schema.String),
})
export const EventOccurrence = Schema.Struct({
  eventId: Schema.String,
  name: EventName,
  timestamp: Schema.String,
  data: Schema.Unknown,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
})
export const EventControl = Schema.Union([
  Schema.Struct({ type: Schema.Literal('verification'), challenge: Schema.String }),
  Schema.Struct({ type: Schema.Literal('gap'), cursor: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('terminated'),
    error: Schema.optional(Schema.Struct({ code: Schema.Number, message: Schema.optional(Schema.String) })),
  }),
])
export const EventEnvelope = Schema.Union([EventOccurrence, EventControl])
export type EventEnvelope = typeof EventEnvelope.Type
export const EventsPollResult = Schema.Struct({
  events: Schema.Array(EventOccurrence),
  cursor: Schema.String,
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.optional(Schema.Number),
})
export type EventsPollResult = typeof EventsPollResult.Type
export const EventsSubscribeResult = Schema.Struct({
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.optional(Schema.NullOr(Schema.String)),
  truncated: Schema.optional(Schema.Boolean),
  deliveryStatus: Schema.optional(
    Schema.Struct({ active: Schema.Boolean, lastError: Schema.optional(Schema.NullOr(Schema.String)) }),
  ),
})
export type EventsSubscribeResult = typeof EventsSubscribeResult.Type
export const EventsUnsubscribeResult = Schema.Struct({})
