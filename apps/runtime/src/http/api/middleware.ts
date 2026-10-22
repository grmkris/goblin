import {
  EndpointRole,
  EndpointScope,
  Forbidden,
  OwnerAdmission,
  GrantsResident,
  Unauthenticated,
  withRef,
} from '@goblin/contracts/api'
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
import { KeyNames } from '../../keys/names.ts'
import { callerMinutes } from '../../keys/rate.ts'
import { Resident } from '../../mcp/service.ts'
import { RequestContext } from './context.ts'
import { type Caller, type Member, callerId } from './principal.ts'

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

/** Whether `role` reaches an endpoint that needs `needed` (ADR 0093): an owner counts as an admin. */
const reaches = (role: Member['role'], needed: 'member' | 'admin'): boolean => needed === 'member' || role !== 'member'

/**
 * Owner admission (`OwnerAdmission` in the contract): a request says who it comes from (ADR 0089), else it is
 * `Unauthenticated` (`principal`). A member reaches an endpoint only with the role it needs (`EndpointRole`, ADR 0093;
 * else `Forbidden`, `role`), and so does an OAuth client acting for them. A member's session grants resident authority
 * unless the endpoint says otherwise (`GrantsResident`: changing it must not grant first), then the handler runs. A
 * request from a caller (ADR 0086: a server's key or an OAuth client) is admitted only to an endpoint whose
 * `EndpointScope` the caller holds (else `scope`), within its requests for the minute (else `rate_limited` with
 * `retryAfter`, ADR 0085), and never grants it: a caller is not a member's presence. What it reaches past admission is
 * its kind's (`keys/policy.ts`).
 */
/**
 * A caller's admission (ADR 0086): the endpoint's `EndpointScope` must be one it holds (else `scope`), and it must be
 * within its requests for the minute (else `rate_limited` with `retryAfter`, ADR 0085). A key admitted is `learn`t: its
 * first request in the object's lifetime names what it made (ADR 0108).
 */
const admitCaller = (
  caller: Caller,
  annotations: Context.Context<never>,
  take: ReturnType<typeof callerMinutes>,
  learn: KeyNames['Service']['learn'],
): Effect.Effect<void, AppError> => {
  const scope = Context.get(annotations, EndpointScope)
  if (scope === undefined || !caller.scopes.some((held) => held === scope))
    return Effect.fail(new Forbidden({ reason: 'scope' }))
  return Effect.flatMap(Clock.currentTimeMillis, (now) => {
    const retryAfter = take(callerId(caller), now)
    if (retryAfter !== undefined) return Effect.fail(new Unauthenticated({ reason: 'rate_limited', retryAfter }))
    return caller.kind === 'key' ? learn(caller) : Effect.void
  })
}

export const OwnerAdmissionLive = Layer.effect(
  OwnerAdmission,
  Effect.gen(function* () {
    const resident = yield* Resident
    const { learn } = yield* KeyNames
    const take = callerMinutes()
    const admit = (annotations: Context.Context<never>) =>
      Effect.flatMap(Effect.serviceOption(RequestContext), (context): Effect.Effect<void, AppError> => {
        const facts = Option.getOrUndefined(context)
        const member = facts?.member
        if (member !== undefined && !reaches(member.role, Context.get(annotations, EndpointRole)))
          return Effect.fail(new Forbidden({ reason: 'role' }))
        if (facts?.caller !== undefined) return admitCaller(facts.caller, annotations, take, learn)
        if (member === undefined) return Effect.fail(new Unauthenticated({ reason: 'principal' }))
        return Context.get(annotations, GrantsResident) ? resident.grant() : Effect.void
      })
    return OwnerAdmission.of((handler, names) => admitted(handler, admit(names.endpoint.annotations), names))
  }),
)

/**
 * The internal gate (`InternalGate` in the contract): a request the Worker's edge forwarded for the owner is no
 * internal request, whatever its path became on the way, so it names no route (404). Resident authority is never
 * granted here.
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
