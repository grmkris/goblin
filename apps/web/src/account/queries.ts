import type { CreateApiKey } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { account } from '../lib/api.ts'

/**
 * The account's inbound clients and API keys, answered by the Worker (`AccountApi`): keys are `['account', kind]`, and
 * each change refreshes what it changed before it settles.
 */
const accountKeys = {
  clients: ['account', 'clients'] as const,
  keys: ['account', 'keys'] as const,
}

/** The MCP clients the owner let use their agent. */
export const clientsQuery = account.apiQuery({ queryKey: accountKeys.clients, queryFn: (api) => api.clients.list() })

/** Ends one client's access at once. */
export const revokeClientMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, clientId: string) => api.clients.revoke({ params: { clientId } }),
  }),
  onSuccess: (_revoked, _clientId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.clients }),
})

/** The API keys of servers the owner runs (ADR 0081), without secrets. */
export const keysQuery = account.apiQuery({ queryKey: accountKeys.keys, queryFn: (api) => api.keys.list() })

/** A new key; its answer holds the secret, which is never shown again. */
export const createKeyMutation = mutationOptions({
  ...account.apiMutation({ mutationFn: (api, payload: CreateApiKey) => api.keys.create({ payload }) }),
  onSuccess: (_created, _payload, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** Ends one key at once. */
export const revokeKeyMutation = mutationOptions({
  ...account.apiMutation({ mutationFn: (api, keyId: string) => api.keys.revoke({ params: { keyId } }) }),
  onSuccess: (_revoked, _keyId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})
