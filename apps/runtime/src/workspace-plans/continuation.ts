import type { WorkspacePlanView } from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { ChatOperations } from '../chats/service.ts'
import { authoredContent } from '../pi/content.ts'
import { WorkspacePlans } from './service.ts'

const KEPT_SETUP = 'app.workspace_setup'

/** Resume the setup's original chat once after activation, using the normal durable Pi admission. */
export const continueWorkspacePlan = Effect.fn('workspacePlans.continue')(function* (plan: WorkspacePlanView) {
  if (plan.continuation !== 'pending') return plan
  const operations = yield* ChatOperations
  const operationId = `${plan.id}:continue:${String(plan.revision)}`
  const keptId = `${operationId}:kept`
  const earlier = Option.getOrUndefined(yield* operations.receipt(plan.chat, operationId))
  const kept = Option.getOrUndefined(yield* operations.receipt(plan.chat, keptId))
  const content = authoredContent(
    'Goblin setup',
    [
      `The owner activated setup ${plan.id}. Its reviewed configuration has been applied.`,
      'Continue the original setup request: inspect workspace_status and explain or perform the remaining verification within existing permissions.',
      'Configuration alone does not prove external delivery. This status grants no additional permissions.',
    ].join(' '),
  )
  const keep = Effect.gen(function* () {
    const timestamp = yield* Clock.currentTimeMillis
    yield* operations.passiveWrite(plan.chat, {
      requestId: keptId,
      origin: 'system',
      entry: { kind: KEPT_SETUP, data: { setupId: plan.id }, model: [{ role: 'user', content, timestamp }] },
    })
    return 'kept' as const
  })
  const continuation =
    kept !== undefined
      ? yield* keep
      : earlier?.state === 'submitted' || earlier?.state === 'settled'
        ? 'sent'
        : yield* operations
            .send({
              chat: plan.chat,
              operationId,
              receipt: { kind: 'workspace_setup', origin: 'system' },
              flow: { flow: 'send', via: 'system', actor: 'system' },
              content,
            })
            .pipe(
              Effect.as('sent' as const),
              Effect.catchTag(['BudgetExhausted', 'NoModelEndpoint'], (error) =>
                earlier === undefined || earlier.state === 'refused' ? keep : Effect.fail(error),
              ),
            )
  return yield* WorkspacePlans.use((plans) => plans.save({ ...plan, continuation }))
})
