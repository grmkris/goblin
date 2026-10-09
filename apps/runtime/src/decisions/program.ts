import type { DecisionLabel } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import { Conflict, NotFound } from '../http/errors.ts'
import {
  Chats,
  Retrieval,
  attempt,
  attemptSync,
  nowSecondsEffect,
  requireBudget,
  requireResident,
} from '../services.ts'
import { chosenText } from './context.ts'
import { Decisions } from './service.ts'
import { DecisionCandidates } from './source.ts'
import { Proposals } from './store.ts'

export const considerOwnerYield = (session: string) =>
  Effect.gen(function* () {
    yield* requireResident
    yield* requireBudget
    const source = yield* DecisionCandidates
    const decisions = yield* Decisions
    for (const item of yield* attempt(() => source.ownerYield(session))) yield* decisions.consider(item)
  }).pipe(Effect.catchCause(() => Effect.void))
export const considerReport = (session: string, relayId: string, text: string, complete: boolean) =>
  Effect.gen(function* () {
    yield* requireResident
    yield* requireBudget
    const source = yield* DecisionCandidates
    const item = yield* attempt(() => source.report(session, relayId, text, complete))
    if (item !== undefined) yield* (yield* Decisions).consider(item)
  }).pipe(Effect.catchCause(() => Effect.void))

/** The first terminal label wins. Confirmation opens a durable owner-only draft/highlight affordance via the feed. */
export const labelDecision = (id: string, label: DecisionLabel['label']) =>
  Effect.gen(function* () {
    const store = yield* Proposals
    const source = yield* DecisionCandidates
    const found = yield* attemptSync(() => store.get(id))
    if (found === undefined) return yield* new NotFound({ what: 'decision proposal' })
    const { proposal, fence } = found
    if (proposal.state !== 'open') {
      if (
        (label === 'confirm' && proposal.state === 'confirmed') ||
        (label === 'dismiss' && proposal.state === 'dismissed')
      )
        return proposal
      return yield* new Conflict({ reason: 'decision already settled' })
    }
    const now = yield* nowSecondsEffect
    if (!(yield* attempt(() => source.current(proposal.chatId, fence)))) {
      yield* attemptSync(() => store.stale(id, now))
      return yield* new Conflict({ reason: 'decision is stale' })
    }
    const result = yield* attemptSync(() => store.decide(id, label, now))
    if (result === undefined) return yield* new NotFound({ what: 'decision proposal' })
    if (result.state !== (label === 'confirm' ? 'confirmed' : 'dismissed'))
      return yield* new Conflict({ reason: 'decision already settled' })
    return result
  })

/** How long earlier work the owner chose to use stays in a chat's requests. */
const CHOSEN_SECONDS = 24 * 60 * 60

/**
 * The earlier work the owner chose to use in the chat of `session` (its newest context proposal confirmed in the last
 * day) as goblin's note for a request, or none. Each later owner message it serves records that use once
 * (`app_retrieval_uses`, mode `auto`), so the answer's source strip names what it was given.
 */
export const chosenContext = (session: string) =>
  Effect.gen(function* () {
    const chat = (yield* Chats).chatOf(session)
    if (chat === undefined) return undefined
    const now = yield* nowSecondsEffect
    const store = yield* Proposals
    const chosen = yield* attemptSync(() => store.chosenContext(chat, now - CHOSEN_SECONDS))
    if (chosen?.payload.type !== 'context') return undefined
    const { inputEntry, sources } = chosen.payload
    const { index } = yield* Retrieval
    const input = yield* attempt(() => index.latestInput(session))
    if (input !== undefined && input.entry > inputEntry) {
      const use = { id: `decision:${chosen.id}:${input.entry}`, chat, session, inputEntry: input.entry }
      yield* attemptSync(() => index.record({ ...use, mode: 'auto', sources, retrievedAt: now }))
    }
    return chosenText(sources)
  })
