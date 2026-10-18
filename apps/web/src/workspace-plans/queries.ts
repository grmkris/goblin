import { mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type { WorkspacePlanDecision } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { sourceKeys } from '../sources/queries.ts'
import { routinesQuery } from '../routines/queries.ts'
import { mcpKeys } from '../mcp/queries.ts'

export const workspacePlanKeys = {
  all: ['workspace-plans'] as const,
  detail: (id: string | undefined) => ['workspace-plans', 'detail', id] as const,
}

/** Review is read from the authenticated runtime; transcript fields never supply its authority. */
export const workspacePlanQuery = (id: string | undefined) =>
  queryOptions({
    queryKey: workspacePlanKeys.detail(id),
    queryFn:
      id === undefined
        ? skipToken
        : owner.apiQuery({
            queryKey: workspacePlanKeys.detail(id),
            queryFn: (api) => api.workspacePlans.get({ params: { id } }),
          }).queryFn,
    staleTime: 0,
  })

export const prepareWorkspacePlanMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { id, ...payload }: WorkspacePlanDecision & { readonly id: string }) =>
      api.workspacePlans.prepare({ params: { id }, payload }),
  }),
  onSettled: (_result, _error, _input, _onMutate, { client }) =>
    client.invalidateQueries({ queryKey: workspacePlanKeys.all }),
})

/** Refresh even after a partial failure so the owner sees what was actually applied. */
export const applyWorkspacePlanMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { id, ...payload }: WorkspacePlanDecision & { readonly id: string }) =>
      api.workspacePlans.apply({ params: { id }, payload }),
  }),
  onSettled: (_result, _error, _input, _onMutate, { client }) =>
    Promise.all([
      client.invalidateQueries({ queryKey: workspacePlanKeys.all }),
      client.invalidateQueries({ queryKey: sourceKeys.all }),
      client.invalidateQueries({ queryKey: routinesQuery.queryKey }),
      client.invalidateQueries({ queryKey: mcpKeys.servers }),
      client.invalidateQueries({ queryKey: mcpKeys.grants }),
    ]),
})
