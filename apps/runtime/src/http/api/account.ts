import { AccountApi, type AppError, WorkspaceAccountApi, withRef } from '@goblin/contracts/api'
import type {
  ApiKeyView,
  ClientErrorReport,
  ConsentTerms,
  CreateApiKeyTerms,
  CreatedApiKey,
  CreateTrustedWorkload,
  CreateWorkspace,
  GrantTerms,
  InboundClient,
  UpdateApiKeyTerms,
  UpdateWorkspace,
  WidenResult,
  WorkspaceView,
  TrustedWorkloadView,
} from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { type KeyChange, createKey, listKeys, revokeKey, rotateKey, updateKey } from '../../auth/api-keys.ts'
import { listInboundClients, revokeInboundClient } from '../../auth/clients.ts'
import { createOidcPolicy, disableOidcPolicy, listOidcPolicies } from '../../auth/oidc-workloads.ts'
import {
  type TermsChange,
  clientTerms,
  grantTerms,
  narrowedTopics,
  setClientGrant,
  widenGrant,
} from '../../auth/consent-terms.ts'
import { deleteAgentOf } from '../../auth/account.ts'
import {
  type Person,
  createWorkspace,
  deleteWorkspace,
  reachedBy,
  updateWorkspace,
  workspacesOf,
} from '../../auth/workspaces.ts'
import type { LeaseHolder } from '@goblin/contracts/internal'
import { internalCall } from '../../inbound/client.ts'
import type { RuntimeEnv } from '../../env.ts'
import { logEvent } from '../../observability/logger.ts'
import { reportAndRecover } from '../../observability/report.ts'
import { FlowPointFailure, agentHash, flowPoint } from '../../observability/ae.ts'
import { Forbidden, InvalidInput, Unauthenticated, attempt } from '../errors.ts'
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
  /** The MCP clients a person connected, with their grants and the workspaces each reaches, and ending one (ADR 0097). */
  readonly clients: (userId: string) => Effect.Effect<readonly InboundClient[], AppError>
  readonly revokeClient: (userId: string, clientId: string) => Effect.Effect<void, AppError>
  /**
   * Grants as the person approving them reads and changes them (ADR 0114): an MCP client's (the consent page, Settings)
   * and any grant they may approve (the widening page). A change that narrows a grant's Topics first ends its holder's
   * published Events leases where it narrowed.
   */
  readonly clientTerms: (person: Person, clientId: string) => Effect.Effect<ConsentTerms, AppError>
  readonly setClientGrant: (person: Person, clientId: string, terms: GrantTerms) => Effect.Effect<TermsChange, AppError>
  readonly grantTerms: (person: Person, grantId: string) => Effect.Effect<ConsentTerms, AppError>
  readonly widen: (person: Person, grantId: string, terms: GrantTerms) => Effect.Effect<TermsChange, AppError>
  /** A workspace's API keys (ADRs 0081, 0089), and making, rotating and ending one. */
  readonly keys: (workspaceId: string) => Effect.Effect<readonly ApiKeyView[], AppError>
  readonly createKey: (
    workspaceId: string,
    userId: string,
    input: CreateApiKeyTerms,
  ) => Effect.Effect<CreatedApiKey, AppError>
  /** New terms for one of the workspace's keys' grant (ADRs 0084, 0114), before and after. */
  readonly updateKey: (
    workspaceId: string,
    userId: string,
    keyId: string,
    change: UpdateApiKeyTerms,
  ) => Effect.Effect<KeyChange, AppError>
  /** A new secret for one of the workspace's keys (ADR 0105): the same key, with its secret this once. */
  readonly rotateKey: (workspaceId: string, keyId: string) => Effect.Effect<CreatedApiKey, AppError>
  readonly revokeKey: (workspaceId: string, keyId: string) => Effect.Effect<void, AppError>
  readonly trustedWorkloads: (workspaceId: string) => Effect.Effect<readonly TrustedWorkloadView[], AppError>
  readonly createTrustedWorkload: (
    workspaceId: string,
    userId: string,
    input: CreateTrustedWorkload,
  ) => Effect.Effect<TrustedWorkloadView, AppError>
  readonly disableTrustedWorkload: (workspaceId: string, id: string) => Effect.Effect<void, AppError>
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

/**
 * Ends every published Events lease `holder` holds in workspace `workspaceId` (ADR 0112), before their access ends: one
 * `terminated` control goes to each. A failure is reported and the access still ends; a lease it missed lapses at its
 * end, a day at most.
 */
const endLeases = (env: RuntimeEnv, workspaceId: string, holder: LeaseHolder) =>
  internalCall(env.AGENTS.getByName(workspaceId), (api) => api.publish.terminate({ payload: { holder } })).pipe(
    Effect.asVoid,
    reportAndRecover('publish.terminate', undefined),
  )

/** A key as the leases it holds name it. */
const key = (keyId: string): LeaseHolder => ({ kind: 'key', keyId })

/** The workspaces client `clientId` reaches for `userId` now: where its leases are. */
const clientWorkspaces = (env: RuntimeEnv, userId: string, clientId: string) =>
  attempt(() => reachedBy(env.AUTH_DB, userId, clientId)).pipe(
    Effect.map((reached) => reached?.workspaces ?? []),
    reportAndRecover('publish.reach', []),
  )

/** The lease holder a grant's credential is (ADR 0112): its key, or its client for its person. */
const holderOfGrant = (change: TermsChange): LeaseHolder | undefined =>
  change.grant.keyId !== undefined
    ? key(change.grant.keyId)
    : change.grant.clientId !== undefined && change.grant.userId !== undefined
      ? { kind: 'client', clientId: change.grant.clientId, user: change.grant.userId }
      : undefined

/**
 * `change` made, after the holder's leases in every workspace whose Topics it narrowed were ended: a lease never
 * outlives the reach it was made under. The terms are saved first, so a refused change ends nothing.
 */
const endNarrowed = (env: RuntimeEnv, change: TermsChange) =>
  Effect.gen(function* () {
    const holder = holderOfGrant(change)
    if (holder === undefined) return change
    for (const workspace of narrowedTopics(change.before?.reach, change.after.reach))
      yield* endLeases(env, workspace, holder)
    return change
  })

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
    clientTerms: (person, clientId) => attempt(() => clientTerms(env, person, clientId)),
    setClientGrant: (person, clientId, terms) =>
      Effect.flatMap(
        attempt(() => setClientGrant(env, person, clientId, terms)),
        (change) => endNarrowed(env, change),
      ),
    grantTerms: (person, grantId) => attempt(() => grantTerms(env, person, grantId)),
    widen: (person, grantId, terms) =>
      Effect.flatMap(
        attempt(() => widenGrant(env, person, grantId, terms)),
        (change) => endNarrowed(env, change),
      ),
    revokeClient: (userId, clientId) =>
      Effect.gen(function* () {
        const holder = { kind: 'client' as const, clientId, user: userId }
        for (const workspace of yield* clientWorkspaces(env, userId, clientId))
          yield* endLeases(env, workspace.id, holder)
        yield* attempt(() => revokeInboundClient(env, userId, clientId))
      }),
    keys: (workspaceId) => attempt(() => listKeys(env, workspaceId)),
    trustedWorkloads: (workspaceId) => attempt(() => listOidcPolicies(env, workspaceId)),
    createTrustedWorkload: (workspaceId, userId, input) =>
      attempt(() => createOidcPolicy(env, workspaceId, userId, input)),
    disableTrustedWorkload: (workspaceId, id) => attempt(() => disableOidcPolicy(env, workspaceId, id)),
    createKey: (workspaceId, userId, input) => attempt(() => createKey(env, workspaceId, userId, input)),
    updateKey: (workspaceId, userId, keyId, change) =>
      Effect.tap(
        attempt(() => updateKey(env, workspaceId, userId, keyId, change)),
        ({ before, after }) =>
          narrowedTopics(before.terms.reach, after.terms.reach).length === 0
            ? Effect.void
            : endLeases(env, workspaceId, key(keyId)),
      ),
    rotateKey: (workspaceId, keyId) =>
      Effect.andThen(
        endLeases(env, workspaceId, key(keyId)),
        attempt(() => rotateKey(env, workspaceId, keyId)),
      ),
    revokeKey: (workspaceId, keyId) =>
      Effect.andThen(
        endLeases(env, workspaceId, key(keyId)),
        attempt(() => revokeKey(env, workspaceId, keyId)),
      ),
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
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          Effect.as(records.revokeClient(person.id, params.clientId), { revoked: true as const }),
        ),
      ),
    ),
)

/** A grant's level and extras as an audit line carries them: a few short tokens, never a name or an id it reaches. */
const powerOf = (terms: GrantTerms): readonly string[] => [terms.level, ...terms.extras]

/**
 * A key's grant's new terms (ADRs 0084, 0114), as a manager's change of it is audited: one `api_key` line with the key,
 * the workspace, who changed it and the request's reference, its level and extras before and after, and how many MCP
 * origins it holds now. Never its secret, and no origin, tool or reach id.
 */
const changeKey = (keyId: string, change: UpdateApiKeyTerms) =>
  Effect.gen(function* () {
    const { records, person, workspace } = yield* manager
    const { before, after } = yield* records.updateKey(workspace.id, person.id, keyId, change)
    yield* logEvent('info', 'api_key', {
      id: keyId,
      agent: workspace.id,
      by: person.id,
      kind: 'grant',
      scopes: powerOf(after.terms),
      'scopes.before': powerOf(before.terms),
      count: after.terms.reach.origins.length,
    })
    return after
  })

/** A grant change as its answer says it, after one `grant` audit line like a key's (`changeKey`). */
const audited = (change: TermsChange, by: string): Effect.Effect<WidenResult> =>
  Effect.as(
    logEvent('info', 'grant', {
      id: change.grant.id,
      by,
      kind: change.grant.kind,
      scopes: powerOf(change.after),
      ...(change.before === undefined ? {} : { 'scopes.before': powerOf(change.before) }),
    }),
    { grantId: change.grant.id, terms: change.after, expiresAt: change.expiresAt },
  )

/**
 * Grants as the person approving them sees them (ADR 0114): what the consent and widening pages show, and their
 * approval, widened or narrowed. Theirs alone: a grant they may not approve is not found.
 */
const GrantsHandlers = HttpApiBuilder.group(AccountApi, 'grants', (handlers) =>
  handlers
    .handle('terms', ({ params }) =>
      quoted(Effect.flatMap(signedIn, ({ records, person }) => records.grantTerms(person, params.id))),
    )
    .handle('widen', ({ params, payload }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          payload.grantId === params.id
            ? Effect.flatMap(records.widen(person, params.id, payload.terms), (change) => audited(change, person.id))
            : Effect.fail(new InvalidInput({ reason: 'grant' })),
        ),
      ),
    )
    .handle('clientTerms', ({ params }) =>
      quoted(Effect.flatMap(signedIn, ({ records, person }) => records.clientTerms(person, params.clientId))),
    )
    .handle('clientGrant', ({ params, payload }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, person }) =>
          Effect.flatMap(records.setClientGrant(person, params.clientId, payload.terms), (change) =>
            audited(change, person.id),
          ),
        ),
      ),
    ),
)

/**
 * A key's new secret (ADR 0105), as a manager's rotation of it is audited: one `api_key` line (`kind: secret`) with the
 * key, the workspace, who rotated it and the request's reference. Never a secret, the old one or the new.
 */
const rotateSecret = (keyId: string) =>
  Effect.gen(function* () {
    const { records, person, workspace } = yield* manager
    const rotated = yield* records.rotateKey(workspace.id, keyId)
    yield* logEvent('info', 'api_key', { id: keyId, agent: workspace.id, by: person.id, kind: 'secret' })
    return rotated
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
    .handle('rotate', ({ params }) => quoted(rotateSecret(params.keyId)))
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, workspace }) =>
          Effect.as(records.revokeKey(workspace.id, params.keyId), { revoked: true as const }),
        ),
      ),
    ),
)

const TrustedWorkloadsHandlers = HttpApiBuilder.group(WorkspaceAccountApi, 'trustedWorkloads', (handlers) =>
  handlers
    .handle('list', () =>
      quoted(Effect.flatMap(manager, ({ records, workspace }) => records.trustedWorkloads(workspace.id))),
    )
    .handle('create', ({ payload }) =>
      quoted(
        Effect.flatMap(manager, ({ records, person, workspace }) =>
          records.createTrustedWorkload(workspace.id, person.id, payload),
        ),
      ),
    )
    .handle('disable', ({ params }) =>
      quoted(
        Effect.flatMap(manager, ({ records, workspace }) =>
          Effect.as(records.disableTrustedWorkload(workspace.id, params.id), { disabled: true as const }),
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
  Layer.provide([WorkspacesHandlers, InvitationsHandlers, ClientsHandlers, GrantsHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)

/** The workspace account API's routes, served by the Worker for a member (`edge.ts`). */
export const WorkspaceAccountApiLayer = HttpApiBuilder.layer(WorkspaceAccountApi).pipe(
  Layer.provide([KeysHandlers, MembersHandlers, TrustedWorkloadsHandlers]),
  Layer.provide(HttpServer.layerServices),
)
