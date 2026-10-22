import { AccountApi, type AppError, WorkspaceAccountApi, withRef } from '@goblin/contracts/api'
import type {
  ApiKeyView,
  ClientErrorReport,
  ClientReach,
  CreateApiKey,
  CreatedApiKey,
  CreateWorkspace,
  InboundClient,
  UpdateApiKey,
  UpdateWorkspace,
  WorkspaceView,
} from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { type KeyChange, createKey, listKeys, revokeKey, updateKey } from '../../auth/api-keys.ts'
import { listInboundClients, revokeInboundClient, setClientReach } from '../../auth/clients.ts'
import { deleteAgentOf } from '../../auth/account.ts'
import { type Person, createWorkspace, deleteWorkspace, updateWorkspace, workspacesOf } from '../../auth/workspaces.ts'
import type { RuntimeEnv } from '../../env.ts'
import { logEvent } from '../../observability/logger.ts'
import { reportAndRecover } from '../../observability/report.ts'
import { FlowPointFailure, agentHash, flowPoint } from '../../observability/ae.ts'
import { Forbidden, Unauthenticated, attempt } from '../errors.ts'
import { RequestContext } from './context.ts'
import { type MemberRecords, memberRecords } from './member-records.ts'

/** The account's own records the Worker answers from: auth D1 and Analytics Engine, never an agent. */
export interface AccountRecords {
  /** Workspaces' members and invitations, and a person's invitations (ADR 0093). */
  readonly members: MemberRecords
  /** The person's workspaces (ADR 0089), a first one made when they have none. */
  readonly workspaces: (person: Person) => Effect.Effect<readonly WorkspaceView[], AppError>
  readonly createWorkspace: (userId: string, input: CreateWorkspace) => Effect.Effect<WorkspaceView, AppError>
  readonly updateWorkspace: (
    userId: string,
    workspaceId: string,
    change: UpdateWorkspace,
  ) => Effect.Effect<WorkspaceView, AppError>
  readonly deleteWorkspace: (userId: string, workspaceId: string) => Effect.Effect<void, AppError>
  /** The MCP clients a person connected, the workspaces each reaches, and changing or ending that (ADR 0097). */
  readonly clients: (userId: string) => Effect.Effect<readonly InboundClient[], AppError>
  readonly setClientReach: (
    person: Person,
    clientId: string,
    reach: ClientReach,
  ) => Effect.Effect<ClientReach, AppError>
  readonly revokeClient: (userId: string, clientId: string) => Effect.Effect<void, AppError>
  /** A workspace's API keys (ADRs 0081, 0089), and making and ending one. */
  readonly keys: (workspaceId: string) => Effect.Effect<readonly ApiKeyView[], AppError>
  readonly createKey: (
    workspaceId: string,
    userId: string,
    input: CreateApiKey,
  ) => Effect.Effect<CreatedApiKey, AppError>
  /** New scopes for one of the workspace's keys (ADR 0084), before and after. */
  readonly updateKey: (
    workspaceId: string,
    userId: string,
    keyId: string,
    change: UpdateApiKey,
  ) => Effect.Effect<KeyChange, AppError>
  readonly revokeKey: (workspaceId: string, keyId: string) => Effect.Effect<void, AppError>
  /**
   * A browser crash's `client_error` flow point (ADR 0037), under the hash of the person when the report came with a
   * session; nothing without the `FLOWS` binding.
   */
  readonly crash: (report: ClientErrorReport, userId: Option.Option<string>) => Effect.Effect<void, FlowPointFailure>
}

/**
 * The `client_error` flow step of a crash report: the browser's user, through the app, ended in an error of the
 * report's type. Content-free (ADR 0024): no route, frames or reference.
 */
const crashStep = (report: ClientErrorReport): FlowEvent => ({
  flow: 'client_error',
  via: 'app',
  actor: 'owner',
  status: 'error',
  errorType: report.name,
})

/**
 * Its Analytics Engine point (`observability/ae.ts`'s layout), with the report's own build. A report needs no session:
 * with one it is indexed by the agent's hash, without one it has no index.
 */
export const crashPoint = (
  report: ClientErrorReport,
  agent: string | undefined,
  stage: string,
): AnalyticsEngineDataPoint => {
  const point = flowPoint(crashStep(report), agent ?? '', { stage, build: report.build })
  return agent === undefined ? { ...point, indexes: [] } : point
}

/** The records as the deployment keeps them. */
export const accountRecords = (env: RuntimeEnv): AccountRecords => {
  const flows = env.FLOWS
  return {
    members: memberRecords(env),
    crash: (report, userId) =>
      flows === undefined
        ? Effect.void
        : Effect.gen(function* () {
            const agent = Option.isSome(userId) ? yield* agentHash(env.CREDENTIAL_KEY, userId.value) : undefined
            yield* Effect.try({
              try: () => flows.writeDataPoint(crashPoint(report, agent, env.STAGE ?? 'local')),
              catch: (cause) => new FlowPointFailure({ step: 'write', cause }),
            })
          }),
    workspaces: (person) => attempt(() => workspacesOf(env.AUTH_DB, person, new Date())),
    createWorkspace: (userId, input) => attempt(() => createWorkspace(env.AUTH_DB, userId, input, new Date())),
    updateWorkspace: (userId, workspaceId, change) =>
      attempt(() => updateWorkspace(env.AUTH_DB, userId, workspaceId, change)),
    deleteWorkspace: (userId, workspaceId) =>
      attempt(() =>
        deleteWorkspace({ db: env.AUTH_DB, eraseAgent: (id) => deleteAgentOf(env, id) }, userId, workspaceId),
      ),
    clients: (userId) => attempt(() => listInboundClients(env, userId)),
    setClientReach: (person, clientId, reach) => attempt(() => setClientReach(env, person, clientId, reach)),
    revokeClient: (userId, clientId) => attempt(() => revokeInboundClient(env, userId, clientId)),
    keys: (workspaceId) => attempt(() => listKeys(env, workspaceId)),
    createKey: (workspaceId, userId, input) => attempt(() => createKey(env, workspaceId, userId, input)),
    updateKey: (workspaceId, userId, keyId, change) =>
      attempt(() => updateKey(env, workspaceId, userId, keyId, change)),
    revokeKey: (workspaceId, keyId) => attempt(() => revokeKey(env, workspaceId, keyId)),
  }
}

/**
 * What one account request carries past the edge's admission: the records, the signed-in person when the endpoint
 * needs one (every endpoint but a client error report), and for the workspace account API the workspace in the path
 * with the person's role in it.
 */
export class AccountRequest extends Context.Service<
  AccountRequest,
  {
    readonly records: AccountRecords
    readonly person: Option.Option<Person>
    readonly workspace: Option.Option<WorkspaceView>
    /** The request's own headers, which carry its session: only choosing a sign-in's workspace reads them. */
    readonly headers: Headers
  }
>()('goblin/http/AccountRequest') {}

/** The signed-in person. Admission has checked the session already; this only says so to the types. */
const signedIn = AccountRequest.use(({ records, person }) =>
  Option.match(person, {
    onNone: () => Effect.fail(new Unauthenticated({ reason: 'session required' })),
    onSome: (signed) => Effect.succeed({ records, person: signed }),
  }),
)

/** The member and the workspace of the path. Admission has checked the membership already. */
const member = Effect.flatMap(signedIn, ({ records, person }) =>
  AccountRequest.use(({ workspace }) =>
    Option.match(workspace, {
      onNone: () => Effect.fail(new Unauthenticated({ reason: 'session required' })),
      onSome: (current) => Effect.succeed({ records, person, workspace: current }),
    }),
  ),
)

/** The member, when they are one of the workspace's owners or admins: who manage its keys and members. */
const manager = Effect.flatMap(member, (admitted) =>
  admitted.workspace.role === 'member' ? Effect.fail(new Forbidden({ reason: 'role' })) : Effect.succeed(admitted),
)

/** `self`, its failure quoting the request's reference, as owner admission quotes it. */
const quoted = <A, E extends AppError, R>(self: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(RequestContext), (context) => {
    const ref = Option.getOrUndefined(context)?.ref
    if (ref === undefined) return self
    return Effect.catch(self, (error) =>
      // SAFETY: stamping the reference keeps the failure's class and fields, so it is still the `E` it was.
      Effect.flatMap(withRef(ref)(error), (stamped) => Effect.fail(stamped as E)),
    )
  })

/** Frame locations as the browser sent them, without query or fragment. */
const location = (frame: string): string => frame.replace(/[?#][^\s]*?(?=:\d{1,7}:\d{1,7}$)/u, '')

/** One content-free line per crash report (ADR 0024), then its flow point; a point that fails is reported, not answered. */
const takeReport = (report: ClientErrorReport) =>
  Effect.andThen(
    logReport(report),
    AccountRequest.use(({ records, person }) =>
      records.crash(
        report,
        Option.map(person, (signed) => signed.id),
      ),
    ).pipe(reportAndRecover('http.clientErrors', undefined)),
  )

const logReport = (report: ClientErrorReport) =>
  logEvent('warn', 'client_error', {
    route: report.route,
    name: report.name,
    frames: report.frames.map(location),
    build: report.build,
    ...(report.ref === undefined ? {} : { ref: report.ref }),
  })

const WorkspacesHandlers = HttpApiBuilder.group(AccountApi, 'workspaces', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(signedIn, ({ records, person }) => records.workspaces(person))))
    .handle('create', ({ payload }) =>
      quoted(Effect.flatMap(signedIn, ({ records, person }) => records.createWorkspace(person.id, payload))),
    )
    .handle('update', ({ params, payload }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          records.updateWorkspace(person.id, params.workspaceId, payload),
        ),
      ),
    )
    .handle('delete', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          Effect.as(records.deleteWorkspace(person.id, params.workspaceId), { deleted: true as const }),
        ),
      ),
    ),
)

/** A person's MCP clients and the workspaces each reaches (ADR 0097): theirs alone, whatever workspace they are in. */
const ClientsHandlers = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(signedIn, ({ records, person }) => records.clients(person.id))))
    .handle('reach', ({ params, payload }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) => records.setClientReach(person, params.clientId, payload)),
      ),
    )
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          Effect.as(records.revokeClient(person.id, params.clientId), { revoked: true as const }),
        ),
      ),
    ),
)

/**
 * A key's new scopes (ADR 0084) or MCP origins (ADR 0091), as a manager's change of it is audited: one `api_key` line
 * for each it changed, with the key, the workspace, who changed it and the request's reference; for scopes they before
 * and after, for origins how many there were and are. Never its secret, and no origin or tool name.
 */
const changeKey = (keyId: string, change: UpdateApiKey) =>
  Effect.gen(function* () {
    const { records, person, workspace } = yield* manager
    const { before, after } = yield* records.updateKey(workspace.id, person.id, keyId, change)
    const line = { id: keyId, agent: workspace.id, by: person.id }
    if (change.scopes !== undefined)
      yield* logEvent('info', 'api_key', {
        ...line,
        kind: 'scopes',
        scopes: after.scopes,
        'scopes.before': before.scopes,
      })
    if (change.origins !== undefined)
      yield* logEvent('info', 'api_key', { ...line, kind: 'origins', count: after.origins.length })
    return after
  })

const KeysHandlers = HttpApiBuilder.group(WorkspaceAccountApi, 'keys', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(manager, ({ records, workspace }) => records.keys(workspace.id))))
    .handle('create', ({ payload }) =>
      quoted(
        Effect.flatMap(manager, ({ records, person, workspace }) =>
          records.createKey(workspace.id, person.id, payload),
        ),
      ),
    )
    .handle('update', ({ params, payload }) => quoted(changeKey(params.keyId, payload)))
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, workspace }) =>
          Effect.as(records.revokeKey(workspace.id, params.keyId), { revoked: true as const }),
        ),
      ),
    ),
)

/** The person's invitations (ADR 0093): one's preview needs no session, the rest the person it is for. */
const InvitationsHandlers = HttpApiBuilder.group(AccountApi, 'invitations', (handlers) =>
  handlers
    .handle('mine', () => quoted(Effect.flatMap(signedIn, ({ records, person }) => records.members.mine(person))))
    .handle('preview', ({ params }) => quoted(AccountRequest.use(({ records }) => records.members.preview(params.id))))
    .handle('accept', ({ params }) =>
      quoted(Effect.flatMap(signedIn, ({ records, person }) => records.members.accept(person, params.id))),
    )
    .handle('decline', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          Effect.as(records.members.decline(person, params.id), { declined: true as const }),
        ),
      ),
    ),
)

/**
 * A workspace's members and invitations (ADR 0093): every member reads its members and may leave; its owners and
 * admins invite, change and remove (and `auth/members.ts` decides who may change whom).
 */
const MembersHandlers = HttpApiBuilder.group(WorkspaceAccountApi, 'members', (handlers) =>
  handlers
    .handle('list', () =>
      quoted(Effect.flatMap(member, ({ records, workspace }) => records.members.list(workspace.id))),
    )
    .handle('update', ({ params, payload }) =>
      quoted(
        Effect.flatMap(manager, ({ records, workspace }) =>
          records.members.update(workspace, params.userId, payload.role),
        ),
      ),
    )
    .handle('remove', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, person, workspace }) =>
          Effect.as(records.members.remove(workspace, person, params.userId), { removed: true as const }),
        ),
      ),
    )
    .handle('leave', () =>
      quoted(
        Effect.flatMap(member, ({ records, person, workspace }) =>
          Effect.as(records.members.leave(workspace, person), { left: true as const }),
        ),
      ),
    )
    .handle('invitations', () =>
      quoted(Effect.flatMap(manager, ({ records, workspace }) => records.members.invitations(workspace.id))),
    )
    .handle('invite', ({ payload }) =>
      quoted(
        Effect.flatMap(manager, ({ records, person, workspace }) => records.members.invite(workspace, person, payload)),
      ),
    )
    .handle('cancel', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, workspace }) =>
          Effect.as(records.members.cancel(workspace.id, params.id), { canceled: true as const }),
        ),
      ),
    )
    .handle('resend', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, person, workspace }) =>
          records.members.resend(workspace, person, params.id),
        ),
      ),
    ),
)

const ClientErrorsHandlers = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) =>
  handlers.handle('report', ({ payload }) => takeReport(payload)),
)

/** The account API's routes, served by the Worker (`edge.ts`). */
export const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([WorkspacesHandlers, InvitationsHandlers, ClientsHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)

/** The workspace account API's routes, served by the Worker for a member (`edge.ts`). */
export const WorkspaceAccountApiLayer = HttpApiBuilder.layer(WorkspaceAccountApi).pipe(
  Layer.provide([KeysHandlers, MembersHandlers]),
  Layer.provide(HttpServer.layerServices),
)
