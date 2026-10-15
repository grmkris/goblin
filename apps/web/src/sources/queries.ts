import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import type { SourceProposal, SourceRoute } from '@goblin/contracts'
import { owner } from '../lib/api.ts'
import { withOperation } from '../lib/query/api-query.ts'
import { mcpKeys } from '../mcp/queries.ts'

/**
 * The owner's Sources on the owner API (ADR 0066): every Source with the conversations waiting for a route, and one
 * Source's route table. Keys are `['sources', kind, input]`. A confirm or refuse names the exact revision the owner
 * reviewed; each change settles once the list (and what it touched) is fresh.
 */
export const sourceKeys = {
  all: ['sources'] as const,
  list: ['sources', 'list'] as const,
  routes: (id: string) => ['sources', 'routes', id] as const,
}

/** Every Source, newest first, each with the conversations waiting for a route. */
export const sourcesQuery = owner.apiQuery({ queryKey: sourceKeys.list, queryFn: (api) => api.sources.list() })

/** The Sources as they are now, for a proposal's review: nothing until `open`, then never a cached list. */
export const reviewedSourcesQuery = (open: boolean) =>
  queryOptions({ queryKey: sourceKeys.list, queryFn: open ? sourcesQuery.queryFn : skipToken, staleTime: 0 })

/** One Source's conversations and where each goes; nothing is read for no Source. */
export const sourceRoutesQuery = (id: string | undefined) =>
  queryOptions({
    queryKey: sourceKeys.routes(id ?? ''),
    queryFn:
      id === undefined
        ? skipToken
        : owner.apiQuery({
            queryKey: sourceKeys.routes(id),
            queryFn: (api) => api.sources.routes({ params: { id } }),
          }).queryFn,
  })

/** Every read of the Sources, the list and each route table: what a change touched. */
const sourcesChanged = (client: QueryClient) => client.invalidateQueries({ queryKey: sourceKeys.all })

/** Proposes a Source from what a server suggests; it runs only once the owner confirms its revision. */
export const proposeSourceMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, proposal: SourceProposal) =>
      withOperation(proposal.operationId)(api.sources.propose({ payload: proposal })),
  }),
  onSuccess: (_source, _proposal, _result, { client }) => sourcesChanged(client),
})

/**
 * What the owner does to a Source: confirm or refuse the exact revision they reviewed, pause, resume (bound again to
 * its connection's endpoint and grants now) or remove it.
 */
export type SourceChange =
  | { readonly action: 'confirm' | 'refuse'; readonly id: string; readonly revision: number }
  | { readonly action: 'pause' | 'resume' | 'remove'; readonly id: string }

export const changeSourceMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, change: SourceChange) => {
      const params = { id: change.id }
      switch (change.action) {
        case 'confirm':
          return api.sources.confirm({ params, payload: { revision: change.revision } })
        case 'refuse':
          return api.sources.refuse({ params, payload: { revision: change.revision } })
        case 'pause':
          return api.sources.pause({ params })
        case 'resume':
          return api.sources.resume({ params })
        case 'remove':
          return api.sources.remove({ params })
      }
    },
  }),
  onSuccess: async (_answer, { action }, _result, { client }) => {
    await sourcesChanged(client)
    // Confirming or resuming grants the Source's event and tools and answers its connection's offer of events.
    if (action === 'confirm' || action === 'resume')
      await Promise.all([
        client.invalidateQueries({ queryKey: mcpKeys.servers }),
        client.invalidateQueries({ queryKey: mcpKeys.grants }),
      ])
  },
})

/** Where one conversation of a Source goes now; what it held goes there in order, and Activity shows the receipt. */
export type SourceRouteChange = { readonly id: string; readonly key: string; readonly route: SourceRoute }

export const routeSourceMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, { id, key, route }: SourceRouteChange) =>
      api.sources.route({ params: { id }, payload: { key, route } }),
  }),
  onSuccess: (_route, _change, _result, { client }) => sourcesChanged(client),
})
