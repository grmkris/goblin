// A Source's messages coming in (ADR 0066), over its rows (sources/store.ts) and the agent's ports. Each message read
// from an event's data or a tool's result is keyed into a conversation (named by its title when the setup reads one); a
// conversation seen first takes the setup's `newKeys`, a Topic of its own included. The owner's own messages (those the
// confirmed speaks-for-me rule matches) go where that conversation's route says, with their attachments kept in the
// owner's files (ADR 0065): a turn in a Topic answered by goblin or a Persona, a note kept there, nothing, or held until
// the owner routes it. Everything else stays untrusted data: a notice to the owner, or nothing.
import {
  type SourceKeyPart,
  type SourceKeyValues,
  type SourceRoute,
  type SourceScalar,
  type SpeaksForMe,
  fillTemplate,
} from '@goblin/contracts'
import { RunAttribute } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import { type AppError, InvalidInput } from '../http/errors.ts'
import { reportAndRecover } from '../observability/report.ts'
import { routineSummary } from '../routines/summary.ts'
import { isRecord, sha256Hex } from '../runtime/digest.ts'
import { failureAttributes } from '../telemetry/attributes.ts'
import { deliverHeld } from './held.ts'
import { valueAt } from './pointer.ts'
import {
  type Held,
  type RouteBy,
  type RouteRow,
  addKey,
  checkpoint,
  heldOf,
  hold,
  knownKey,
  release,
  routeOf,
  routeRow,
  setRoute,
  sourceRow,
  takeDropped,
  trackReply,
  valuesOf,
} from './store.ts'
import { operationIdOf } from './text.ts'
import type { EngineContext, Loaded, SourcePorts } from './types.ts'

/** Pages read at most per pull of a tool read. */
const MAX_PAGES = 50
/** Pages read at most to find where a tool read starts when a Source is confirmed. */
const MAX_HISTORY_PAGES = 200
/** The longest an item id goes into an operation id as it is; a longer one goes as its digest. */
const ITEM_ID = 64
/** How long the owner reads of someone else's message in a notice. */
const NOTICE_BODY = 1200
/** How long a conversation's title may be, as a route shows it and a Topic is named. */
const TITLE = 80
/** What a turn says in place of the owner's words when their message brought only attachments. */
const ONLY_ATTACHMENTS = '(Sent without words; what it brought is below.)'

/** Whether `value` is a plain value a key part or a speaks-for-me rule compares. */
const isScalar = (value: unknown): value is SourceScalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

/** A plain value at `pointer`, `null` when there is none; none when it is a list or an object. */
const scalarAt = (item: unknown, pointer: string): SourceScalar | undefined => {
  const value = valueAt(item, pointer) ?? null
  return isScalar(value) ? value : undefined
}

/** Whether `item` matches: its value at `pointer` equals `equals`. */
const matches = (item: unknown, match: { readonly pointer: string; readonly equals: SourceScalar }) =>
  scalarAt(item, match.pointer) === match.equals

/** Whether the owner is the one speaking in `item`, by the rule they confirmed. */
const speaks = (item: unknown, rule: SpeaksForMe) => ('all' in rule ? true : matches(item, rule))

/** A message's conversation: its key (the JSON of its parts' values in order), its values by name, and its title. */
type Conversation = { readonly key: string; readonly values: SourceKeyValues; readonly title?: string | undefined }

/** The text at `pointer` as a conversation's title: one line, controls folded, at most 80 characters; none when empty. */
const titleAt = (item: unknown, pointer: string | undefined): string | undefined => {
  const value = pointer === undefined ? undefined : valueAt(item, pointer)
  if (typeof value !== 'string') return undefined
  const folded = value
    .replaceAll(/[\s\p{Cc}]+/gu, ' ')
    .trim()
    .slice(0, TITLE)
    .trim()
  return folded === '' ? undefined : folded
}

/**
 * `item`'s conversation by the setup's key, named by its `title` pointer; none when a part is a list or an object, or
 * the key is too long.
 */
function conversationOf(
  item: unknown,
  parts: readonly SourceKeyPart[],
  title: string | undefined,
): Conversation | undefined {
  const values: Record<string, SourceScalar> = {}
  const ordered: SourceScalar[] = []
  for (const part of parts) {
    const value = scalarAt(item, part.pointer)
    if (value === undefined) return undefined
    values[part.name] = value
    ordered.push(value)
  }
  const key = JSON.stringify(ordered)
  return key.length > 512 ? undefined : { key, values, title: titleAt(item, title) }
}

/** A conversation's values in words: "chat dm, thread 3", leaving out the parts it does not have. */
export const keyWords = (values: SourceKeyValues): string =>
  Object.entries(values)
    .filter(([, value]) => value !== null && value !== '')
    .map(([name, value]) => `${name} ${String(value)}`)
    .join(', ')

/** A conversation in words: its title when the server gave one, else its values. */
const conversationWords = (conversation: {
  readonly values: SourceKeyValues
  readonly title?: string | null | undefined
}) => conversation.title ?? keyWords(conversation.values)

/** The operation of the turn a message makes: one per Source and message, a long message id as its digest. */
const turnOperation = (sourceId: string, itemId: string) =>
  Effect.map(itemId.length <= ITEM_ID ? Effect.succeed(itemId) : Effect.promise(() => sha256Hex(itemId)), (id) =>
    operationIdOf('source', `${sourceId}-${id.slice(0, ITEM_ID)}`),
  )

/** The Topic a route puts notes and notices in; none for one that goes nowhere yet. */
export const topicOf = (route: SourceRoute): number | undefined => ('topic' in route ? route.topic : undefined)

/** Someone else's words, scrubbed of credentials and controls and cut to a notice's body. */
const noticeBody = (text: string) => routineSummary(text.replaceAll(/[\s\p{Cc}]+/gu, ' ').trim()).slice(0, NOTICE_BODY)

/** A template filled as an argument record; anything else (a template is always one) is no arguments. */
export const asArguments = (value: unknown): Record<string, unknown> => (isRecord(value) ? value : {})

/** One owner message to where its conversation's route says; `note` goes before its words. */
const send = (
  context: EngineContext,
  source: Loaded,
  route: RouteRow,
  { held, note }: { readonly held: Held; readonly note: string },
  ports: SourcePorts,
) =>
  Effect.gen(function* () {
    const { db, record } = context
    const target = routeOf(route)
    const now = yield* Clock.currentTimeMillis
    if (target.to === 'held') return yield* Effect.sync(() => hold(db, held, Math.floor(now / 1000)))
    if (target.to === 'ignore') return
    const operationId = yield* turnOperation(source.row.id, held.itemId)
    const label = yield* ports.label(source.row.connectionId)
    const where = conversationWords({ values: valuesOf(route), title: route.title })
    const words = held.text.trim() === '' ? ONLY_ATTACHMENTS : held.text
    const turn = {
      topic: target.topic,
      operationId,
      author: where === '' ? label : `${label} · ${where}`,
      text: `${note}${words}`,
      ...(held.kept === undefined ? {} : { kept: held.kept }),
    }
    if (target.to === 'listen') return yield* ports.keep(turn)
    const attributes = { [RunAttribute.sourceMessage]: operationId }
    const failed = (error: AppError) =>
      record('source.received', { operationId, chatId: undefined }, now, {
        ...attributes,
        ...failureAttributes(error),
      })
    const persona = target.to === 'persona' ? target.persona : undefined
    const submitted = yield* ports.submit(turn, persona).pipe(Effect.tapError(failed))
    yield* record('source.received', { operationId, chatId: submitted.chatId }, now, attributes)
    if (source.setup.reply === undefined) return
    const reply = {
      operationId,
      sourceId: source.row.id,
      key: route.key,
      chatId: submitted.chatId,
      personaId: submitted.persona ?? null,
    }
    if (trackReply(db, reply, Math.floor(now / 1000))) context.wake(5)
  })

/** What `key` held while it waited, delivered in order once it has a route; how many were dropped goes first. */
const releaseHeld = (context: EngineContext, source: Loaded, key: string, ports: SourcePorts) =>
  Effect.gen(function* () {
    const { db } = context
    const route = routeRow(db, source.row.id, key)
    if (route === undefined || route.route === 'held') return
    const ready = heldOf(db, source.row.id, key)
    if (ready.length === 0) return
    yield* deliverHeld(
      ready,
      takeDropped(db, source.row.id, key),
      'conversation',
      (held, note) => send(context, source, route, { held, note }, ports),
      (held) => release(db, held.sourceId, held.itemId),
    )
  })

/** Someone else's message as a notice to the owner, where its conversation's route puts notes. */
const noticeOf = (source: Loaded, conversation: Conversation, target: SourceRoute, itemId: string, text: string) =>
  Effect.gen(function* () {
    const { row } = source
    const operationId = yield* turnOperation(row.id, itemId)
    const where = conversationWords(conversation)
    const body = noticeBody(text)
    return (label: string) => ({
      id: `notice:${operationId}`,
      sourceId: row.id,
      connectionId: row.connectionId,
      label,
      topic: topicOf(target),
      title: where === '' ? `Someone else wrote in ${label}` : `Someone else wrote in ${label}, ${where}`,
      ...(body === '' ? {} : { body }),
    })
  })

/** The operation of the Topic a conversation's `topic-per-key` makes: one per Source and conversation key. */
const topicOperation = (sourceId: string, key: string) =>
  Effect.map(
    Effect.promise(() => sha256Hex(key)),
    (digest) => `source-topic:${sourceId}:${digest.slice(0, 32)}`,
  )

/**
 * The route a conversation seen for the first time takes: the setup's `newKeys`, or with `topic-per-key` a new Topic of
 * its own, named after its title (else its values, else the connection), answered by goblin. A Topic that cannot be
 * made leaves it held for the owner, reported.
 */
const firstRoute = (source: Loaded, conversation: Conversation, ports: SourcePorts) =>
  Effect.gen(function* () {
    const { newKeys } = source.setup
    if (newKeys.to !== 'topic-per-key') return newKeys
    const label = yield* ports.label(source.row.connectionId)
    const operationId = yield* topicOperation(source.row.id, conversation.key)
    return yield* ports.topic(conversationWords(conversation), label, operationId).pipe(
      Effect.map((topic): SourceRoute => ({ to: 'topic', topic })),
      reportAndRecover('sources.topic', { to: 'held' } satisfies SourceRoute),
    )
  })

/** A conversation's route: the one it has (its title kept up to date), or the one it takes when goblin first sees it. */
const routeFor = (context: EngineContext, source: Loaded, conversation: Conversation, ports: SourcePorts) =>
  Effect.gen(function* () {
    const seen = { sourceId: source.row.id, ...conversation }
    const known = knownKey(context.db, seen)
    if (known !== undefined) return known
    const first = yield* firstRoute(source, conversation, ports)
    return addKey(context.db, seen, first, Math.floor((yield* Clock.currentTimeMillis) / 1000))
  })

/** The attachments at the setup's `read.attachments` pointer of `item`: a list of MCP content blocks, else none. */
const attachmentsOf = (item: unknown, pointer: string | undefined): readonly unknown[] => {
  const found = pointer === undefined ? undefined : valueAt(item, pointer)
  return Array.isArray(found) ? found : []
}

/**
 * One message: incoming (by `read.direction`), in a conversation goblin can key, with words or attachments. A
 * conversation seen for the first time takes the setup's `newKeys`. The owner's own message goes where its route says,
 * its attachments kept in the owner's files first (held or not, as a link may not last); anyone else's is a notice to
 * the owner, or nothing, and what it brought is never fetched.
 */
const take = (context: EngineContext, source: Loaded, item: unknown, itemId: string, ports: SourcePorts) =>
  Effect.gen(function* () {
    const { row, setup } = source
    if (setup.read.direction !== undefined && !matches(item, setup.read.direction)) return
    const owner = speaks(item, setup.speaksForMe)
    if (!owner && setup.others === 'drop') return
    const conversation = conversationOf(item, setup.key, setup.read.title)
    const found = valueAt(item, setup.read.text)
    const text = typeof found === 'string' ? found : ''
    const blocks = attachmentsOf(item, setup.read.attachments)
    if (conversation === undefined || (text.trim() === '' && blocks.length === 0)) return
    const route = yield* routeFor(context, source, conversation, ports)
    const target = routeOf(route)
    if (owner) {
      if (target.to === 'ignore') return
      const kept = blocks.length === 0 ? undefined : yield* ports.receive(row.connectionId, blocks)
      const held = { sourceId: row.id, itemId, key: conversation.key, text, kept }
      return yield* send(context, source, route, { held, note: '' }, ports)
    }
    if (target.to === 'ignore') return
    const notice = yield* noticeOf(source, conversation, target, itemId, text)
    yield* ports.notice(notice(yield* ports.label(row.connectionId)))
  })

/** The id of a message: its own (a plain value at `pointer`), else `fallback`. */
const itemIdOf = (item: unknown, pointer: string | undefined, fallback: string) => {
  const id = pointer === undefined ? undefined : scalarAt(item, pointer)
  return id === undefined || id === null || id === '' ? fallback : String(id)
}

/** The messages of an event's data: the list `read.items` points at, or the data as one message. */
export const takeEvent = (
  context: EngineContext,
  source: Loaded,
  event: { readonly eventId: string; readonly data: unknown },
  ports: SourcePorts,
) =>
  Effect.gen(function* () {
    const { read } = source.setup
    if (read.from !== 'payload') return
    const found = read.items === undefined ? [event.data] : valueAt(event.data, read.items)
    const items: readonly unknown[] = Array.isArray(found) ? found : []
    for (const [index, item] of items.entries())
      yield* take(context, source, item, itemIdOf(item, read.id, `${event.eventId}:${String(index)}`), ports)
  })

/** One page of a tool read: its messages, the cursor after them, and where each message's id is. */
type Page = { readonly items: readonly unknown[]; readonly next: string | undefined; readonly id: string }

/** One page of a tool read from `cursor`: its messages and the cursor after them (none when it names none). */
const readPage = (source: Loaded, cursor: string | null, ports: SourcePorts): Effect.Effect<Page, AppError> =>
  Effect.gen(function* () {
    const { read } = source.setup
    if (read.from !== 'tool') return yield* new InvalidInput({ reason: 'source reads no tool' })
    const args = asArguments(fillTemplate(read.arguments, { cursor: cursor ?? undefined }))
    const result = yield* ports.call(source.row.connectionId, read.tool, args)
    const found = valueAt(result, read.items)
    const next = valueAt(result, read.cursor)
    return {
      items: Array.isArray(found) ? found : [],
      next: typeof next === 'string' && next !== '' ? next : undefined,
      id: read.id,
    }
  })

/**
 * A tool read from the Source's cursor, a page at a time, each message taken and the cursor following each page, while
 * the Source is active at the binding it started with.
 */
export const pull = (context: EngineContext, source: Loaded, ports: SourcePorts) =>
  Effect.gen(function* () {
    for (let count = 0; count < MAX_PAGES; count += 1) {
      const row = sourceRow(context.db, source.row.id)
      if (row?.state !== 'active' || row.binding !== source.row.binding) return
      const page = yield* readPage(source, row.cursor, ports)
      for (const item of page.items) {
        const id = itemIdOf(item, page.id, '')
        if (id !== '') yield* take(context, source, item, id, ports)
      }
      if (page.next === undefined) return
      checkpoint(context.db, row.id, row.binding, page.next)
      if (page.items.length === 0 || page.next === row.cursor) return
    }
  })

/** Where a tool read starts when the Source is confirmed: the cursor after its last message, so history stays. */
export const startCursor = (source: Loaded, ports: SourcePorts) =>
  Effect.gen(function* () {
    let cursor: string | null = null
    for (let count = 0; count < MAX_HISTORY_PAGES; count += 1) {
      const page: Page = yield* readPage(source, cursor, ports)
      if (page.next === undefined || page.next === cursor) return page.next ?? cursor
      cursor = page.next
      if (page.items.length === 0) return cursor
    }
    return yield* new InvalidInput({ reason: 'the source has too much history to start from its end' })
  })

/** Where one conversation goes now, as who chose it. */
export type RouteChange = { readonly key: string; readonly target: SourceRoute; readonly by: RouteBy }

/** Sets where `key` goes, as `by` chose it, and delivers what it held. The rows before and after. */
export const route = (context: EngineContext, source: Loaded, change: RouteChange, ports: SourcePorts) =>
  Effect.gen(function* () {
    const { key, target, by } = change
    const now = Math.floor((yield* Clock.currentTimeMillis) / 1000)
    const changed = setRoute(context.db, { sourceId: source.row.id, key }, target, by, now)
    if (changed === undefined) return undefined
    yield* releaseHeld(context, source, key, ports)
    return changed
  })
