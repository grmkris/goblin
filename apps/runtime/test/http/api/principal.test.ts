import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'
import { Credential, MEMBER_HEADER, forwardedPrincipal, memberHeader } from '../../../src/http/api/principal.ts'

describe('the forwarded member (ADR 0089)', () => {
  it('carries any name in an ASCII header, which the agent reads back as it was', () => {
    const member = { user: 'u-ziga', role: 'member', name: 'Žiga Čeh 😀', shared: true } as const
    const value = memberHeader(member)
    expect(value).toMatch(/^[\x20-\x7e]+$/u)
    const request = new Request('https://agent/api/topics', { headers: { [MEMBER_HEADER]: value } })
    expect(forwardedPrincipal(request)).toEqual({ member })
  })
})

describe('the forwarded credential of a grant', () => {
  const credential: Credential = {
    kind: 'key',
    id: 'k1',
    name: 'swarmm',
    grantId: 'k1',
    level: 'manage',
    extras: ['inspect'],
    expiresAt: null,
    ws: { workspace: 'w1', topics: 'list', personas: 'all', connections: 'list', generation: 3 },
    origins: [{ origin: 'https://mcp.example.test', tools: ['job_submit'] }],
  }
  const decode = Schema.decodeUnknownSync(Schema.fromJsonString(Credential))

  it('carries whether each kind is all or a list, and the generation, never the lists themselves', () => {
    expect(decode(JSON.stringify(credential))).toEqual(credential)
    expect(
      decode(JSON.stringify({ ...credential, kind: 'client', id: 'claude.code:1', expiresAt: 1_792_843_200_000 })),
    ).toMatchObject({ kind: 'client', expiresAt: 1_792_843_200_000 })
    for (const invalid of [
      { ws: { ...credential.ws, topics: { kind: 'list', ids: ['7'] } } },
      { level: 'owner' },
      { extras: ['transcripts'] },
      { expiresAt: -1 },
      { ws: { ...credential.ws, generation: 1.5 } },
      { kind: 'session' },
    ])
      expect(() => decode(JSON.stringify({ ...credential, ...invalid })), JSON.stringify(invalid)).toThrow()
  })
})
