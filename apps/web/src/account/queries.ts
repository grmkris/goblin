import type {
  ClientReach,
  CreateApiKey,
  CreateWorkspace,
  InviteMembers,
  UpdateApiKey,
  UpdateWorkspace,
  WorkspaceRole,
} from '@goblin/contracts'
import { mutationOptions } from '@tanstack/react-query'
import { account, workspaceAccount } from '../lib/api.ts'

/**
 * The person's workspaces and MCP clients (`AccountApi`), and this workspace's API keys and members
 * (`WorkspaceAccountApi`), answered by the Worker: keys are `['account', kind]`, and each change refreshes what it
 * changed before it settles. One page is one workspace's (ADR 0089), so its keys need no workspace in their keys.
 */
const accountKeys = {
  workspaces: ['account', 'workspaces'] as const,
  members: ['account', 'members'] as const,
  invitations: ['account', 'invitations'] as const,
  mine: ['account', 'invitations', 'mine'] as const,
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

/** The MCP clients the person let use goblin, with the workspaces each reaches (ADR 0097). */
export const clientsQuery = account.apiQuery({
  queryKey: accountKeys.clients,
  queryFn: (api) => api.clients.list(),
})

/** Which of the person's workspaces a client reaches: the consent page's choice first, Settings' change later. */
export const clientReachMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, { clientId, ...payload }: ClientReach & { readonly clientId: string }) =>
      api.clients.reach({ params: { clientId }, payload }),
  }),
  onSuccess: (_reach, _change, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.clients }),
})

/** Ends one client's access at once. */
export const revokeClientMutation = mutationOptions({
  ...account.apiMutation({
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

/** The workspace's members (ADR 0093), owners first. */
export const membersQuery = workspaceAccount.apiQuery({
  queryKey: accountKeys.members,
  queryFn: (api) => api.members.list(),
})

/** The workspace's invitations still waiting, for its owners and admins. */
export const invitationsQuery = workspaceAccount.apiQuery({
  queryKey: accountKeys.invitations,
  queryFn: (api) => api.members.invitations(),
})

/** Invitations for addresses, each mailed with its link. */
export const inviteMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, payload: InviteMembers) => api.members.invite({ payload }) }),
  onSuccess: (_sent, _payload, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.invitations }),
})

/** Withdraws an invitation. */
export const cancelInvitationMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, id: string) => api.members.cancel({ params: { id } }) }),
  onSuccess: (_canceled, _id, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.invitations }),
})

/** Mails an invitation again, for seven days from now. */
export const resendInvitationMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, id: string) => api.members.resend({ params: { id } }) }),
  onSuccess: (_sent, _id, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.invitations }),
})

/** A member's new role. */
export const updateMemberMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, { userId, role }: { readonly userId: string; readonly role: WorkspaceRole }) =>
      api.members.update({ params: { userId }, payload: { role } }),
  }),
  onSuccess: (_member, _change, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.members }),
})

/** Ends a member's membership. */
export const removeMemberMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, userId: string) => api.members.remove({ params: { userId } }) }),
  onSuccess: (_removed, _userId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.members }),
})

/** Ends the person's own membership of this workspace. */
export const leaveWorkspaceMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, _: void) => api.members.leave() }),
})

/** The invitations waiting for the signed-in person's address. */
export const myInvitationsQuery = account.apiQuery({
  queryKey: accountKeys.mine,
  queryFn: (api) => api.invitations.mine(),
})

/** One invitation, as its link shows it; it needs no session. */
export const invitationQuery = (id: string) => ({
  ...account.apiQuery({
    queryKey: ['account', 'invitation', id] as const,
    queryFn: (api) => api.invitations.preview({ params: { id } }),
  }),
  meta: { auth: 'optional' as const },
})

/** Joins the workspace an invitation is for; the workspace joined. */
export const acceptInvitationMutation = mutationOptions({
  ...account.apiMutation({ mutationFn: (api, id: string) => api.invitations.accept({ params: { id } }) }),
})

/** Turns an invitation down. */
export const declineInvitationMutation = mutationOptions({
  ...account.apiMutation({ mutationFn: (api, id: string) => api.invitations.decline({ params: { id } }) }),
  onSuccess: (_declined, _id, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.mine }),
})
