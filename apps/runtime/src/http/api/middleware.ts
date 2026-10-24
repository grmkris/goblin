import { GRANT_SPEC, type Need, ROLE_POWER, missingFor } from '@goblin/contracts'
import {
  EndpointAccess,
  EndpointRole,
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
import { Grants } from '../../grants/service.ts'
import { KeyNames } from '../../keys/names.ts'
import { callerMinutes } from '../../keys/rate.ts'
import { Resident } from '../../mcp/service.ts'
import { RequestContext } from './context.ts'
import { type Credential, type Member, credentialId } from './principal.ts'

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

/** What admitting a credential takes from the agent: its count per minute, its key names and its grants. */
interface CredentialGate {
  readonly take: ReturnType<typeof callerMinutes>
  readonly learn: KeyNames['Service']['learn']
  readonly grants: Grants['Service']
}

/**
 * A credential's admission (ADRs 0086, 0114): the endpoint must take credentials at all (`EndpointAccess`, else
 * `Forbidden` `credential`), and its grant must hold the endpoint's level and extra (else `AccessInsufficient` with
 * the widening link); a client's person's role must hold them too (`ROLE_POWER`, else `Forbidden` `role`: a client
 * never does more than its person may). A grant past its end is `Unauthenticated` (`grant_expired`). Then its requests
 * for the minute (else `rate_limited` with `retryAfter`, ADR 0085), and its grant's reach is mirrored afresh when its
 * generation moved (`Grants.sync`). A key admitted is `learn`t: its first request in the object's lifetime names what
 * it made, for display (ADR 0115).
 */
/** A client never does more than its person may: their role's power must hold what the endpoint needs. */
const personHolds = (credential: Credential, member: Member | undefined, need: Need): Effect.Effect<void, AppError> => {
  if (credential.kind !== 'client') return Effect.void
  if (member === undefined) return Effect.fail(new Unauthenticated({ reason: 'principal' }))
  return missingFor(GRANT_SPEC, ROLE_POWER[member.role], need) === null
    ? Effect.void
    : Effect.fail(new Forbidden({ reason: 'role' }))
}

const admitCredential = (
  credential: Credential,
  member: Member | undefined,
  annotations: Context.Context<never>,
  gate: CredentialGate,
): Effect.Effect<void, AppError> =>
  Effect.gen(function* () {
    const need = Context.get(annotations, EndpointAccess)
    if (need === undefined) return yield* new Forbidden({ reason: 'credential' })
    yield* gate.grants.require(credential, need)
    yield* personHolds(credential, member, need)
    const now = yield* Clock.currentTimeMillis
    if (credential.expiresAt !== null && credential.expiresAt <= now)
      return yield* new Unauthenticated({ reason: 'grant_expired' })
    const retryAfter = gate.take(credentialId(credential), now)
    if (retryAfter !== undefined) return yield* new Unauthenticated({ reason: 'rate_limited', retryAfter })
    yield* gate.grants.sync(credential)
    if (credential.kind !== 'client') yield* gate.learn(credential)
  })

/**
 * Owner admission (`OwnerAdmission` in the contract): a request says who it comes from (ADR 0089), else it is
 * `Unauthenticated` (`principal`). A member reaches an endpoint only with the role it needs (`EndpointRole`, ADR 0093;
 * else `Forbidden`, `role`), and so does an OAuth client acting for them. A member's session grants resident authority
 * unless the endpoint says otherwise (`GrantsResident`: changing it must not grant first), then the handler runs. A
 * request from a credential (a server's key or an OAuth client, ADRs 0086, 0114) is admitted by its grant
 * (`admitCredential`) and never grants it: a credential is not a member's presence. What it reaches past admission is
 * its grant's (`grants/policy.ts`).
 */
export const OwnerAdmissionLive = Layer.effect(
  OwnerAdmission,
  Effect.gen(function* () {
    const resident = yield* Resident
    const { learn } = yield* KeyNames
    const gate: CredentialGate = { take: callerMinutes(), learn, grants: yield* Grants }
    const admit = (annotations: Context.Context<never>) =>
      Effect.flatMap(Effect.serviceOption(RequestContext), (context): Effect.Effect<void, AppError> => {
        const facts = Option.getOrUndefined(context)
        const member = facts?.member
        if (member !== undefined && !reaches(member.role, Context.get(annotations, EndpointRole)))
          return Effect.fail(new Forbidden({ reason: 'role' }))
        if (facts?.credential !== undefined) return admitCredential(facts.credential, member, annotations, gate)
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
