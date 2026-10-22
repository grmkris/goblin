// What a connection's events are called (ADR 0041, ADR 0068): the event's own title when the server gives one (a claim,
// shown as text), else words made from its whole name; nothing is read from how a server shapes its names. Also the
// filters a routine keeps, in words.
import type { EventStream } from '@goblin/contracts'
import { Predicate } from 'effect'

/** The words of a name's part: `message_received` and `messageReceived` both read "message received". */
const wordsOf = (part: string): string =>
  part
    .replaceAll(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replaceAll(/[-_]+/gu, ' ')
    .toLowerCase()

/**
 * An event's name in words, every part of it: `post.created` reads "Post created", and `notes.post.created` "Notes post
 * created", since no part is read as a service.
 */
export function eventWords(name: string): string {
  const parts = name.split('.').filter((part) => part !== '')
  const words = parts.map(wordsOf).join(' ').trim()
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** What an event is called: the server's title for it, else its name in words. */
export const eventTitle = (stream: Pick<EventStream, 'name' | 'title'>): string =>
  stream.title ?? eventWords(stream.name)

/** One filter's value in words: text as it is, yes or no, a list joined, anything else as JSON. */
function valueWords(value: unknown): string {
  if (Predicate.isString(value)) return value
  if (Predicate.isBoolean(value)) return value ? 'yes' : 'no'
  if (Predicate.isNumber(value)) return value.toLocaleString()
  if (value === null) return 'none'
  if (Array.isArray(value) && value.every(Predicate.isString)) return value.join(', ')
  return JSON.stringify(value)
}

/** `value`'s fields when it is a plain object, else none. */
const fieldsOf = (value: unknown): { readonly [key: PropertyKey]: unknown } =>
  Predicate.isReadonlyObject(value) && !Array.isArray(value) ? value : {}

/** A property's title in `schema` (an event's input schema), else its name. */
function filterTitle(schema: unknown, name: string): string {
  const title = fieldsOf(fieldsOf(fieldsOf(schema)['properties'])[name])['title']
  return Predicate.isString(title) && title.trim() !== '' ? title : name
}

/** Which events a routine takes, in words: "Every one", or each filter's title and value. */
export function filtersInWords(filters: Readonly<Record<string, unknown>>, schema?: unknown): string {
  const entries = Object.entries(filters)
  if (entries.length === 0) return 'Every one'
  return entries.map(([name, value]) => `${filterTitle(schema, name)}: ${valueWords(value)}`).join('; ')
}
