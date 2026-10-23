import type { CreateTrustedWorkload } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { workspaceAccount } from '../lib/api.ts'

const KEY = ['account', 'trusted-workloads'] as const

/** Workspace trust policies, without assertions or access tokens. */
export const trustedWorkloadsQuery = workspaceAccount.apiQuery({
  queryKey: KEY,
  queryFn: (api) => api.trustedWorkloads.list(),
})

export const createTrustedWorkloadMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, payload: CreateTrustedWorkload) => api.trustedWorkloads.create({ payload }),
  }),
  onSuccess: (_saved, _input, _result, { client }) => client.invalidateQueries({ queryKey: KEY }),
})

export const disableTrustedWorkloadMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, id: string) => api.trustedWorkloads.disable({ params: { id } }),
  }),
  onSuccess: (_saved, _id, _result, { client }) => client.invalidateQueries({ queryKey: KEY }),
})
