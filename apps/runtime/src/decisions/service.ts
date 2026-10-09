import type { DecisionAction, DecisionProposal } from '@goblin/contracts'
import type { ModelBudget } from '../budget.ts'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import { type AppError, toAppError } from '../http/errors.ts'
import type { AuxCall } from '../telemetry/report.ts'
import type { ResidentAuthority } from '../resident.ts'
import { ClefError, type ClefClient } from './client.ts'
import type { Answers, DecisionCase } from './schema.ts'
import { chosen } from './questions.ts'
import { rules } from './rules.ts'
import { decodeAnswers, packet, usageOf } from './wire.ts'
import type { DecisionFence, ProposalStore } from './store.ts'

export type Judgment = {
  readonly id: string
  readonly chatId: string
  readonly subject: string
  readonly case: DecisionCase
  readonly payload: DecisionAction
  readonly fence: DecisionFence
  /** Runtime questions, failures and approvals never enter attention ranking. */
  readonly ordinary: boolean
  readonly current: () => Promise<boolean>
}
type DecisionDeps = {
  readonly client: ClefClient
  readonly budget: Pick<ModelBudget, 'require' | 'record'>
  readonly resident: Pick<ResidentAuthority, 'require'>
  readonly store: ProposalStore
  readonly report: (call: AuxCall) => void
}
/** What a judgment proposes: how sure it is, and the action (a context proposal keeps only its relevant sources). */
type Selected = { readonly probability: number; readonly payload: DecisionAction }
/** The frozen v4 thresholds (bench/reports/decisions-decisions-20261009-v4.md), Clef's for every judgment. */
const THRESHOLD = { attention: 0.5107, organization: 0.7503, context: 0.594 } as const
/** A question's answers, under its case-scoped name (a model's) or its own (the rules'). */
const answer = (item: Judgment, answers: Answers, question: string) =>
  answers[`${item.case.id}.${question}`] ?? answers[question]
const sure = (distribution: Readonly<Record<string, number>> | undefined, target: string, threshold: number) => {
  const probability = distribution?.[target] ?? 0
  return distribution !== undefined && chosen(distribution) === target && probability >= threshold
    ? probability
    : undefined
}
/** The candidates judged relevant at the frozen threshold, in their order; none when none is. */
function contextSelection(item: Judgment, answers: Answers): Selected | undefined {
  if (item.case.task !== 'context-relevance' || item.payload.type !== 'context') return undefined
  const kept = item.case.state.candidates.map((candidate) =>
    sure(answer(item, answers, candidate.id), 'yes', THRESHOLD.context),
  )
  const sources = item.payload.sources.filter((_source, index) => kept[index] !== undefined)
  const [first, ...rest] = sources
  if (first === undefined) return undefined
  return {
    probability: Math.max(...kept.flatMap((probability) => (probability === undefined ? [] : [probability]))),
    payload: { ...item.payload, sources: [first, ...rest] },
  }
}
const selection = (item: Judgment, answers: Answers): Selected | undefined => {
  if (item.case.task === 'context-relevance') return contextSelection(item, answers)
  const attention = item.case.task === 'attention-triage'
  const probability = attention
    ? sure(answer(item, answers, 'attention'), 'highlight', THRESHOLD.attention)
    : sure(answer(item, answers, 'organization'), 'suggest-thread', THRESHOLD.organization)
  return probability === undefined ? undefined : { probability, payload: item.payload }
}
const fullReservation = { input: 65_536, output: 0, cacheRead: 0, cacheWrite: 0 }
const authorize = (deps: DecisionDeps, now: number, checkBudget = true): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      deps.resident.require(now)
      if (checkBudget) await deps.budget.require(now)
    },
    catch: toAppError,
  })

const considerWith = (deps: DecisionDeps, item: Judgment) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    yield* authorize(deps, Math.floor(startedAt / 1000))
    const local = rules(item.case)
    const result = local.decided
      ? { answers: local.answers, provider: 'rules' as const }
      : { answers: yield* modelAnswers(deps, item, startedAt), provider: 'cloudflare/clef' as const }
    const selected = selection(item, result.answers)
    if (selected === undefined) return undefined
    const current = yield* Effect.tryPromise({ try: item.current, catch: () => new ClefError({ reason: 'format' }) })
    if (!current) return undefined
    const endedAt = yield* Clock.currentTimeMillis
    yield* authorize(deps, Math.floor(endedAt / 1000), false)
    const kind = item.case.task
    if (kind === 'brief-update') return undefined
    return yield* Effect.sync(() =>
      deps.store.add(
        {
          id: item.id,
          chatId: item.chatId,
          subject: item.subject,
          payload: selected.payload,
          kind,
          provider: result.provider,
          probability: selected.probability,
          state: 'open',
          createdAt: Math.floor(endedAt / 1000),
        },
        item.fence,
      ),
    )
  })
const report = (deps: DecisionDeps, startedAt: number, usage: typeof fullReservation, error = false): void =>
  deps.report({
    startedAt,
    message: {
      provider: 'cloudflare',
      model: 'cloudflare/clef',
      stopReason: error ? 'error' : 'stop',
      usage,
    },
  })
const modelAnswers = (deps: DecisionDeps, item: Judgment, startedAt: number): Effect.Effect<Answers, ClefError> => {
  const data = packet([item.case])
  return Effect.gen(function* () {
    const raw = yield* deps.client.evaluate(data).pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (error.reason !== 'unavailable') {
            deps.budget.record(fullReservation, Math.floor(startedAt / 1000), 'clef')
            report(deps, startedAt, fullReservation, true)
          }
        }),
      ),
    )
    const use = yield* Effect.try({ try: () => usageOf(raw), catch: () => new ClefError({ reason: 'format' }) }).pipe(
      Effect.catchTag('ClefError', () => Effect.succeed(undefined)),
    )
    const tokens = use === undefined ? fullReservation : { ...use, cacheRead: 0, cacheWrite: 0 }
    yield* Effect.sync(() => deps.budget.record(tokens, Math.floor(startedAt / 1000), 'clef'))
    const answers = yield* Effect.try({
      try: () => decodeAnswers(raw, data.questions),
      catch: () => new ClefError({ reason: 'format' }),
    }).pipe(Effect.tapError(() => Effect.sync(() => report(deps, startedAt, tokens, true))))
    yield* Effect.sync(() => report(deps, startedAt, tokens))
    return answers
  })
}
export class DecisionService {
  readonly #deps: DecisionDeps
  readonly #pending = new Set<string>()
  constructor(deps: DecisionDeps) {
    this.#deps = deps
  }
  /** Optional side work: failures produce no proposal and leave the owner's turn untouched. */
  consider(item: Judgment): Effect.Effect<DecisionProposal | undefined> {
    const deps = this.#deps
    const pending = this.#pending
    return Effect.suspend(() => {
      if (!item.ordinary || pending.has(item.id) || deps.store.get(item.id) !== undefined)
        return Effect.succeed(undefined)
      pending.add(item.id)
      return considerWith(deps, item).pipe(Effect.ensuring(Effect.sync(() => pending.delete(item.id))))
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
  }
}
export class Decisions extends Context.Service<Decisions, DecisionService>()('goblin/Decisions') {}
