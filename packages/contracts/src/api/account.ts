import * as HttpApi from 'effect/http-api/HttpApi'
import { ClientErrorsGroup } from './client-errors.ts'
import { ClientsGroup } from './clients.ts'
import { InvitationsGroup } from './invitations.ts'
import { KeysGroup } from './keys.ts'
import { MembersGroup } from './members.ts'
import { WorkspacesGroup } from './workspaces.ts'

/**
 * What the Worker answers for a person, without waking an agent (ADRs 0089, 0093, 0097): their workspaces, the
 * invitations waiting for them, the MCP clients they connected and the workspaces each reaches, and client crash
 * reports.
 */
export class AccountApi extends HttpApi.make('goblin-account')
  .add(WorkspacesGroup, InvitationsGroup, ClientsGroup, ClientErrorsGroup)
  .prefix('/api') {}

/**
 * What the Worker answers for a member of one workspace, under `/w/<workspace slug>` (ADRs 0089, 0093), without waking
 * its agent: the workspace's API keys, and its members and invitations.
 */
export class WorkspaceAccountApi extends HttpApi.make('goblin-workspace-account')
  .add(KeysGroup, MembersGroup)
  .prefix('/api') {}
