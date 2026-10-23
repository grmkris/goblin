import { CONVERSATION_UPDATED, ConversationSelector, type PublishedEvents } from '@goblin/contracts'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InvalidInput, NotFound } from '../http/errors.ts'

// `conversation.updated` (ADR 0112): its descriptor, its selector, the journal's cursors and how often a chat's wake goes
// out. Pure. What a wake says is `payload.ts`'s.

/** The descriptor `events/list` answers: the profile's standard fields only. */
export const DESCRIPTOR: PublishedEvents['events'][number] = {
  name: CONVERSATION_UPDATED,
  title: 'Conversation updated',
  description:
    'A chat changed: a message or answer was committed, its work started or ended, or what waits for a person changed. A thin wake: read the chat with entries?after= from your cursor. At most one a second per chat, and always one when its work ends or its attention changes. A credential sees only the chats of the Topics its grant reaches; leave the arguments out for every chat in reach, or name one Topic or one chat.',
  inputSchema: {
    type: 'object',
    properties: {
      topic: { type: 'string', pattern: '^\\d{1,12}$', description: "Only this Topic's chats: its id." },
      chat: { type: 'string', description: 'Only this chat: its id.' },
    },
    additionalProperties: false,
  },
  payloadSchema: {
    type: 'object',
    properties: {
      chat: { type: 'string', description: 'The chat that changed.' },
      topic: { type: ['string', 'null'], description: "Its Topic's id; null in Personal." },
      entry: {
        type: 'integer',
        minimum: 0,
        description: 'Its newest committed entry: read entries?after= past yours.',
      },
      activity: {
        enum: ['working', 'idle'],
        description: 'Whether it, a Persona answering in it or a subagent works.',
      },
      attention: { type: 'integer', minimum: 0, description: 'How many items in it wait for a person.' },
    },
    required: ['chat', 'topic', 'entry', 'activity', 'attention'],
    additionalProperties: false,
  },
  delivery: ['poll', 'webhook'],
}

/** The event a request names: the one goblin publishes, else `NotFound` `event`. */
export const requireEvent = (name: string): void => {
  if (name !== CONVERSATION_UPDATED) throw new NotFound({ what: 'event' })
}

const decodeSelector = Schema.decodeUnknownOption(ConversationSelector)

/** A request's selector arguments: none, one Topic or one chat, nothing else (`InvalidInput` `event_arguments`). */
export function selectorOf(args: Readonly<Record<string, unknown>> | undefined): ConversationSelector {
  const decoded = decodeSelector(args ?? {}, { onExcessProperty: 'error' })
  if (Option.isNone(decoded)) throw new InvalidInput({ reason: 'event_arguments' })
  const { topic, chat } = decoded.value
  if (topic !== undefined && chat !== undefined) throw new InvalidInput({ reason: 'event_arguments' })
  return { ...(topic === undefined ? {} : { topic }), ...(chat === undefined ? {} : { chat }) }
}

/** A journal position as a cursor: 16 digits, so cursors compare as their positions do. */
export const cursorOf = (seq: number): string => String(seq).padStart(16, '0')

/** The position a cursor names; one past `head` is `InvalidInput` `event_cursor`. */
export const positionOf = (cursor: string, head: number): number => {
  const seq = Number(cursor)
  if (!/^\d{16}$/u.test(cursor) || !Number.isSafeInteger(seq) || seq > head)
    throw new InvalidInput({ reason: 'event_cursor' })
  return seq
}

/** A chat's wake waits this long for more changes, and goes out at most once in `EVERY_MS`. */
export const FIRST_MS = 250
export const EVERY_MS = 1000

/** When a chat that changed at `now`, and last sent at `sentAt`, is looked at. */
export const dueAt = (now: number, sentAt: number): number => Math.max(now + FIRST_MS, sentAt + EVERY_MS)
