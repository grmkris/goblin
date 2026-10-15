import type { ChatId, ModelEndpointInput } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { owner } from '../lib/api.ts'

/**
 * The agent itself, on the owner API: today's usage, its model and model endpoint, resident
 * authority and memory. Keys are `['agent', kind, input]`; each change settles once what it changed is fresh.
 */
const agentKeys = {
  usage: ['agent', 'usage'] as const,
  model: ['agent', 'model'] as const,
  endpoint: ['agent', 'model-endpoint'] as const,
  resident: ['agent', 'resident'] as const,
  memory: (chat: ChatId | undefined) => ['agent', 'memory', chat ?? null] as const,
}

/** Today's model tokens and the deployment's daily cap. */
export const usageQuery = owner.apiQuery({ queryKey: agentKeys.usage, queryFn: (api) => api.agent.usage() })

/** The owner's model and the ones the model endpoint in use offers. */
export const modelQuery = owner.apiQuery({ queryKey: agentKeys.model, queryFn: (api) => api.agent.model() })

/** Picks a model: shown at once, put back if the agent refuses it, then the agent's answer. */
export const chooseModelMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, model: string) => api.agent.chooseModel({ payload: { model } }),
  }),
  onMutate: async (model: string, { client }) => {
    await client.cancelQueries({ queryKey: agentKeys.model })
    const previous = client.getQueryData(modelQuery.queryKey)
    if (previous !== undefined) client.setQueryData(modelQuery.queryKey, { ...previous, current: model })
    return { previous }
  },
  onError: (_error, _model, result, { client }) => {
    if (result?.previous !== undefined) client.setQueryData(modelQuery.queryKey, result.previous)
  },
  onSuccess: (choice, _model, _result, { client }) => client.setQueryData(modelQuery.queryKey, choice),
})

/** Where the agent's model calls go (ADR 0059): the owner's own endpoint, its key never read back, else the deployment's. */
export const modelEndpointQuery = owner.apiQuery({
  queryKey: agentKeys.endpoint,
  queryFn: (api) => api.agent.modelEndpoint(),
})

/**
 * Sets the owner's own model endpoint, or goes back to the deployment's with null. The models on offer and today's
 * usage (whose cap holds on the deployment's endpoint only) follow it, so both are read again.
 */
export const changeModelEndpointMutation = mutationOptions({
  ...owner.apiMutation({
    mutationFn: (api, input: ModelEndpointInput | null) =>
      input === null ? api.agent.clearModelEndpoint() : api.agent.setModelEndpoint({ payload: input }),
  }),
  onSuccess: (view, _input, _result, { client }) => {
    client.setQueryData(modelEndpointQuery.queryKey, view)
    return Promise.all([
      client.invalidateQueries({ queryKey: agentKeys.model }),
      client.invalidateQueries({ queryKey: agentKeys.usage }),
    ])
  },
})

/** Resident authority (ADR 0003), renewed by the read itself. */
export const residentQuery = owner.apiQuery({
  queryKey: agentKeys.resident,
  queryFn: (api) => api.resident.status(),
})

/** Revokes resident authority or enables it again; the answer is the new status. */
export const setResidentMutation = mutationOptions({
  ...owner.apiMutation({ mutationFn: (api, enabled: boolean) => api.resident.set({ payload: { enabled } }) }),
  onSuccess: (status, _enabled, _result, { client }) => client.setQueryData(residentQuery.queryKey, status),
})

/** What the Conversation `chat` sits under remembers; Personal's without a chat (ADR 0032). */
export const memoryQuery = (chat?: ChatId) =>
  owner.apiQuery({
    queryKey: agentKeys.memory(chat),
    queryFn: (api) => api.memory.status({ query: chat === undefined ? {} : { chat } }),
  })
