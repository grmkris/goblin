import * as Schema from 'effect/Schema'
import * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import {
  AppClientId,
  DeveloperApp,
  InstallAnswer,
  InstallApproval,
  InstallDecline,
  InstallDeclined,
  InstallInfo,
  InstallationId,
  InstallationView,
  RegisterApp,
  RegisteredApp,
  RotatedAppSecret,
  UpdateInstallation,
} from '../installs.ts'
import { API_ERRORS } from './errors.ts'

/**
 * The apps a workspace registered (ADR 0118), served by the Worker for one of its owners and admins and never for a
 * credential. Paths are relative to the API's `/api` prefix, under `/w/<slug>`.
 *
 * - `list`: `GET /api/developer/apps`, every app the workspace registered, newest first, with how many workspaces
 *   installed it, never its secret.
 * - `register`: `POST /api/developer/apps`, 201 with the app and its client secret, which is never shown again; a script
 *   app with its installation in this workspace too.
 * - `rotate`: `POST /api/developer/apps/:clientId/rotate`, a new client secret, shown once; the old one admits nothing
 *   from then on, and tokens it got keep working until they end (an hour at most).
 * - `delete`: `DELETE /api/developer/apps/:clientId` ends the app and every installation of it, its Events leases
 *   first.
 */
export class DeveloperAppsGroup extends HttpApiGroup.make('developerApps').add(
  HttpApiEndpoint.get('list', '/developer/apps', { success: Schema.Array(DeveloperApp), error: API_ERRORS }),
  HttpApiEndpoint.post('register', '/developer/apps', {
    payload: RegisterApp,
    success: RegisteredApp.pipe(HttpApiSchema.status(201)),
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('rotate', '/developer/apps/:clientId/rotate', {
    params: { clientId: AppClientId },
    success: RotatedAppSecret,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('delete', '/developer/apps/:clientId', {
    params: { clientId: AppClientId },
    success: Schema.Struct({ deleted: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}

/**
 * The apps installed in a workspace (ADR 0118), served by the Worker for one of its owners and admins and never for a
 * credential. Paths are relative to the API's `/api` prefix, under `/w/<slug>`.
 *
 * - `list`: `GET /api/installations`, every app installed here, newest first, with its grant.
 * - `update`: `PATCH /api/installations/:id` gives the installation's grant new terms, within this workspace and the
 *   editor's role; narrowing its Topics ends its Events leases first.
 * - `uninstall`: `DELETE /api/installations/:id` ends the installation and its grant at once, its Events leases first.
 */
export class InstallationsGroup extends HttpApiGroup.make('installations').add(
  HttpApiEndpoint.get('list', '/installations', { success: Schema.Array(InstallationView), error: API_ERRORS }),
  HttpApiEndpoint.patch('update', '/installations/:id', {
    params: { id: InstallationId },
    payload: UpdateInstallation,
    success: InstallationView,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.delete('uninstall', '/installations/:id', {
    params: { id: InstallationId },
    success: Schema.Struct({ uninstalled: Schema.Literal(true) }),
    error: API_ERRORS,
  }),
) {}

/**
 * The install page's two calls (ADR 0118), for the signed-in person, answered by the Worker. Paths are relative to the
 * API's `/api` prefix.
 *
 * - `info`: `GET /api/install/:clientId`, the app and the workspaces the person may install it in (owner or admin),
 *   with the grant editor's spec and the terms it asks for. A script app is offered only its own workspace.
 * - `approve`: `POST /api/install/:clientId`, the installation in the workspace it names with those terms (made, or
 *   given the new terms), and the app's return address with `installation`, `workspace` and `state`. A workspace the
 *   person does not own or administer is `Forbidden` `role`.
 * - `decline`: `POST /api/install/:clientId/decline`, the person cancels: the app's return address with
 *   `error=access_denied` and `state`, as an OAuth refusal; nothing is written. A script app has none to go back to.
 */
export class InstallGroup extends HttpApiGroup.make('install').add(
  HttpApiEndpoint.get('info', '/install/:clientId', {
    params: { clientId: AppClientId },
    success: InstallInfo,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('approve', '/install/:clientId', {
    params: { clientId: AppClientId },
    payload: InstallApproval,
    success: InstallAnswer,
    error: API_ERRORS,
  }),
  HttpApiEndpoint.post('decline', '/install/:clientId/decline', {
    params: { clientId: AppClientId },
    payload: InstallDecline,
    success: InstallDeclined,
    error: API_ERRORS,
  }),
) {}
