import * as HttpApi from 'effect/http-api/HttpApi'
import { ClientErrorsGroup } from './client-errors.ts'
import { ClientsGroup } from './clients.ts'
import { KeysGroup } from './keys.ts'
import { WorkspacesGroup } from './workspaces.ts'

/**
 * What the Worker answers for a person, without waking an agent (ADR 0089): their workspaces, and client crash
 * reports.
 */
export class AccountApi extends HttpApi.make('goblin-account').add(WorkspacesGroup, ClientErrorsGroup).prefix('/api') {}

/**
 * What the Worker answers for a member of one workspace, under `/w/<workspace slug>` (ADR 0089), without waking its
 * agent: the workspace's API keys, and the OAuth clients the member connected to it.
 */
export class WorkspaceAccountApi extends HttpApi.make('goblin-workspace-account')
  .add(ClientsGroup, KeysGroup)
  .prefix('/api') {}
