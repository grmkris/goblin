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
const selection = (item: Judgment, answers: Answers): number | undefined => {
  const attention = item.case.task === 'attention-triage'
  const distribution =
    answers[item.case.id + (attention ? '.attention' : '.organization')] ??
    answers[attention ? 'attention' : 'organization']
  if (distribution === undefined) return undefined
  const target = attention ? 'highlight' : 'suggest-thread'
  const probability = distribution[target] ?? 0
  return chosen(distribution) === target && probability >= (attention ? 0.5107 : 0.7503) ? probability : undefined
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
    const probability = selection(item, result.answers)
    if (probability === undefined) return undefined
    const current = yield* Effect.tryPromise({ try: item.current, catch: () => new ClefError({ reason: 'format' }) })
    if (!current) return undefined
    const endedAt = yield* Clock.currentTimeMillis
    yield* authorize(deps, Math.floor(endedAt / 1000), false)
    if (item.case.task !== 'attention-triage' && item.case.task !== 'separate-work') return undefined
    return yield* Effect.sync(() =>
      deps.store.add(
        {
          id: item.id,
          chatId: item.chatId,
          subject: item.subject,
          payload: item.payload,
          kind: item.case.task === 'attention-triage' ? 'attention-triage' : 'separate-work',
          provider: result.provider,
          probability,
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
