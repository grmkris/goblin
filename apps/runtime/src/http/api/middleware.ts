import { ApiKeyScope, Forbidden, OwnerAdmission, RenewsResident, Unauthenticated, withRef } from '@goblin/contracts/api'
import { FORWARDED_HEADER, InternalGate } from '@goblin/contracts/internal'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as HttpServerRequest from 'effect/http/HttpServerRequest'
import type * as HttpApiEndpoint from 'effect/http-api/HttpApiEndpoint'
import type * as HttpApiGroup from 'effect/http-api/HttpApiGroup'
import { type AppError, NotFound, isAppError } from '../errors.ts'
import { keyMinutes } from '../../keys/rate.ts'
import { Resident } from '../../mcp/service.ts'
import { RequestContext } from './context.ts'

/**
 * `handler` behind `admit`, as every API of the agent runs it: its logs carry the endpoint, the operation and the
 * request's reference, and every typed failure it answers quotes that reference.
 */
const admitted = <A, E, R, E1, R1>(
  handler: Effect.Effect<A, E, R>,
  admit: Effect.Effect<void, E1, R1>,
  names: { readonly group: HttpApiGroup.Top; readonly endpoint: HttpApiEndpoint.Top },
) =>
  Effect.flatMap(Effect.serviceOption(RequestContext), (context) => {
    const { ref, operation } = Option.getOrUndefined(context) ?? {}
    return Effect.andThen(admit, handler).pipe(
      Effect.catchIf(isAppError, (error) =>
        ref === undefined ? Effect.fail(error) : Effect.flatMap(withRef(ref)(error), Effect.fail),
      ),
      Effect.annotateLogs({
        'goblin.rpc': `${names.group.identifier}.${names.endpoint.identifier}`,
        ...(operation === undefined ? {} : { 'goblin.operation': operation }),
        ...(ref === undefined ? {} : { ref }),
      }),
    )
  })

/**
 * Owner admission (`OwnerAdmission` in the contract): a renewal of resident authority unless the endpoint says
 * otherwise (`RenewsResident`: changing it must not renew first), then the handler. A request a server's API key sent
 * (ADR 0081) is admitted only to an endpoint whose `ApiKeyScope` the key holds, the edge's check made again here, and
 * within the key's requests for the minute (ADR 0085: past them, `key_rate_limited` with `retryAfter`), and never
 * renews: a key is not the owner's presence.
 */
export const OwnerAdmissionLive = Layer.effect(
  OwnerAdmission,
  Effect.gen(function* () {
    const resident = yield* Resident
    const take = keyMinutes()
    const admit = (annotations: Context.Context<never>) =>
      Effect.flatMap(Effect.serviceOption(RequestContext), (context): Effect.Effect<void, AppError> => {
        const key = Option.getOrUndefined(context)?.key
        if (key === undefined) return Context.get(annotations, RenewsResident) ? resident.renew() : Effect.void
        const scope = Context.get(annotations, ApiKeyScope)
        if (scope === undefined || !key.scopes.includes(scope))
          return Effect.fail(new Forbidden({ reason: 'key_scope' }))
        return Effect.flatMap(Clock.currentTimeMillis, (now) => {
          const retryAfter = take(key.keyId, now)
          return retryAfter === undefined
            ? Effect.void
            : Effect.fail(new Unauthenticated({ reason: 'key_rate_limited', retryAfter }))
        })
      })
    return OwnerAdmission.of((handler, names) => admitted(handler, admit(names.endpoint.annotations), names))
  }),
)

/**
 * The internal gate (`InternalGate` in the contract): a request the Worker's edge forwarded for the owner is no
 * internal request, whatever its path became on the way, so it names no route (404). Resident authority is never
 * renewed here.
 */
export const InternalGateLive = Layer.succeed(
  InternalGate,
  InternalGate.of((handler, names) =>
    admitted(
      handler,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        if (request.headers[FORWARDED_HEADER] !== undefined) return yield* new NotFound({ what: 'route' })
      }),
      names,
    ),
  ),
)
