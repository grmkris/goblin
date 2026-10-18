import { OwnerApi } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { WorkspacePlans } from './service.ts'
import { applyWorkspacePlan, retryWorkspacePlan } from './program.ts'

/** Owner-only review and apply; the tool may prepare the composition but cannot confirm it. */
export const WorkspacePlansHandlers = HttpApiBuilder.group(OwnerApi, 'workspacePlans', (handlers) =>
  handlers
    .handle('list', () => WorkspacePlans.use((store) => Effect.map(store.list, (plans) => ({ plans }))))
    .handle('get', ({ params }) => WorkspacePlans.use((plans) => plans.get(params.id)))
    .handle('prepare', ({ params, payload }) => retryWorkspacePlan(params.id, payload.revision))
    .handle('apply', ({ params, payload }) => applyWorkspacePlan(params.id, payload.revision)),
)
