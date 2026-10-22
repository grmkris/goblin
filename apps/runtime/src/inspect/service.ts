import type { SubmissionRecord } from '@earendil-works/pi-durable'
import type {
  InspectConversations,
  InspectDetails,
  InspectDetailsArguments,
  InspectDetailsInput,
  InspectEntries,
  InspectFlows,
  InspectFlowsInput,
  InspectInput,
  InspectProblems,
  InspectTurns,
  RelatedOperation,
  TurnTimeline,
} from '@goblin/contracts/inspect'
import type { RunEvent } from '@goblin/contracts/telemetry'
import * as Clock from 'effect/Clock'
import type { TraceData } from 'effect/observability/OtlpTracer'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import { chatOfSession } from '../chats/directory.ts'
import { Conversations } from '../chats/service.ts'
import { type AppError, InvalidInput, NotFound, attempt, attemptSync } from '../http/errors.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { AgentInput } from '../runtime/input.ts'
import { Db } from '../runtime/db.ts'
import { RunLedger } from '../telemetry/ledger.ts'
import { coverageGaps, operationGaps } from './coverage.ts'
import {
  childrenOf,
  flowRecord,
  inspectEntry,
  ranWithOf,
  relatedOf,
  settlementOf,
  spentOf,
  stepsOf,
  summarize,
} from './inspector.ts'
import { traceOf } from './otlp.ts'

/** What a query of `kind` takes besides its kind. */
type Input<K extends keyof typeof InspectInput> = (typeof InspectInput)[K]['Type']

/** What `turns`, `problems` and `flows` look back over by default. */
const DAY_MS = 24 * 60 * 60 * 1000
/** Newer than any entry: the newest page of a conversation. */
const NEWEST = 2 ** 31
const TURNS = 20
const PROBLEMS = 50
const FLOWS = 50
/** The most turns a trace nests under the one it is of. */
const TRACED_CHILDREN = 20

/** Where a run event belongs for a key: a chat within its reach, one outside it, or no chat at all. */
export type Place = 'in' | 'out' | 'nowhere'

/**
 * What a server's API key may read of the run ledger (ADR 0084): the events of chats within its reach. The reads that
 * take one see only those: a list leaves the rest out, and an operation is there only when some of its events are in
 * reach and none is outside it.
 */
export interface Reach {
  readonly place: (event: RunEvent) => Place
  readonly chat: (chat: string) => boolean
}

/** Whether an operation of `events` is within `reach`: one of them is in it, and none is outside it. */
export const withinReach = (reach: Reach, events: readonly RunEvent[]): boolean => {
  const places = events.map(reach.place)
  return places.includes('in') && !places.includes('out')
}

/**
 * Read-only inspection of this agent (ADR 0024): Pi for content and settlement, the run ledger for how each turn and
 * each conversation flow ran. The content-free reads take a key's `Reach` (ADR 0084), and see only within it. No read changes the agent or calls a model; a turn, conversation or operation that is not
 * there is `NotFound`, and a details query that names neither an operation nor a chat entry is `InvalidInput`.
 */
export class Inspection extends Context.Service<
  Inspection,
  {
    /** Every conversation the agent keeps (main, threads, subagents, clients), with titles and activity. */
    readonly conversations: Effect.Effect<InspectConversations, AppError>
    /** A page of a conversation's entries, oldest first, ending before `before` (the newest page without it). */
    readonly conversation: (input: Input<'conversation'>) => Effect.Effect<InspectEntries, AppError>
    /** Turns since `since` (the last day by default), newest first, optionally of one conversation. */
    readonly turns: (input: Input<'turns'>, reach?: Reach) => Effect.Effect<InspectTurns, AppError>
    /**
     * One turn end to end: its summary, Pi's settlement, every run event, its steps and where its time went, and what
     * the timeline cannot show.
     */
    readonly turn: (operationId: string, reach?: Reach) => Effect.Effect<TurnTimeline, AppError>
    /**
     * The same turn as OpenTelemetry traces data (ADR 0107), with the turns it started within `reach` nested under it:
     * content-free, as its run events are.
     */
    readonly trace: (operationId: string, reach?: Reach) => Effect.Effect<TraceData, AppError>
    /** Events needing attention since `since`, newest first; `all` includes expected waits and recovered attempts. */
    readonly problems: (input: Input<'problems'>, reach?: Reach) => Effect.Effect<InspectProblems, AppError>
    /** Conversation flow steps since `since`, newest first, optionally of one chat or one flow. */
    readonly flows: (input: InspectFlowsInput, reach?: Reach) => Effect.Effect<InspectFlows, AppError>
    /**
     * The details behind a message: the timeline of its operation (with its turn when it ran one) and the operations
     * related to it. A chat entry names the operation whose model answer or tool result it is.
     */
    readonly details: (input: InspectDetailsInput, reach?: Reach) => Effect.Effect<InspectDetails, AppError>
  }
>()('goblin/inspect/Inspection') {
  /** Over the run ledger in the agent's SQLite, its registered chats and Pi's own settlements. */
  static readonly layer: Layer.Layer<Inspection, never, Db | Conversations | AgentInput> = Layer.effect(
    Inspection,
    Effect.gen(function* () {
      const db = yield* Db
      const chats = yield* Conversations
      const { harness, env, workspaceId } = yield* AgentInput
      return makeInspection({
        ledger: new RunLedger(db),
        chats,
        chatOf: (session) => chatOfSession(db, session),
        deployment: { workspace: workspaceId, stage: env.STAGE },
        settlement: (session, operationId) =>
          attempt(async () =>
            (await harness.pi()).commit(
              (tx) => tx.submissionByRequest(conversationId(session), operationId),
              BACKGROUND,
            ),
          ),
      })
    }),
  )
}

/** What inspection reads: the run ledger, the registered chats and Pi's settlement of one submission. */
export interface InspectionSources {
  readonly ledger: Pick<
    RunLedger,
    | 'forOperation'
    | 'forOperations'
    | 'turns'
    | 'problems'
    | 'flows'
    | 'operationOfEntry'
    | 'childFlows'
    | 'operationsStarting'
  >
  readonly chats: Pick<(typeof Conversations)['Service'], 'list' | 'require' | 'history'>
  /** The chat a Pi session belongs to, if it is registered; synchronous, like the ledger. */
  readonly chatOf: (session: string) => string | undefined
  /** The workspace whose agent this is and its stage, for a trace's id and resource (ADR 0107). */
  readonly deployment: { readonly workspace: string; readonly stage?: string | undefined }
  /** The submission `operationId` names in Pi session `session`, if Pi has it. */
  readonly settlement: (session: string, operationId: string) => Effect.Effect<SubmissionRecord | undefined, AppError>
}

/** A ledger read; stored data that no longer decodes is our fault, reported and answered as `Internal`. */

/** `since` as given, or a day before now. */
const sinceOr = (since: number | undefined): Effect.Effect<number> =>
  since === undefined ? Effect.map(Clock.currentTimeMillis, (now) => now - DAY_MS) : Effect.succeed(since)

/** A details query's reader input: an operation, or a chat with one of its entries. Anything else is invalid. */
export const detailsInput = ({
  operation,
  chat,
  entry,
}: InspectDetailsArguments): Effect.Effect<InspectDetailsInput, AppError> => {
  if (operation !== undefined) return Effect.succeed({ operation })
  if (chat !== undefined && entry !== undefined) return Effect.succeed({ chat, entry })
  return Effect.fail(new InvalidInput({ reason: 'details take an operation, or a chat and an entry' }))
}

type Reads = (typeof Inspection)['Service']

/** A turn's timeline: its summary, Pi's settlement of it, its events, their steps and time, and what they cannot show. */
const timelineWith = (settlement: InspectionSources['settlement']) =>
  Effect.fn('Inspection.timeline')(function* (turn: RunEvent, events: readonly RunEvent[]) {
    const operationId = turn.operationId ?? turn.id
    const record = turn.conversationId === undefined ? undefined : yield* settlement(turn.conversationId, operationId)
    const submission = settlementOf(record)
    const gaps = coverageGaps(turn, events, submission)
    const now = yield* Clock.currentTimeMillis
    return {
      turn: summarize(turn, events),
      ...(submission === undefined ? {} : { submission }),
      events,
      steps: stepsOf(turn, events),
      spent: spentOf(turn, events, now),
      ranWith: ranWithOf(events),
      coverage: { complete: gaps.length === 0, gaps },
    }
  })

/** `reach`'s judgement of an operation's events: nothing to judge for the owner. */
const reached = (reach: Reach | undefined, events: readonly RunEvent[]): boolean =>
  reach === undefined || withinReach(reach, events)

/** A chat `reach` does not hold is as if it were not there. */
const requireChat = (reach: Reach | undefined, chat: string | undefined) =>
  reach === undefined || chat === undefined || reach.chat(chat)
    ? Effect.void
    : Effect.fail(new NotFound({ what: 'conversation' }))

/** The events `reach` keeps in a list: those of chats within it; every one for the owner. */
const keepOf = (reach: Reach | undefined) =>
  reach === undefined ? undefined : (event: RunEvent) => reach.place(event) === 'in'

/**
 * The details behind a message: the operation it names, or the one whose answer or tool result the entry is, with its
 * timeline (a turn's, or only its steps when it ran none) and the operations related to it.
 */
const detailsWith = ({ ledger, chats, settlement }: InspectionSources): Reads['details'] => {
  const timeline = timelineWith(settlement)
  const operationOfEntry = Effect.fn('Inspection.operationOfEntry')(function* (chat: string, entry: number) {
    const session = yield* chats.require(chat)
    const operation = yield* attemptSync(() => ledger.operationOfEntry(session, entry))
    if (operation === undefined) return yield* new NotFound({ what: 'entry operation' })
    return operation
  })
  /** The related operations `reach` holds: those whose own events are within it. */
  const relatedWithin = (related: readonly RelatedOperation[], reach: Reach | undefined) =>
    attemptSync(() => {
      if (reach === undefined) return related
      const events = ledger.forOperations(related.map((each) => each.operation))
      return related.filter((each) =>
        withinReach(
          reach,
          events.filter((event) => event.operationId === each.operation),
        ),
      )
    })
  return Effect.fn('Inspection.details')(function* (input: InspectDetailsInput, reach?: Reach) {
    yield* requireChat(reach, 'chat' in input ? input.chat : undefined)
    const operationId = 'operation' in input ? input.operation : yield* operationOfEntry(input.chat, input.entry)
    const events = yield* attemptSync(() => ledger.forOperation(operationId))
    if (!reached(reach, events)) return yield* new NotFound({ what: 'operation' })
    const related = yield* relatedWithin(yield* attemptSync(() => relatedOf(ledger, operationId, events)), reach)
    const submitted = events.find((event) => event.kind === 'turn.submitted')
    if (submitted !== undefined) return { ...(yield* timeline(submitted, events)), related }
    if (events.length === 0 && related.length === 0) return yield* new NotFound({ what: 'operation' })
    const gaps = operationGaps(events)
    return { events, coverage: { complete: gaps.length === 0, gaps }, related }
  })
}

/** The inspection reads over `sources`; the native layer's, and a test's over fakes. */
export function makeInspection(sources: InspectionSources): Reads {
  const { ledger, chats, settlement, chatOf, deployment } = sources
  const timeline = timelineWith(settlement)
  const reads: Reads = {
    conversations: Effect.map(chats.list, (list) => ({ conversations: list })).pipe(
      Effect.withSpan('Inspection.conversations'),
    ),
    conversation: Effect.fn('Inspection.conversation')(function* (input: Input<'conversation'>) {
      const page = yield* chats.history(input.conversation, input.before ?? NEWEST)
      const first = page.entries[0]
      return {
        conversation: input.conversation,
        entries: page.entries.map(inspectEntry),
        ...(page.more && first !== undefined ? { before: Number(first.id) } : {}),
      }
    }),
    turns: Effect.fn('Inspection.turns')(function* (input: Input<'turns'>, reach?: Reach) {
      yield* requireChat(reach, input.conversation)
      const session = input.conversation === undefined ? undefined : yield* chats.require(input.conversation)
      const since = yield* sinceOr(input.since)
      return yield* attemptSync(() => {
        const found = ledger.turns(since, input.limit ?? TURNS, session, keepOf(reach))
        const events = ledger.forOperations(found.flatMap((turn) => turn.operationId ?? []))
        const own = (turn: RunEvent) => events.filter((event) => event.operationId === turn.operationId)
        return { turns: found.map((turn) => summarize(turn, own(turn))) }
      })
    }),
    turn: Effect.fn('Inspection.turn')(function* (operationId: string, reach?: Reach) {
      const events = yield* attemptSync(() => ledger.forOperation(operationId))
      const submitted = events.find((event) => event.kind === 'turn.submitted')
      if (submitted === undefined || !reached(reach, events)) return yield* new NotFound({ what: 'turn' })
      return yield* timeline(submitted, events)
    }),
    trace: Effect.fn('Inspection.trace')(function* (operationId: string, reach?: Reach) {
      const events = yield* attemptSync(() => ledger.forOperation(operationId))
      const submitted = events.find((event) => event.kind === 'turn.submitted')
      if (submitted === undefined || !reached(reach, events)) return yield* new NotFound({ what: 'turn' })
      const submission =
        submitted.conversationId === undefined
          ? undefined
          : settlementOf(yield* settlement(submitted.conversationId, operationId))
      const children = yield* attemptSync(() => {
        const ids = childrenOf(ledger, operationId)
          .slice(0, TRACED_CHILDREN)
          .map(([child]) => child)
        const theirs = ledger.forOperations(ids)
        return ids.flatMap((child) => {
          const own = theirs.filter((event) => event.operationId === child)
          const turn = own.find((event) => event.kind === 'turn.submitted')
          return turn === undefined || !reached(reach, own) ? [] : [{ operationId: child, turn, events: own }]
        })
      })
      return traceOf({
        workspace: deployment.workspace,
        stage: deployment.stage,
        root: { operationId, turn: submitted, events, ...(submission === undefined ? {} : { submission }) },
        children,
        chatOf,
        now: yield* Clock.currentTimeMillis,
      })
    }),
    problems: Effect.fn('Inspection.problems')(function* (input: Input<'problems'>, reach?: Reach) {
      const since = yield* sinceOr(input.since)
      return {
        since,
        problems: yield* attemptSync(() =>
          ledger.problems(since, input.limit ?? PROBLEMS, input.all === true, keepOf(reach)),
        ),
      }
    }),
    flows: Effect.fn('Inspection.flows')(function* (input: InspectFlowsInput, reach?: Reach) {
      yield* requireChat(reach, input.chat)
      const since = yield* sinceOr(input.since)
      const steps = yield* attemptSync(() => ledger.flows(since, input.limit ?? FLOWS, input, keepOf(reach)))
      return { since, flows: steps.flatMap((event) => flowRecord(event) ?? []) }
    }),
    details: detailsWith(sources),
  }
  return Inspection.of(reads)
}
