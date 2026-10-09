import type { PiHarness } from 'agents/harness/pi'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq, sql } from 'drizzle-orm'
import * as Effect from 'effect/Effect'
import type { DecisionProposal } from '@goblin/contracts'
import { DecisionSource } from '../../src/decisions/source.ts'
import { DecisionService } from '../../src/decisions/service.ts'
import { DecisionStore } from '../../src/decisions/store.ts'
import { ChatDirectory } from '../../src/chats/directory.ts'
import { ResidentAuthority } from '../../src/resident.ts'
import { BudgetExhausted } from '../../src/http/errors.ts'
import { appConversations } from '../../src/storage/schema.ts'
import { appDecisionLabels } from '../../src/storage/decision-schema.ts'
import { unavailableClef } from './decisions-fixture.ts'
import { unwrap } from '../../src/http/rpc.ts'
import type { RpcResult } from '../../src/http/rpc.ts'

export async function decisionsProbe(input: {
  readonly storage: DurableObjectStorage
  readonly harness: PiHarness
  readonly label: (id: string, label: 'confirm' | 'dismiss') => Promise<RpcResult<DecisionProposal>>
  readonly chatProof: () => Promise<string>
}) {
  const db = drizzle(input.storage)
  const chats = new ChatDirectory(db)
  const session = chats.session(chats.primary())
  const store = new DecisionStore(db)
  const source = new DecisionSource(db, input.harness, chats)
  const changes: DecisionProposal[] = []
  store.onChange((proposal) => changes.push(proposal))
  let calls = 0
  let stale = false
  let exhausted = false
  let charged = 0
  const service = new DecisionService({
    store,
    resident: new ResidentAuthority(db),
    report: () => undefined,
    budget: {
      require: async () => {
        if (exhausted) throw new BudgetExhausted({ limit: 0, resetsAt: 0 })
      },
      record: (use) => {
        charged += use.input
      },
    },
    client: {
      evaluate: (data) =>
        Effect.sync(() => {
          calls += 1
          if (stale)
            db.update(appConversations)
              .set({ epoch: sql`${appConversations.epoch} + 1` })
              .where(eq(appConversations.chatId, chats.primary()))
              .run()
          return {
            usage: { input_tokens: 1000, output_tokens: 0 },
            answers: Object.fromEntries(
              Object.entries(data.questions).map(([id, question]) => [
                id,
                {
                  probabilities: Object.fromEntries(
                    question.options.map((option) => [option, option === 'highlight' ? 0.85 : 0.05]),
                  ),
                },
              ]),
            ),
          }
        }),
    },
  })
  const consider = async (id: string) => {
    const candidate = await source.report(session, id, 'The comparison adds useful evidence about the trip.', true)
    return candidate === undefined ? undefined : Effect.runPromise(service.consider(candidate))
  }
  const first = await consider('native-relay')
  await consider('native-relay')
  const once = calls === 1 && changes.length === 1
  const confirmed = unwrap(await input.label(first?.id ?? '', 'confirm'))
  const replay = unwrap(await input.label(first?.id ?? '', 'confirm'))
  const opposite = await input.label(first?.id ?? '', 'dismiss')
  const other = await consider('native-dismiss')
  const dismissed = unwrap(await input.label(other?.id ?? '', 'dismiss'))
  stale = true
  await consider('native-stale')
  stale = false
  const staleDiscarded = store.get('dp_report_native-stale') === undefined
  exhausted = true
  const beforeBudget = calls
  await consider('native-budget')
  const noBudgetCall = calls === beforeBudget
  exhausted = false
  const unavailable = new DecisionService({
    store,
    resident: new ResidentAuthority(db),
    client: unavailableClef,
    budget: { require: async () => undefined, record: () => undefined },
    report: () => undefined,
  })
  const candidate = await source.report(session, 'native-unavailable', 'A new useful comparison.', true)
  if (candidate !== undefined) await Effect.runPromise(unavailable.consider(candidate))
  const work = await source.ownerYield(session)
  const evidenceFence = work?.fence
  const labels = db.select().from(appDecisionLabels).all()
  return {
    once,
    confirmed,
    replay,
    opposite,
    dismissed,
    staleDiscarded,
    noBudgetCall,
    charged,
    unavailableDiscarded: store.get('dp_report_native-unavailable') === undefined,
    ownerCandidate: work !== undefined,
    evidenceFence: evidenceFence !== undefined,
    labels,
    retained: new DecisionStore(db).list(),
    chatAnswer: await input.chatProof(),
  }
}
