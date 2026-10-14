import { mutationOptions } from '@tanstack/react-query'
import { account } from '../lib/api.ts'

/**
 * The account's inbound clients, answered by the Worker (`AccountApi`): keys are `['account', kind]`, and each change
 * refreshes what it changed before it settles.
 */
const accountKeys = {
  clients: ['account', 'clients'] as const,
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
