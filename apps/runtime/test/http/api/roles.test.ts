import { EndpointRole, OwnerApi } from '@goblin/contracts/api'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as HttpApi from 'effect/http-api/HttpApi'
import { describe, expect, it } from 'vitest'
import { RequestContext } from '../../../src/http/api/context.ts'
import type { Member } from '../../../src/http/api/principal.ts'
import { requireAdminFor } from '../../../src/grants/policy.ts'

/** Every owner endpoint that takes an admin, as `<group>.<endpoint>`, from the contract alone. */
const adminEndpoints = (): readonly string[] => {
  const admin: string[] = []
  HttpApi.reflect(OwnerApi, {
    onGroup: () => undefined,
    onEndpoint: ({ group, endpoint }) => {
      if (Context.get(endpoint.annotations, EndpointRole) === 'admin')
        admin.push(`${group.identifier}.${endpoint.identifier}`)
    },
  })
  return admin.toSorted((a, b) => a.localeCompare(b))
}

/** `requireAdminFor` for a request from a member with `role`, or from no member. */
const asked = (configures: boolean, role?: Member['role']) =>
  Effect.runPromise(
    Effect.exit(
      requireAdminFor(configures).pipe(
        Effect.provideService(RequestContext, {
          ref: undefined,
          request: undefined,
          operation: undefined,
          route: 'topics.update',
          ...(role === undefined ? {} : { member: { user: 'u', role, name: 'Ana', shared: true } }),
        }),
      ),
    ),
  )

describe('admin for configuration (ADRs 0093, 0098)', () => {
  it('takes an admin for what changes what the agent may do or works with, and for nothing else', () => {
    // A new admin endpoint is a decision: add it here with its ADR.
    expect(adminEndpoints()).toMatchSnapshot()
    expect(adminEndpoints()).toEqual(
      expect.arrayContaining([
        'personas.create',
        'personas.update',
        'topics.setSetup',
        'routines.propose',
        'routines.edit',
        'routines.archive',
        'routines.pause',
        'routines.run',
        'routines.confirm',
        'sources.confirm',
        'sources.route',
      ]),
    )
    expect(adminEndpoints()).not.toContain('topics.create')
    expect(adminEndpoints()).not.toContain('conversations.submit')
  })

  it("refuses a member's change to a Topic's guidance or setup, and nobody else's", async () => {
    expect((await asked(true, 'member'))._tag).toBe('Failure')
    for (const role of ['admin', 'owner'] as const) expect((await asked(true, role))._tag).toBe('Success')
    expect((await asked(true))._tag).toBe('Success')
    expect((await asked(false, 'member'))._tag).toBe('Success')
  })
})
