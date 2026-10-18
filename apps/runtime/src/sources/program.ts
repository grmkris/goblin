// Sources proposed, confirmed, bound and kept bound (ADR 0066). A proposal (the agent's `source_propose`; no server
// suggests one, ADR 0068) is checked against what the connection offers now; only the owner's confirmation of its
// exact revision grants its event and tools, subscribes it (consumer `source:<id>`) and binds it to the connection's
// endpoint and those grants. A Source whose endpoint or grants changed since pauses for the owner's review; one whose
// subscription the server ended is subscribed again while they did not.
import {
  type SourceNewKeys,
  type SourceProposal,
  type SourceReplyResultChange,
  type SourceRoute,
  type SourceRoutePick,
  type SourceRouteView,
  type SourceSetup,
  type SourceView,
  SourceRoute as SourceRouteSchema,
} from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Random from 'effect/Random'
import * as Schema from 'effect/Schema'
import { epochSeconds } from '../clock.ts'
import { Conflict, Internal, InvalidInput, NotFound, attemptSync } from '../http/errors.ts'
import type { EventContext } from '../mcp/events/dispatcher.ts'
import { Events, McpConnections, McpGrants, McpServers, requireResident } from '../mcp/service.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Receipts } from '../organize/service.ts'
import { activationRefused } from '../routines/events.ts'
import { sha256Hex } from '../runtime/digest.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { patchCurrentSource, reserveBinding } from './binding.ts'
import { type SourceEngine, loaded } from './engine.ts'
import { keyWords } from './messages.ts'
import { activePersona, activeTopic, personaWords, topicWords } from './places.ts'
import { setupProblems } from './setup.ts'
import {
  type RouteRow,
  type SourceRow,
  forget,
  heldCounts,
  nextReply,
  patchSource,
  propose,
  proposalOf,
  routeOf,
  routeRevision,
  routeRow,
  routeRows,
  routeTarget,
  sourceRow,
  setupOf,
  sourceRows,
  targetOf,
  valuesOf,
  waitingOf,
} from './store.ts'
import type { Loaded, SourceDelivery, SourcePorts } from './types.ts'
import { undoRoute } from './undo.ts'

/** The handler key of every Source's subscription. */
export const SOURCE_HANDLER = 'source-wake'

/** The Events consumer of Source `id`. */
const consumerOf = (id: string) => `source:${id}`

/** How long before its binding an event may have happened and still be the Source's (a clock's leeway). */
const REPLAY_GRACE = 300_000
const DAY = 86_400_000

/** What the owner reads when a Source pauses for their review. */
const CHANGED =
  "The connection's address or the access you granted changed since you confirmed it. Review it and resume."
const ENDED = 'The server ended its subscription and it could not be made again. Review it and resume.'

/** Source `id`'s row; `NotFound` when there is none. */
const found = (id: string) =>
  Effect.gen(function* () {
    const row = sourceRow(yield* Db, id)
    if (row === undefined) return yield* new NotFound({ what: 'source' })
    return row
  })

/** A Source as the owner sees it, with its connection's label and the conversations waiting for a route. */
const viewOf = (row: SourceRow, label: string, setup: SourceSetup, waiting: SourceView['waiting']): SourceView => ({
  id: row.id,
  connectionId: row.connectionId,
  label,
  title: row.title,
  setup,
  revision: row.revision,
  state: row.state,
  ...(row.paused === null ? {} : { paused: row.paused }),
  ...(row.health === null ? {} : { health: row.health }),
  proposedBy: row.proposedBy,
  ...(row.endpoint === null || row.grantVersion === null
    ? {}
    : { bound: { endpoint: row.endpoint, grantVersion: row.grantVersion } }),
  waiting,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.confirmedAt === null ? {} : { confirmedAt: row.confirmedAt }),
})

/** `row` as the owner sees it. */
const sourceView = (row: SourceRow) =>
  Effect.gen(function* () {
    const { setup } = yield* loaded(row)
    const labels = yield* (yield* McpServers).labels()
    return viewOf(row, labels.get(row.connectionId) ?? row.connectionId, setup, waitingOf(yield* Db, row.id))
  })

/** Every Source, the newest first; one whose setup goblin cannot read back is left out. */
export const sourcesList = Effect.gen(function* () {
  const rows = sourceRows(yield* Db)
  const views = yield* Effect.forEach(rows, (row) => Effect.option(sourceView(row)))
  return { sources: views.flatMap((view) => Option.toArray(view)) }
})

/** One conversation's route as the owner sees it. */
const routeView = (row: RouteRow, held: number): SourceRouteView => ({
  key: row.key,
  values: valuesOf(row),
  ...(row.title === null ? {} : { title: row.title }),
  route: routeOf(row),
  held,
  revision: row.revision,
  ...(row.updatedBy === null ? {} : { updatedBy: row.updatedBy }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
})

/** A Source and every conversation it has seen, the newest first. */
export const sourceRoutes = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Db
    const row = yield* found(id)
    const held = heldCounts(db, id)
    const routes = routeRows(db, id).map((route) => routeView(route, held.get(route.key) ?? 0))
    return { source: yield* sourceView(row), routes }
  })

/** A route checked before it is set: its Topic open, its Persona active. A Topic of its own is made when it is needed. */
const checkedRoute = (route: SourceRoute | SourceNewKeys) =>
  Effect.gen(function* () {
    if (route.to === 'topic' || route.to === 'listen' || route.to === 'persona') yield* activeTopic(route.topic)
    if (route.to === 'persona') yield* activePersona(route.persona)
    return route
  })

/** What the connection offers now: its event streams and its tools. */
const offered = (connectionId: string) =>
  Effect.gen(function* () {
    const events = yield* (yield* Events).catalog(connectionId)
    const snapshot = yield* (yield* McpConnections).connect(connectionId)
    return { events, tools: snapshot.tools }
  })

/** `setup` checked against what `connectionId` offers now; `InvalidInput` naming what does not hold. */
const checkedSetup = (connectionId: string, setup: SourceSetup) =>
  Effect.gen(function* () {
    const problems = setupProblems(setup, yield* offered(connectionId))
    if (problems.length > 0) return yield* new InvalidInput({ reason: problems.join(' ') })
    yield* checkedRoute(setup.newKeys)
  })

/** The tools a Source calls: its read tool and its reply tool. */
const toolsOf = (setup: SourceSetup): readonly string[] => [
  ...(setup.read.from === 'tool' ? [setup.read.tool] : []),
  ...(setup.reply === undefined ? [] : [setup.reply.tool]),
]

/**
 * What a Source is bound to now: the connection's endpoint, and a digest of its tools' grants (each one's version, or
 * none), which a new grant, a revoked one or a changed Ask first moves on.
 */
const boundOf = (connectionId: string, setup: SourceSetup) =>
  Effect.gen(function* () {
    const { endpoint } = yield* (yield* McpConnections).server(connectionId)
    const grants = yield* McpGrants
    const versions: string[] = []
    for (const tool of toolsOf(setup)) {
      const policy = yield* grants.policy(connectionId, tool)
      versions.push(`${tool}=${Option.match(policy, { onNone: () => '', onSome: ({ version }) => version })}`)
    }
    const digest = yield* Effect.promise(() => sha256Hex(JSON.stringify(versions)))
    return { endpoint, grantVersion: digest.slice(0, 32) }
  })

/** Whether `source` is still bound as it was confirmed: the same endpoint and grants. A connection gone is not. */
const holds = ({ row, setup }: Loaded) =>
  boundOf(row.connectionId, setup).pipe(
    Effect.map(({ endpoint, grantVersion }) => endpoint === row.endpoint && grantVersion === row.grantVersion),
    // expected: a connection the owner removed is NotFound, and nothing is bound to it any more.
    Effect.catchTag('NotFound', () => Effect.succeed(false)),
  )

/** Claim one unique binding attempt without holding a transaction across any connection wait. */
const reservedBinding = (row: SourceRow) =>
  Effect.gen(function* () {
    const db = yield* Db
    const now = yield* Clock.currentTimeMillis
    const reserved = reserveBinding(db, row, now)
    if (reserved === undefined) return yield* new Conflict({ reason: 'stale' })
    return reserved
  })

/** Retire only this attempt's consumer. A lease shared with other consumers remains theirs. */
const retireBinding = (id: string, binding: number) =>
  Events.use((events) => events.unsubscribe({ consumerId: consumerOf(id), revision: binding })).pipe(
    // expected: an ended subscription needs no cleanup; a remote cleanup failure lapses with its lease.
    Effect.ignore,
  )

/** A failure after activation (for example, refreshing Activity) must not retire the binding already committed. */
const retireUnbound = (id: string, binding: number) =>
  Effect.gen(function* () {
    const current = sourceRow(yield* Db, id)
    if (current?.binding !== binding) yield* retireBinding(id, binding)
  })

/** A new Source's id: `src_` and 16 hex digits. */
const newId = Effect.map(Effect.all([Random.nextIntBetween(0, 2 ** 31), Random.nextIntBetween(0, 2 ** 31)]), (parts) =>
  ['src_', ...parts.map((part) => part.toString(16).padStart(8, '0'))].join(''),
)

/**
 * Validate against the connection before returning a local-only write. Compositions can commit several proposals and
 * their review in one SQLite transaction; no network wait or Effect runs inside that transaction.
 */
export const prepareSource = Effect.fn('sources.prepare')(function* (
  proposal: SourceProposal,
  by: { readonly actor: 'owner' | 'agent'; readonly chat?: string },
) {
  const db = yield* Db
  const existing = proposalOf(db, proposal.operationId)
  if (existing !== undefined) {
    const view = yield* sourceView(existing)
    return () => view
  }
  yield* checkedSetup(proposal.connectionId, proposal.setup)
  const id = yield* newId
  const now = yield* epochSeconds
  const labels = yield* (yield* McpServers).labels()
  return () => {
    const row = propose(
      db,
      {
        id,
        operationId: proposal.operationId,
        connectionId: proposal.connectionId,
        title: proposal.title,
        proposedBy: by.actor,
        chatId: by.chat ?? null,
        setup: proposal.setup,
      },
      now,
    )
    const setup = setupOf(row)
    if (setup === undefined) throw new Internal({ reason: 'source setup unreadable' })
    return viewOf(row, labels.get(row.connectionId) ?? row.connectionId, setup, waitingOf(db, row.id))
  }
})

/** A Source proposal, kept as revision 1 for owner confirmation; the same operation finds the same one. */
export const proposeSource = (
  proposal: SourceProposal,
  by: { readonly actor: 'owner' | 'agent'; readonly chat?: string },
) => Effect.flatMap(prepareSource(proposal, by), attemptSync)

/**
 * Binds `row` as it is now: its event and tools granted, its event subscribed under a new binding (the one before it
 * ended), a tool read started at the end of what is there, and the endpoint and grants it is bound to kept.
 */
const bindReserved = (engine: SourceEngine, ports: SourcePorts, row: SourceRow) =>
  Effect.gen(function* () {
    yield* requireResident
    const source = yield* loaded(row)
    const { setup } = source
    yield* checkedSetup(row.connectionId, setup)
    const events = yield* Events
    const grants = yield* McpGrants
    yield* events.grant(row.connectionId, setup.wake.event, setup.wake.arguments, true)
    for (const tool of toolsOf(setup)) yield* grants.setTool(row.connectionId, tool, true)
    const cursor = setup.read.from === 'tool' ? yield* engine.startCursor(source, ports) : null
    const binding = row.lastBinding
    yield* events.subscribe({
      consumerId: consumerOf(row.id),
      revision: binding,
      connectionId: row.connectionId,
      name: setup.wake.event,
      arguments: setup.wake.arguments,
      handlerKey: SOURCE_HANDLER,
    })
    const bound = yield* boundOf(row.connectionId, setup)
    const now = yield* epochSeconds
    const after = patchCurrentSource(
      yield* Db,
      row,
      {
        state: 'active',
        paused: null,
        health: null,
        endpoint: bound.endpoint,
        grantVersion: bound.grantVersion,
        binding,
        cursor,
        pullDue: false,
        resubscribeDue: false,
        confirmedAt: now,
      },
      now,
    )
    if (after === undefined) return yield* new Conflict({ reason: 'stale' })
    if (row.binding !== null && row.binding !== binding)
      // expected: a binding the server already ended has nothing left to end.
      yield* Effect.ignore(events.unsubscribe({ consumerId: consumerOf(row.id), revision: row.binding }))
    // A Source on the connection's events answers its offer (ADR 0041): Activity stops asking.
    yield* (yield* McpServers).settleEvents(row.connectionId, 'done')
    return after
  })

const bind = (engine: SourceEngine, ports: SourcePorts, original: SourceRow) =>
  Effect.gen(function* () {
    const row = yield* reservedBinding(original)
    return yield* bindReserved(engine, ports, row).pipe(Effect.onError(() => retireUnbound(row.id, row.lastBinding)))
  })

/** The owner confirms revision `revision` of proposal `id`: it is bound and starts. A stale revision is a conflict. */
export const confirmSource = (engine: SourceEngine, ports: SourcePorts, id: string, revision: number) =>
  Effect.gen(function* () {
    const row = yield* found(id)
    if (row.revision !== revision) return yield* new Conflict({ reason: 'stale' })
    if (row.state !== 'proposed') return yield* new Conflict({ reason: `source_${row.state}` })
    return yield* sourceView(yield* bind(engine, ports, row))
  }).pipe(Effect.withSpan('sources.confirm'))

/** The owner refuses revision `revision` of proposal `id`: it never runs. */
export const refuseSource = Effect.fn('sources.refuse')(function* (id: string, revision: number) {
  const row = yield* found(id)
  if (row.revision !== revision) return yield* new Conflict({ reason: 'stale' })
  if (row.state !== 'proposed') return yield* new Conflict({ reason: `source_${row.state}` })
  const after = patchSource(yield* Db, id, { state: 'refused' }, yield* epochSeconds)
  return yield* sourceView(after ?? row)
})

/** Ends `row`'s subscription, while it has one; the binding is forgotten either way. */
const unbind = (row: SourceRow) =>
  Effect.gen(function* () {
    if (row.binding === null) return
    // expected: an ended subscription, or one the server cannot clean up now, lapses with its lease.
    yield* Effect.ignore((yield* Events).unsubscribe({ consumerId: consumerOf(row.id), revision: row.binding }))
    patchCurrentSource(yield* Db, row, { binding: null }, yield* epochSeconds)
  })

/** Editing reply-result rules stops the Source and creates a new exact revision for confirmation. */
export const changeSourceReplyResult = Effect.fn('sources.replyResult')(function* (
  id: string,
  change: SourceReplyResultChange,
) {
  const row = yield* found(id)
  if (row.revision !== change.revision) return yield* new Conflict({ reason: 'stale' })
  if (row.state === 'refused') return yield* new Conflict({ reason: 'source_refused' })
  const { setup } = yield* loaded(row)
  if (setup.reply === undefined) return yield* new InvalidInput({ reason: 'source has no reply tool' })
  const { result: _previous, ...reply } = setup.reply
  const updated = { ...setup, reply: { ...reply, ...(change.result === null ? {} : { result: change.result }) } }
  const now = yield* epochSeconds
  const after = patchCurrentSource(
    yield* Db,
    row,
    {
      setup: JSON.stringify(updated),
      revision: row.revision + 1,
      state: 'proposed',
      paused: null,
      health: null,
      confirmedAt: null,
      binding: null,
    },
    now,
  )
  if (after === undefined) return yield* new Conflict({ reason: 'stale' })
  if (row.binding !== null)
    // expected: the old exact subscription may already have ended; cleanup cannot revive a proposal.
    yield* Effect.ignore((yield* Events).unsubscribe({ consumerId: consumerOf(id), revision: row.binding }))
  ;(yield* AgentInput).scheduleSources(1)
  return yield* sourceView(after)
})

/** Pauses `row`: by the owner, or for their review with `health` saying why. Its subscription ends at the next wake. */
const markPaused = (row: SourceRow, paused: 'owner' | 'review', health: string | null) =>
  Effect.gen(function* () {
    const db = yield* Db
    const after = patchCurrentSource(db, row, { state: 'paused', paused, health }, yield* epochSeconds)
    if (after === undefined) return yield* new Conflict({ reason: 'stale' })
    ;(yield* AgentInput).scheduleSources(1)
    return after
  })

/** The owner pauses Source `id`: nothing is read or answered until they resume it. */
export const pauseSource = Effect.fn('sources.pause')(function* (id: string) {
  const row = yield* found(id)
  if (row.state !== 'active') return yield* new Conflict({ reason: `source_${row.state}` })
  yield* unbind(yield* markPaused(row, 'owner', null))
  return yield* sourceView(yield* found(id))
})

/**
 * The owner resumes Source `id`: it is bound again as it is now (the endpoint and grants of today, a tool read from the
 * end of what is there), so what came while it was paused is not taken.
 */
export const resumeSource = (engine: SourceEngine, ports: SourcePorts, id: string) =>
  Effect.gen(function* () {
    const row = yield* found(id)
    if (row.state !== 'paused') return yield* new Conflict({ reason: `source_${row.state}` })
    return yield* sourceView(yield* bind(engine, ports, row))
  }).pipe(Effect.withSpan('sources.resume'))

/** The owner removes Source `id`: its subscription ends and it is forgotten, with its routes and what it held. */
export const removeSource = Effect.fn('sources.remove')(function* (id: string) {
  const row = yield* found(id)
  yield* unbind(row)
  forget(yield* Db, id)
  return null
})

/** A route in words, with its Topic's and Persona's names: what a receipt and the agent read. */
export const routeWords = (route: SourceRoute) =>
  Effect.gen(function* () {
    if (route.to === 'ignore') return 'ignored'
    if (route.to === 'held') return 'held until you choose where it goes'
    const place = yield* topicWords(route.topic)
    if (route.to === 'listen') return `kept as notes in ${place}`
    if (route.to === 'topic') return `answered by goblin in ${place}`
    return `answered by ${yield* personaWords(route.persona)} in ${place}`
  })

/** Who changed a route and from where: the receipt it leaves says so (ADR 0033). */
export type RouteProvenance = {
  readonly actor: 'owner' | 'agent'
  readonly chat?: string
  readonly operationId?: string
}

/** A route as a receipt keeps it. */
const RouteSnapshot = Schema.Struct({ route: SourceRouteSchema })

/**
 * Sets where one conversation of Source `id` goes, as `by` picked it: what it held is delivered in order, and an
 * organizing receipt with Undo is left. The route after and the receipt's words; `NotFound` for a conversation the
 * Source has never seen.
 */
export const routeSource = (
  engine: SourceEngine,
  ports: SourcePorts,
  id: string,
  pick: SourceRoutePick,
  by: RouteProvenance,
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const source = yield* loaded(yield* found(id))
    if (routeRow(db, id, pick.key) === undefined) return yield* new NotFound({ what: 'source conversation' })
    yield* checkedRoute(pick.route)
    const changed = yield* engine.route(source, { key: pick.key, target: pick.route, by: by.actor }, ports)
    if (changed === undefined) return yield* new NotFound({ what: 'source conversation' })
    const { before, after } = changed
    const label = yield* ports.label(source.row.connectionId)
    const where = after.title ?? keyWords(valuesOf(after))
    const summary = `"${source.row.title}" (${label})${where === '' ? '' : `, ${where},`} is ${yield* routeWords(routeOf(after))}`
    yield* (yield* Receipts).record({
      kind: 'source.route',
      target: routeTarget(id, pick.key),
      summary,
      actor: by.actor,
      ...(by.chat === undefined ? {} : { chat: by.chat }),
      before: { route: routeOf(before) },
      after: { route: routeOf(after) },
      afterRevision: after.revision,
      ...(by.operationId === undefined ? {} : { operationId: `source.route:${by.operationId}` }),
    })
    return { view: routeView(after, heldCounts(db, id).get(pick.key) ?? 0), summary }
  })

/**
 * Undoes a `source.route` receipt: the conversation's route goes back to what it was, with no delivery. Refused as
 * `touched` once anything changed it since, `NotFound` once the Source is gone.
 */
export const undoSourceRoute = (
  engine: SourceEngine,
  receipt: { readonly target: string; readonly before: unknown; readonly afterRevision: number },
) =>
  Effect.gen(function* () {
    const { sourceId, key } = targetOf(receipt.target)
    yield* found(sourceId)
    yield* undoRoute(receipt, routeRevision(yield* Db, receipt.target), RouteSnapshot, ({ route }) =>
      Effect.asVoid(engine.restore(sourceId, key, route)),
    )
  })

/**
 * Whether an occurrence is a replay a Source should not take: one that happened more than five minutes before it was
 * bound (a producer replaying its backlog on a fresh subscription), more than a day ago, or at no readable time.
 */
const replayed = (row: SourceRow, occurredAt: number, at: number): boolean =>
  !Number.isFinite(occurredAt) ||
  occurredAt < at - DAY ||
  (row.confirmedAt !== null && occurredAt < row.confirmedAt * 1000 - REPLAY_GRACE)

/**
 * A delivery to a Source's subscription (handler `source-wake`), for its active binding only. An occurrence is taken
 * while the Source is bound as it was confirmed (else it pauses for review): from the event's data at once, or by the
 * pull its alarm runs. A terminated subscription is subscribed again by the alarm, and a gap pulls again. The
 * occurrence's data is untrusted: only the confirmed setup reads it.
 */
export const consumeSourceEvent = (engine: SourceEngine, ports: SourcePorts, context: EventContext) =>
  Effect.gen(function* () {
    const db = yield* Db
    const input = yield* AgentInput
    const row = sourceRow(db, context.consumer.consumerId.slice('source:'.length))
    if (row?.state !== 'active' || row.binding !== context.consumer.revision) return
    const source = yield* loaded(row)
    const { envelope } = context
    const now = yield* epochSeconds
    if ('type' in envelope) {
      if (envelope.type === 'terminated') patchSource(db, row.id, { resubscribeDue: true }, now)
      else if (envelope.type === 'gap' && source.setup.read.from === 'tool')
        patchSource(db, row.id, { pullDue: true }, now)
      else return
      return input.scheduleSources(1)
    }
    if (envelope.name !== context.subscription.name) return
    if (replayed(row, Date.parse(envelope.timestamp), yield* Clock.currentTimeMillis)) return
    if (!(yield* holds(source))) return yield* Effect.asVoid(markPaused(row, 'review', CHANGED))
    if (source.setup.read.from === 'payload') return yield* engine.takeEvent(source, envelope, ports)
    patchSource(db, row.id, { pullDue: true }, now)
    input.scheduleSources(0)
  })

/** Whether `row`'s subscription is still live: bound, and neither terminated nor tombstoned by the server. */
const live = (row: SourceRow) =>
  Effect.gen(function* () {
    const events = yield* Events
    const binding = Option.getOrUndefined(yield* events.activeConsumer(consumerOf(row.id)))
    if (binding?.revision !== row.binding) return false
    const lease = Option.getOrUndefined(yield* events.subscription(binding.subscriptionId))
    return lease !== undefined && lease.status !== 'terminated' && lease.status !== 'tombstone'
  })

/**
 * Subscribes an active Source again whose subscription ended, while it is bound as it was confirmed: a new binding, the
 * old one ended, and a tool read pulled for what came meanwhile. A refusal the owner must act on pauses it for review;
 * anything else fails, and the next wake tries again.
 */
const resubscribe = (source: Loaded) =>
  Effect.gen(function* () {
    const { setup } = source
    const row = yield* reservedBinding(source.row)
    const events = yield* Events
    const binding = row.lastBinding
    const subscribed = yield* events
      .subscribe({
        consumerId: consumerOf(row.id),
        revision: binding,
        connectionId: row.connectionId,
        name: setup.wake.event,
        arguments: setup.wake.arguments,
        handlerKey: SOURCE_HANDLER,
      })
      .pipe(
        Effect.onError(() => retireUnbound(row.id, binding)),
        Effect.as(true),
        // expected: a refusal the owner must act on is told to them as the Source's review, not retried.
        Effect.catchIf(activationRefused, () => Effect.as(markPaused(row, 'review', ENDED), false)),
      )
    if (!subscribed) return
    const now = yield* epochSeconds
    const after = patchCurrentSource(
      yield* Db,
      row,
      { binding, resubscribeDue: false, pullDue: setup.read.from === 'tool', health: null },
      now,
    )
    if (after === undefined) {
      yield* retireBinding(row.id, binding)
      return yield* new Conflict({ reason: 'stale' })
    }
    if (row.binding !== null)
      // expected: the old binding's subscription already ended; this only retires the consumer's row.
      yield* Effect.ignore(events.unsubscribe({ consumerId: consumerOf(row.id), revision: row.binding }))
  })

/**
 * One Source's share of the alarm: a Source that is not active has its subscription ended; an active one is paused for
 * review when its endpoint or grants changed, subscribed again when its subscription ended, and pulled when a tool read
 * is due.
 */
const tend = (engine: SourceEngine, ports: SourcePorts, row: SourceRow) =>
  Effect.gen(function* () {
    if (row.state !== 'active') return yield* unbind(row)
    const source = yield* loaded(row)
    if (!(yield* holds(source))) {
      yield* unbind(yield* markPaused(row, 'review', CHANGED))
      return
    }
    if (row.resubscribeDue || !(yield* live(row))) yield* resubscribe(source)
    const now = sourceRow(yield* Db, row.id)
    if (now?.state !== 'active' || !now.pullDue || source.setup.read.from !== 'tool') return
    patchSource(yield* Db, row.id, { pullDue: false }, yield* epochSeconds)
    yield* engine.pull({ row: now, setup: source.setup }, ports)
  })

/**
 * The Sources' alarm (`sourcesWake`): each Source tended (a failure reported, the rest go on), then every answer that
 * is due sent. The seconds until the next wake: soon while answers are still running, at the next try of one that
 * failed, in five minutes after a failure; none when nothing waits.
 */
export const wakeSources = (
  engine: SourceEngine,
  ports: SourcePorts,
  delivered: (delivery: SourceDelivery) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    yield* requireResident
    let failed = false
    for (const row of sourceRows(yield* Db))
      if (!(yield* tend(engine, ports, row).pipe(Effect.as(true), reportAndRecover('sources.tend', false))))
        failed = true
    const running = yield* engine.deliver(ports, delivered)
    const next = nextReply(yield* Db)
    const now = yield* epochSeconds
    if (running) return 15
    if (next !== undefined) return Math.max(1, next - now)
    return failed ? 300 : undefined
  })
