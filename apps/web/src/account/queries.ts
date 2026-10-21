import type { CreateApiKey, CreateWorkspace, UpdateApiKey, UpdateWorkspace } from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { account, workspaceAccount } from '../lib/api.ts'

/**
 * The person's workspaces (`AccountApi`), and this workspace's inbound clients and API keys (`WorkspaceAccountApi`),
 * answered by the Worker: keys are `['account', kind]`, and each change refreshes what it changed before it settles.
 * One page is one workspace's (ADR 0089), so its clients and keys need no workspace in their keys.
 */
const accountKeys = {
  workspaces: ['account', 'workspaces'] as const,
  clients: ['account', 'clients'] as const,
  keys: ['account', 'keys'] as const,
}

/** Every workspace the person belongs to, oldest first; a person with none is given one first. */
export const workspacesQuery = account.apiQuery({
  queryKey: accountKeys.workspaces,
  queryFn: (api) => api.workspaces.list(),
})

/** A new workspace with its own agent, the person its owner. */
export const createWorkspaceMutation = mutationOptions({
  ...account.apiMutation({ mutationFn: (api, payload: CreateWorkspace) => api.workspaces.create({ payload }) }),
  onSuccess: (_made, _payload, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.workspaces }),
})

/** A new name or slug for a workspace. */
export const updateWorkspaceMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, { workspaceId, ...payload }: UpdateWorkspace & { readonly workspaceId: string }) =>
      api.workspaces.update({ params: { workspaceId }, payload }),
  }),
  onSuccess: (_updated, _change, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.workspaces }),
})

/** Deletes a workspace and everything its agent holds. */
export const deleteWorkspaceMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, workspaceId: string) => api.workspaces.delete({ params: { workspaceId } }),
  }),
})

/** Chooses the workspace an OAuth client's sign-in in progress is for (the consent page's choice). */
export const selectWorkspaceMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, workspaceId: string) => api.workspaces.select({ params: { workspaceId } }),
  }),
})

/** The MCP clients the person let use this workspace's agent. */
export const clientsQuery = workspaceAccount.apiQuery({
  queryKey: accountKeys.clients,
  queryFn: (api) => api.clients.list(),
})

/** Ends one client's access at once. */
export const revokeClientMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, clientId: string) => api.clients.revoke({ params: { clientId } }),
  }),
  onSuccess: (_revoked, _clientId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.clients }),
})

/** The workspace's API keys, for servers it runs (ADR 0081), without secrets. */
export const keysQuery = workspaceAccount.apiQuery({ queryKey: accountKeys.keys, queryFn: (api) => api.keys.list() })

/** A new key; its answer holds the secret, which is never shown again. */
export const createKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, payload: CreateApiKey) => api.keys.create({ payload }) }),
  onSuccess: (_created, _payload, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** New scopes for one key (ADR 0084): the same key, which keeps what it made. */
export const updateKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, { keyId, ...payload }: UpdateApiKey & { readonly keyId: string }) =>
      api.keys.update({ params: { keyId }, payload }),
  }),
  onSuccess: (_updated, _change, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** Ends one key at once. */
export const revokeKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, keyId: string) => api.keys.revoke({ params: { keyId } }) }),
  onSuccess: (_revoked, _keyId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})
