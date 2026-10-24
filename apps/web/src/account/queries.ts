import type {
  CreateApiKeyTerms,
  CreateWorkspace,
  GrantTerms,
  InstallApproval,
  InviteMembers,
  RegisterApp,
  UpdateWorkspace,
  WorkspaceRole,
} from '@goblin/contracts'
import { type QueryClient, mutationOptions, queryOptions, skipToken } from '@tanstack/react-query'
import * as Effect from 'effect/Effect'
import { account, inWorkspaceOf, owner, workspaceAccount } from '../lib/api.ts'

/**
 * The person's workspaces, MCP clients and the grants they approve (`AccountApi`), and this workspace's API keys and
 * members (`WorkspaceAccountApi`), answered by the Worker: keys are `['account', kind]`, and each change refreshes what
 * it changed before it settles. One page is one workspace's (ADR 0089), so its keys need no workspace in their keys.
 */
const accountKeys = {
  workspaces: ['account', 'workspaces'] as const,
  members: ['account', 'members'] as const,
  invitations: ['account', 'invitations'] as const,
  mine: ['account', 'invitations', 'mine'] as const,
  clients: ['account', 'clients'] as const,
  keys: ['account', 'keys'] as const,
  apps: ['account', 'apps'] as const,
  installations: ['account', 'installations'] as const,
  install: (clientId: string) => ['account', 'install', clientId] as const,
  clientTerms: (clientId: string) => ['account', 'clients', clientId, 'terms'] as const,
  grantTerms: (grantId: string) => ['account', 'grants', grantId, 'terms'] as const,
  reach: (slug: string, kind: 'topics' | 'personas' | 'connections') => ['account', 'reach', slug, kind] as const,
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

/**
 * What the consent page shows for an MCP client (ADR 0114): the default chain's terms and, once it has a grant, its
 * current terms.
 */
export const clientTermsQuery = (clientId: string) =>
  account.apiQuery({
    queryKey: accountKeys.clientTerms(clientId),
    queryFn: (api) => api.grants.clientTerms({ params: { clientId } }),
  })

/**
 * The person's terms for an MCP client: on the consent page before its consent, from Settings later. A live token
 * follows them at once.
 */
export const clientGrantMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, { clientId, terms }: { readonly clientId: string; readonly terms: GrantTerms }) =>
      api.grants.clientGrant({ params: { clientId }, payload: { terms } }),
  }),
  onSuccess: (_saved, { clientId }, _result, { client }) =>
    Promise.all([
      client.invalidateQueries({ queryKey: accountKeys.clients }),
      client.invalidateQueries({ queryKey: accountKeys.clientTerms(clientId) }),
    ]),
})

/** What the widening page shows for a live grant the person may approve: its terms now, and its summary. */
export const grantTermsQuery = (grantId: string) =>
  account.apiQuery({
    queryKey: accountKeys.grantTerms(grantId),
    queryFn: (api) => api.grants.terms({ params: { id: grantId } }),
  })

/** Saves the terms the person approved for a grant: a key's or an MCP client's, whichever it is. */
export const widenGrantMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, { grantId, terms }: { readonly grantId: string; readonly terms: GrantTerms }) =>
      api.grants.widen({ params: { id: grantId }, payload: { grantId, terms } }),
  }),
  onSuccess: (_saved, { grantId }, _result, { client }) => grantsChanged(client, grantId),
})

/** Every read a grant's new terms change: its own, and the keys, clients and installations that show them. */
const grantsChanged = (client: QueryClient, grantId: string) =>
  Promise.all([
    client.invalidateQueries({ queryKey: accountKeys.grantTerms(grantId) }),
    client.invalidateQueries({ queryKey: accountKeys.keys }),
    client.invalidateQueries({ queryKey: accountKeys.clients }),
    client.invalidateQueries({ queryKey: accountKeys.installations }),
  ])

/** Ends one client's access at once. */
export const revokeClientMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, clientId: string) => api.clients.revoke({ params: { clientId } }),
  }),
  onSuccess: (_revoked, _clientId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.clients }),
})

/** The workspace's API keys, for servers it runs (ADR 0081), without secrets. */
export const keysQuery = workspaceAccount.apiQuery({ queryKey: accountKeys.keys, queryFn: (api) => api.keys.list() })

/** A new key and its grant's terms (ADR 0114); its answer holds the secret, which is never shown again. */
export const createKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, payload: CreateApiKeyTerms) => api.keys.create({ payload }) }),
  onSuccess: (_created, _payload, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** New terms for one key's grant (ADR 0114): the same key, with its id and secret. */
export const updateKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, { keyId, terms }: { readonly keyId: string; readonly terms: GrantTerms }) =>
      api.keys.update({ params: { keyId }, payload: { terms } }),
  }),
  onSuccess: (_updated, _change, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/**
 * A new secret for one key (ADR 0105): the same key, which keeps what it made; its answer holds the secret, which is
 * never shown again, and the old one is refused from then on.
 */
export const rotateKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, keyId: string) => api.keys.rotate({ params: { keyId } }) }),
  onSuccess: (_rotated, _keyId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** Ends one key at once. */
export const revokeKeyMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, keyId: string) => api.keys.revoke({ params: { keyId } }) }),
  onSuccess: (_revoked, _keyId, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.keys }),
})

/** The apps this workspace registered (ADR 0118), newest first, without secrets. */
export const developerAppsQuery = workspaceAccount.apiQuery({
  queryKey: accountKeys.apps,
  queryFn: (api) => api.developerApps.list(),
})

/** A new app; its answer holds the client secret, never shown again (and a script app's installation). */
export const registerAppMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, payload: RegisterApp) => api.developerApps.register({ payload }),
  }),
  onSuccess: (_made, _payload, _result, { client }) =>
    Promise.all([
      client.invalidateQueries({ queryKey: accountKeys.apps }),
      client.invalidateQueries({ queryKey: accountKeys.installations }),
    ]),
})

/** A new client secret for one app, shown once; the old one is refused from then on. */
export const rotateAppMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, clientId: string) => api.developerApps.rotate({ params: { clientId } }),
  }),
})

/** Ends one app and every installation of it. */
export const deleteAppMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, clientId: string) => api.developerApps.delete({ params: { clientId } }),
  }),
  onSuccess: (_deleted, _clientId, _result, { client }) =>
    Promise.all([
      client.invalidateQueries({ queryKey: accountKeys.apps }),
      client.invalidateQueries({ queryKey: accountKeys.installations }),
    ]),
})

/** The apps installed in this workspace (ADR 0118), each with its grant. */
export const installationsQuery = workspaceAccount.apiQuery({
  queryKey: accountKeys.installations,
  queryFn: (api) => api.installations.list(),
})

/** New terms for one installation's grant. */
export const updateInstallationMutation = mutationOptions({
  ...workspaceAccount.apiMutation({
    mutationFn: (api, { id, terms }: { readonly id: string; readonly terms: GrantTerms }) =>
      api.installations.update({ params: { id }, payload: { terms } }),
  }),
  onSuccess: (_updated, _change, _result, { client }) =>
    client.invalidateQueries({ queryKey: accountKeys.installations }),
})

/** Ends one installation at once. */
export const uninstallMutation = mutationOptions({
  ...workspaceAccount.apiMutation({ mutationFn: (api, id: string) => api.installations.uninstall({ params: { id } }) }),
  onSuccess: (_removed, _id, _result, { client }) => client.invalidateQueries({ queryKey: accountKeys.installations }),
})

/** What the install page shows for an app: the app, where the person may install it, and its grant's defaults. */
export const installInfoQuery = (clientId: string) =>
  account.apiQuery({
    queryKey: accountKeys.install(clientId),
    queryFn: (api) => api.install.info({ params: { clientId } }),
  })

/** Installs an app with the terms the person approved; the answer says where to send them back. */
export const approveInstallMutation = mutationOptions({
  ...account.apiMutation({
    mutationFn: (api, { clientId, ...payload }: InstallApproval & { readonly clientId: string }) =>
      api.install.approve({ params: { clientId }, payload }),
  }),
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

/** One thing a grant's editor offers to pick: its reach id within its kind, its name and a line about it. */
export type ReachItemView = { readonly id: string; readonly label: string; readonly description?: string }

/** The owner API's client, as a reader of one workspace's lists takes it. */
type OwnerClient = Parameters<Parameters<typeof owner.run>[0]>[0]

/** Each kind's list in one workspace, as the editor picks from it: its reach id, name and a line. */
const READERS: Readonly<
  Record<'topics' | 'personas' | 'connections', (api: OwnerClient) => Effect.Effect<readonly ReachItemView[], Error>>
> = {
  // The latest hundred still open; the editor searches them.
  topics: (api) =>
    Effect.map(api.topics.list({ query: { limit: 100 } }), ({ topics }) =>
      topics.filter((topic) => !topic.archived).map((topic) => ({ id: String(topic.id), label: topic.name })),
    ),
  // The latest hundred still answering, with their roles.
  personas: (api) =>
    Effect.map(api.personas.list({ query: { limit: 100 } }), ({ personas }) =>
      personas
        .filter((persona) => persona.archivedAt === undefined)
        .map((persona) => ({ id: String(persona.id), label: persona.name, description: persona.role })),
    ),
  // By the owner's names for them.
  connections: (api) =>
    Effect.map(api.mcp.servers(), (servers) =>
      servers.map((server) => ({ id: server.connectionId, label: server.label })),
    ),
}

/**
 * What a grant may reach of one kind in the workspace at `slug` (ADR 0114), for its editor to pick from: its Topics,
 * Personas or MCP connections, read from that workspace's agent whichever page asks, and only once `open` (the
 * editor is picking).
 */
export const reachItemsQuery = (slug: string, kind: 'topics' | 'personas' | 'connections', open: boolean) =>
  queryOptions({
    queryKey: accountKeys.reach(slug, kind),
    queryFn: open
      ? ({ signal }) => owner.run((api) => READERS[kind](api).pipe(inWorkspaceOf(slug)), signal)
      : skipToken,
  })
