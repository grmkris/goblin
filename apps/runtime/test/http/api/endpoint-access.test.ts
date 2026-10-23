import { AccessGroup, OwnerApi, ownerApiOf } from '@goblin/contracts/api'
import { describe, expect, it } from 'vitest'
import { endpointAccess } from '../../../src/http/api/context.ts'

/** What each owner endpoint a credential may call needs of its grant; a handler checks the reach of what it touches. */
const NEEDS = {
  'conversations.update': { level: 'write' },
  'conversations.submit': { level: 'write' },
  'conversations.startThread': { level: 'write' },
  'conversations.stop': { level: 'write' },
  'conversations.entries': { level: 'read' },
  'conversations.stream': { level: 'read' },
  'topics.list': { level: 'read' },
  'topics.get': { level: 'read' },
  'topics.create': { level: 'write' },
  'topics.update': { level: 'manage' },
  'topics.setSetup': { level: 'manage', extra: 'setup' },
  'setup.catalog': { level: 'read', extra: 'setup' },
  'personas.list': { level: 'read' },
  'personas.create': { level: 'manage' },
  'personas.detail': { level: 'read' },
  'personas.update': { level: 'manage' },
  'mcp.servers': { level: 'read', extra: 'setup' },
  'agent.models': { level: 'read' },
  'agent.ask': { level: 'write' },
  'agent.recent': { level: 'read' },
  'routines.list': { level: 'read', extra: 'routines' },
  'routines.propose': { level: 'write', extra: 'routines' },
  'routines.edit': { level: 'write', extra: 'routines' },
  'routines.archive': { level: 'write', extra: 'routines' },
  'routines.pause': { level: 'write', extra: 'routines' },
  'routines.runs': { level: 'read', extra: 'routines' },
  'inspect.conversations': { level: 'read', extra: 'inspect' },
  'inspect.conversation': { level: 'read', extra: 'inspect' },
  'inspect.turns': { level: 'read', extra: 'inspect' },
  'inspect.turn': { level: 'read', extra: 'inspect' },
  'inspect.problems': { level: 'read', extra: 'inspect' },
  'inspect.flows': { level: 'read', extra: 'inspect' },
  'inspect.details': { level: 'read', extra: 'inspect' },
  'sources.list': { level: 'read', extra: 'setup' },
  'sources.routes': { level: 'read', extra: 'setup' },
  'events.list': { level: 'read' },
  'events.subscribe': { level: 'read' },
  'events.unsubscribe': { level: 'read' },
  'events.poll': { level: 'read' },
  'access.read': { level: 'read' },
}

describe("what a credential's grant must hold for each owner endpoint", () => {
  it('names a need for exactly the 40 endpoints a credential reaches, and every other refuses one', () => {
    expect([...endpointAccess(OwnerApi).keys()].toSorted()).toEqual(Object.keys(NEEDS).toSorted())
    expect(endpointAccess(OwnerApi).size).toBe(40)
  })

  it('needs a level of each, and an extra of setup, routine and inspection endpoints', () => {
    expect(Object.fromEntries(endpointAccess(OwnerApi))).toEqual(NEEDS)
  })

  it("reads the credential's own grant with read", () => {
    expect(Object.fromEntries(endpointAccess(ownerApiOf(AccessGroup)))).toEqual({ 'access.read': { level: 'read' } })
  })
})
