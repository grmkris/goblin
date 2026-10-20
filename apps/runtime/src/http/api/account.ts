import { AccountApi, type AppError, withRef } from '@goblin/contracts/api'
import type { ApiKeyView, ClientErrorReport, CreateApiKey, CreatedApiKey, InboundClient } from '@goblin/contracts'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServer from 'effect/http/HttpServer'
import * as HttpApiBuilder from 'effect/http-api/HttpApiBuilder'
import { createKey, listKeys, revokeKey } from '../../auth/api-keys.ts'
import { listInboundClients, revokeInboundClient } from '../../auth/clients.ts'
import type { RuntimeEnv } from '../../env.ts'
import { logEvent } from '../../observability/logger.ts'
import { reportAndRecover } from '../../observability/report.ts'
import { FlowPointFailure, agentHash, flowPoint } from '../../observability/ae.ts'
import { Unauthenticated, attempt } from '../errors.ts'
import { RequestContext } from './context.ts'

/** The account's own records the Worker answers from: auth D1 and Analytics Engine, never the agent. */
export interface AccountRecords {
  readonly clients: (userId: string) => Effect.Effect<readonly InboundClient[], AppError>
  readonly revokeClient: (userId: string, clientId: string) => Effect.Effect<void, AppError>
  /** The user's API keys (ADR 0081), and making and ending one. */
  readonly keys: (userId: string) => Effect.Effect<readonly ApiKeyView[], AppError>
  readonly createKey: (userId: string, input: CreateApiKey) => Effect.Effect<CreatedApiKey, AppError>
  readonly revokeKey: (userId: string, keyId: string) => Effect.Effect<void, AppError>
  /**
   * A browser crash's `client_error` flow point (ADR 0037), under the hash of `userId`'s agent when the report came
   * with a session; nothing without the `FLOWS` binding.
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
    clients: (userId) => attempt(() => listInboundClients(env, userId)),
    revokeClient: (userId, clientId) => attempt(() => revokeInboundClient(env, userId, clientId)),
    keys: (userId) => attempt(() => listKeys(env, userId)),
    createKey: (userId, input) => attempt(() => createKey(env, userId, input)),
    revokeKey: (userId, keyId) => attempt(() => revokeKey(env, userId, keyId)),
  }
}

/**
 * What one account request carries past the edge's admission: the records, and the signed-in user when the endpoint
 * needs one (every endpoint but a client error report).
 */
export class AccountRequest extends Context.Service<
  AccountRequest,
  { readonly records: AccountRecords; readonly userId: Option.Option<string> }
>()('goblin/http/AccountRequest') {}

/** The signed-in user. Admission has checked the session already; this only says so to the types. */
const signedIn = AccountRequest.use(({ records, userId }) =>
  Option.match(userId, {
    onNone: () => Effect.fail(new Unauthenticated({ reason: 'session required' })),
    onSome: (user) => Effect.succeed({ records, user }),
  }),
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
    AccountRequest.use(({ records, userId }) => records.crash(report, userId)).pipe(
      reportAndRecover('http.clientErrors', undefined),
    ),
  )

const logReport = (report: ClientErrorReport) =>
  logEvent('warn', 'client_error', {
    route: report.route,
    name: report.name,
    frames: report.frames.map(location),
    build: report.build,
    ...(report.ref === undefined ? {} : { ref: report.ref }),
  })

const ClientsHandlers = HttpApiBuilder.group(AccountApi, 'clients', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.clients(user))))
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, user }) =>
          Effect.as(records.revokeClient(user, params.clientId), { revoked: true as const }),
        ),
      ),
    ),
)

const KeysHandlers = HttpApiBuilder.group(AccountApi, 'keys', (handlers) =>
  handlers
    .handle('list', () => quoted(Effect.flatMap(signedIn, ({ records, user }) => records.keys(user))))
    .handle('create', ({ payload }) =>
      quoted(Effect.flatMap(signedIn, ({ records, user }) => records.createKey(user, payload))),
    )
    .handle('revoke', ({ params }) =>
      quoted(
        Effect.flatMap(signedIn, ({ records, user }) =>
          Effect.as(records.revokeKey(user, params.keyId), { revoked: true as const }),
        ),
      ),
    ),
)

const ClientErrorsHandlers = HttpApiBuilder.group(AccountApi, 'clientErrors', (handlers) =>
  handlers.handle('report', ({ payload }) => takeReport(payload)),
)

/** The account API's routes, served by the Worker (`edge.ts`). */
export const AccountApiLayer = HttpApiBuilder.layer(AccountApi).pipe(
  Layer.provide([ClientsHandlers, KeysHandlers, ClientErrorsHandlers]),
  Layer.provide(HttpServer.layerServices),
)
