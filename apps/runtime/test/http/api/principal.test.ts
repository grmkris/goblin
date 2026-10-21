import { describe, expect, it } from 'vitest'
import { MEMBER_HEADER, forwardedPrincipal, memberHeader } from '../../../src/http/api/principal.ts'

describe('the forwarded member (ADR 0089)', () => {
  it('carries any name in an ASCII header, which the agent reads back as it was', () => {
    const member = { user: 'u-ziga', role: 'member', name: 'Žiga Čeh 😀', shared: true } as const
    const value = memberHeader(member)
    expect(value).toMatch(/^[\x20-\x7e]+$/u)
    const request = new Request('https://agent/api/topics', { headers: { [MEMBER_HEADER]: value } })
    expect(forwardedPrincipal(request)).toEqual({ member })
  })
})
