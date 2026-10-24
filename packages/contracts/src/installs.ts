import * as Schema from 'effect/Schema'
import { WorkspaceRole } from './account.ts'
import { ConsentTerms, GrantTerms } from './grants.ts'
import { NonEmptyString, WorkspaceId } from './ids.ts'

/**
 * Apps and installations (ADR 0118): a product registered by a workspace, as a confidential OAuth client, that a
 * workspace's owner or admin installs; what it may do there is the installation's grant. A script app is one with no
 * address to send people back to, installed only in the workspace that registered it.
 */

/** A registered OAuth client's id in a path or a body. */
export const AppClientId = Schema.String.check(Schema.isPattern(/^[\w.-]{1,200}$/u))

/** An installation's id (its grant's) in a path. */
export const InstallationId = Schema.String.check(Schema.isPattern(/^[\w-]{1,200}$/u))

/** An app's name, as its workspace registered it and the install page shows it. */
export const AppName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
  Schema.isPattern(/^\S(?:.*\S)?$/u),
)

/**
 * An address of an app's own: `https` only (the OAuth provider takes no other return address for a confidential client,
 * and a local run needs none: a script app has no return address). An install sends the person back
 * only to one the app registered.
 */
export const AppUrl = Schema.String.check(
  Schema.isMaxLength(2048),
  Schema.isPattern(/^https:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/u),
)

/**
 * `POST /w/<slug>/api/developer/apps`: an app the workspace registers. `terms` are what it asks for, which an install
 * starts from (their workspaces are the installer's to choose); `returnUrls` where an install may send the person back.
 * A script app (`script`) has none and is installed in this workspace in the same step, with `terms` as its grant.
 */
export const RegisterApp = Schema.Struct({
  name: AppName,
  homepage: Schema.optional(AppUrl),
  returnUrls: Schema.Array(AppUrl).check(Schema.isMaxLength(10)),
  terms: GrantTerms,
  script: Schema.optional(Schema.Boolean),
})
export type RegisterApp = typeof RegisterApp.Type

/** An app as its workspace's owners and admins see it: never its secret. */
export const DeveloperApp = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  homepage: Schema.optional(Schema.String),
  returnUrls: Schema.Array(Schema.String),
  terms: GrantTerms,
  script: Schema.Boolean,
  createdAt: Schema.String,
  installations: Schema.Int,
})
export type DeveloperApp = typeof DeveloperApp.Type

/**
 * An installation as the installed workspace's owners and admins see it: the app, who approved it and when, and its
 * grant (`grantId`, the installation's own id, and `terms`). `expiresAt` is when its grant ends; none until removed.
 */
export const InstallationView = Schema.Struct({
  id: Schema.String,
  clientId: Schema.String,
  name: Schema.String,
  homepage: Schema.optional(Schema.String),
  from: Schema.String,
  approvedBy: Schema.optional(Schema.String),
  createdAt: Schema.String,
  expiresAt: Schema.optional(Schema.String),
  grantId: Schema.String,
  terms: GrantTerms,
})
export type InstallationView = typeof InstallationView.Type

/** A new app and its client secret, which is shown this once; a script app's installation with it. */
export const RegisteredApp = Schema.Struct({
  app: DeveloperApp,
  clientSecret: Schema.String,
  installation: Schema.optional(InstallationView),
})
export type RegisteredApp = typeof RegisteredApp.Type

/** An app's new client secret, shown this once; the old one admits nothing from then on. */
export const RotatedAppSecret = Schema.Struct({ clientId: Schema.String, clientSecret: Schema.String })
export type RotatedAppSecret = typeof RotatedAppSecret.Type

/** `PATCH /w/<slug>/api/installations/:id`: the installation's grant's terms from now on. */
export const UpdateInstallation = Schema.Struct({ terms: GrantTerms })
export type UpdateInstallation = typeof UpdateInstallation.Type

/** A workspace a person may install an app in (one they own or administer), and whether it is installed there. */
export const InstallTarget = Schema.Struct({
  id: WorkspaceId,
  slug: Schema.String,
  name: Schema.String,
  role: WorkspaceRole,
  installed: Schema.Boolean,
})
export type InstallTarget = typeof InstallTarget.Type

/**
 * `GET /api/install/:clientId`: what the install page shows the signed-in person. The app as registered (`from` the
 * workspace that registered it), the workspaces they may install it in, and the grant editor's spec and defaults over
 * those workspaces, the defaults being what the app asks for.
 */
export const InstallInfo = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  homepage: Schema.optional(Schema.String),
  from: Schema.String,
  script: Schema.Boolean,
  workspaces: Schema.Array(InstallTarget),
  consent: ConsentTerms,
})
export type InstallInfo = typeof InstallInfo.Type

/**
 * `POST /api/install/:clientId`: install the app in `workspace` with `terms` as its grant (or give an installation
 * there new terms). `returnUrl`, one the app registered (its first when none is named), receives `installation`,
 * `workspace` (the slug) and `state` back.
 */
export const InstallApproval = Schema.Struct({
  workspace: WorkspaceId,
  terms: GrantTerms,
  state: Schema.optional(NonEmptyString(512)),
  returnUrl: Schema.optional(AppUrl),
})
export type InstallApproval = typeof InstallApproval.Type

/** An approved install: the installation, and where to send the person back (none for a script app). */
export const InstallAnswer = Schema.Struct({
  installation: InstallationView,
  redirect: Schema.optional(Schema.String),
})
export type InstallAnswer = typeof InstallAnswer.Type
