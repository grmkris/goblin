import type {
  DeveloperApp,
  GrantTerms,
  InstallAnswer,
  InstallApproval,
  InstallDecline,
  InstallDeclined,
  InstallInfo,
  InstallationView,
  RegisterApp,
  RegisteredApp,
  RotatedAppSecret,
  WorkspaceView,
} from '@goblin/contracts'
import type { AppError } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import { narrowedTopics } from '../../auth/consent-terms.ts'
import {
  type InstallationChange,
  approveInstall,
  declineInstall,
  deleteApp,
  installInfo,
  installationsOfApp,
  listApps,
  listInstallations,
  registerApp,
  rotateAppSecret,
  uninstall,
  updateInstallation,
} from '../../auth/installs.ts'
import type { Person } from '../../auth/workspaces.ts'
import type { RuntimeEnv } from '../../env.ts'
import { attempt } from '../errors.ts'
import { endLeases, installed } from './leases.ts'

/**
 * The apps a workspace registered and the apps installed in it, and the install page's calls (ADR 0118), as the account
 * APIs answer them from the auth D1 (`auth/installs.ts`). An installation's Events leases end before its access does:
 * uninstalled, its app deleted, or its Topics narrowed.
 */
export interface AppRecords {
  readonly list: (workspaceId: string) => Effect.Effect<readonly DeveloperApp[], AppError>
  readonly register: (
    workspace: WorkspaceView,
    userId: string,
    headers: Headers,
    input: RegisterApp,
  ) => Effect.Effect<RegisteredApp, AppError>
  readonly rotate: (workspaceId: string, clientId: string) => Effect.Effect<RotatedAppSecret, AppError>
  readonly delete: (workspaceId: string, clientId: string) => Effect.Effect<void, AppError>
  readonly installations: (workspaceId: string) => Effect.Effect<readonly InstallationView[], AppError>
  readonly updateInstallation: (
    workspaceId: string,
    userId: string,
    id: string,
    terms: GrantTerms,
  ) => Effect.Effect<InstallationChange, AppError>
  readonly uninstall: (workspaceId: string, id: string) => Effect.Effect<void, AppError>
  readonly installInfo: (person: Person, clientId: string) => Effect.Effect<InstallInfo, AppError>
  readonly approveInstall: (
    person: Person,
    clientId: string,
    approval: InstallApproval,
  ) => Effect.Effect<InstallAnswer, AppError>
  readonly declineInstall: (clientId: string, decline: InstallDecline) => Effect.Effect<InstallDeclined, AppError>
}

/** The records as the deployment keeps them. */
export const appRecords = (env: RuntimeEnv): AppRecords => ({
  list: (workspaceId) => attempt(() => listApps(env, workspaceId)),
  register: (workspace, userId, headers, input) => attempt(() => registerApp(env, headers, workspace, userId, input)),
  rotate: (workspaceId, clientId) => attempt(() => rotateAppSecret(env, workspaceId, clientId)),
  delete: (workspaceId, clientId) =>
    Effect.gen(function* () {
      for (const each of yield* attempt(() => installationsOfApp(env, workspaceId, clientId)))
        yield* endLeases(env, each.workspaceId, installed(each.id))
      yield* attempt(() => deleteApp(env, workspaceId, clientId))
    }),
  installations: (workspaceId) => attempt(() => listInstallations(env, workspaceId)),
  updateInstallation: (workspaceId, userId, id, terms) =>
    Effect.tap(
      attempt(() => updateInstallation(env, workspaceId, userId, id, terms)),
      ({ before, after }) =>
        narrowedTopics(before.reach, after.terms.reach).length === 0
          ? Effect.void
          : endLeases(env, workspaceId, installed(id)),
    ),
  uninstall: (workspaceId, id) =>
    Effect.andThen(
      endLeases(env, workspaceId, installed(id)),
      attempt(() => uninstall(env, workspaceId, id)),
    ),
  installInfo: (person, clientId) => attempt(() => installInfo(env, person, clientId)),
  approveInstall: (person, clientId, approval) =>
    Effect.gen(function* () {
      const { answer, before } = yield* attempt(() => approveInstall(env, person, clientId, approval))
      const { installation } = answer
      if (before !== undefined && narrowedTopics(before.reach, installation.terms.reach).length > 0)
        yield* endLeases(env, approval.workspace, installed(installation.id))
      return answer
    }),
  declineInstall: (clientId, decline) => attempt(() => declineInstall(env, clientId, decline)),
})
