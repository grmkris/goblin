import * as Layer from 'effect/Layer'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { AccountApi, WorkspaceAccountApi } from '@goblin/contracts/api'
import {
  ClientErrorsHandlers,
  ClientsHandlers,
  GrantsHandlers,
  InvitationsHandlers,
  KeysHandlers,
  MembersHandlers,
  WorkspacesHandlers,
} from './account.ts'
import { DeveloperAppsHandlers, InstallHandlers, InstallationsHandlers } from './app-handlers.ts'

/** The account API's routes, served by the Worker (`edge.ts`). */
export const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([
    WorkspacesHandlers,
    InvitationsHandlers,
    ClientsHandlers,
    GrantsHandlers,
    InstallHandlers,
    ClientErrorsHandlers,
  ]),
  Layer.provide(HttpServer.layerServices),
)

/** The workspace account API's routes, served by the Worker for a member (`edge.ts`). */
export const WorkspaceAccountApiLayer = HttpApiBuilder.layer(WorkspaceAccountApi).pipe(
  Layer.provide([KeysHandlers, MembersHandlers, DeveloperAppsHandlers, InstallationsHandlers]),
  Layer.provide(HttpServer.layerServices),
)
