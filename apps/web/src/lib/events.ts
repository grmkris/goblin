// What a connection's events are called and how they group (ADR 0041, ADR 0068): the event's own title when the server
// gives one (a claim, shown as text), else words made from its name; grouped by the service a gateway names it by. Also
// the filters a routine keeps, in words.
import type { EventStream, ServerView } from '@goblin/contracts'
import { Predicate } from 'effect'

/** The words of a name's part: `message_received` and `messageReceived` both read "message received". */
const wordsOf = (part: string): string =>
  part
    .replaceAll(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replaceAll(/[-_]+/gu, ' ')
    .toLowerCase()

/**
 * An event's name in words: `message.received` reads "Message received". Through a gateway an event is named
 * `<service>.<event>` (`mygram.message.received`), so a name of three parts or more drops its service.
 */
export function eventWords(name: string): string {
  const parts = name.split('.').filter((part) => part !== '')
  const shown = parts.length > 2 ? parts.slice(1) : parts
  const words = shown.map(wordsOf).join(' ').trim()
  return words === '' ? name : `${words.charAt(0).toUpperCase()}${words.slice(1)}`
}

/** What an event is called: the server's title for it, else its name in words. */
export const eventTitle = (stream: Pick<EventStream, 'name' | 'title'>): string =>
  stream.title ?? eventWords(stream.name)

/**
 * The group an event belongs to: the service a gateway names it by (`<service>.<event>`, the part before the first dot
 * of a name of three parts or more), else the connection, whose streams are then listed flat.
 */
export function eventGroup(stream: Pick<EventStream, 'name'>, server: Pick<ServerView, 'label'>): string {
  const parts = stream.name.split('.')
  return parts.length > 2 && parts[0] !== undefined && parts[0] !== '' ? parts[0] : server.label
}

/** A connection's streams by group, in the order the server lists them. */
export function eventGroups<Stream extends Pick<EventStream, 'name'>>(
  streams: readonly Stream[],
  server: Pick<ServerView, 'label'>,
): readonly { readonly group: string; readonly streams: readonly Stream[] }[] {
  const groups = new Map<string, Stream[]>()
  for (const stream of streams) {
    const group = eventGroup(stream, server)
    groups.set(group, [...(groups.get(group) ?? []), stream])
  }
  return [...groups].map(([group, members]) => ({ group, streams: members }))
}

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
