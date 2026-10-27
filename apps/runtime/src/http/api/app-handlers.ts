import * as Effect from 'effect/Effect'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import type { GrantTerms } from '@goblin/contracts'
import { AccountApi, WorkspaceAccountApi } from '@goblin/contracts/api'
import { logEvent } from '../../observability/logger.ts'
import { AccountRequest, manager, powerOf, quoted, signedIn } from './account.ts'

/**
 * One `app` audit line for a manager's change to an app or an installation (ADR 0118): the app's client or the
 * installation, the workspace, who did it, what they did and the request's reference; for a grant, its level and extras
 * before and after. Never a secret, a name or a reach id.
 */
const auditApp = (
  fields: { readonly id: string; readonly agent: string; readonly by: string; readonly kind: string },
  terms?: { readonly before: GrantTerms; readonly after: GrantTerms },
) =>
  logEvent('info', 'app', {
    ...fields,
    ...(terms === undefined ? {} : { scopes: powerOf(terms.after), 'scopes.before': powerOf(terms.before) }),
  })

/** The apps a workspace registered (ADR 0118), for its owners and admins; each change audited (`auditApp`). */
export const DeveloperAppsHandlers = HttpApiBuilder.group(WorkspaceAccountApi, 'developerApps', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(manager, ({ records, workspace }) => records.apps.list(workspace.id))))
    .handle('register', ({ payload }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person, workspace } = yield* manager
          const { headers } = yield* AccountRequest
          const registered = yield* records.apps.register(workspace, person.id, headers, payload)
          yield* auditApp({ id: registered.app.clientId, agent: workspace.id, by: person.id, kind: 'registered' })
          return registered
        }),
      ),
    )
    .handle('rotate', ({ params }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person, workspace } = yield* manager
          const rotated = yield* records.apps.rotate(workspace.id, params.clientId)
          yield* auditApp({ id: params.clientId, agent: workspace.id, by: person.id, kind: 'secret' })
          return rotated
        }),
      ),
    )
    .handle('delete', ({ params }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person, workspace } = yield* manager
          yield* records.apps.delete(workspace.id, params.clientId)
          yield* auditApp({ id: params.clientId, agent: workspace.id, by: person.id, kind: 'deleted' })
          return { deleted: true as const }
        }),
      ),
    ),
)

/** The apps installed in a workspace (ADR 0118), for its owners and admins; each change audited (`auditApp`). */
export const InstallationsHandlers = HttpApiBuilder.group(WorkspaceAccountApi, 'installations', (handlers) =>
  handlers
    .handle('list', () =>
      quoted(Effect.flatMap(manager, ({ records, workspace }) => records.apps.installations(workspace.id))),
    )
    .handle('update', ({ params, payload }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person, workspace } = yield* manager
          const { before, after } = yield* records.apps.updateInstallation(
            workspace.id,
            person.id,
            params.id,
            payload.terms,
          )
          yield* auditApp(
            { id: params.id, agent: workspace.id, by: person.id, kind: 'grant' },
            { before, after: after.terms },
          )
          return after
        }),
      ),
    )
    .handle('uninstall', ({ params }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person, workspace } = yield* manager
          yield* records.apps.uninstall(workspace.id, params.id)
          yield* auditApp({ id: params.id, agent: workspace.id, by: person.id, kind: 'uninstalled' })
          return { uninstalled: true as const }
        }),
      ),
    ),
)

/** The install page's calls (ADR 0118), for the signed-in person; an approval audited (`auditApp`), a decline writes nothing. */
export const InstallHandlers = HttpApiBuilder.group(AccountApi, 'install', (handlers) =>
  handlers
    .handle('info', ({ params }) =>
      quoted(Effect.flatMap(signedIn, ({ records, person }) => records.apps.installInfo(person, params.clientId))),
    )
    .handle('approve', ({ params, payload }) =>
      quoted(
        Effect.gen(function* () {
          const { records, person } = yield* signedIn
          const answer = yield* records.apps.approveInstall(person, params.clientId, payload)
          yield* auditApp({ id: answer.installation.id, agent: payload.workspace, by: person.id, kind: 'installed' })
          return answer
        }),
      ),
    )
    .handle('decline', ({ params, payload }) =>
      quoted(Effect.flatMap(signedIn, ({ records }) => records.apps.declineInstall(params.clientId, payload))),
    ),
)
