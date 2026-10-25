import { describe, expect, it } from 'vitest'
import { returnAddressOf } from '../src/components/consent.tsx'

describe('where the consent page says the client sends the person back (unit, ADR 0122)', () => {
  it('names the redirect host, says when it is this computer, and nothing for no or a bad redirect', () => {
    expect(returnAddressOf('?client_id=c&redirect_uri=http%3A%2F%2Flocalhost%3A52345%2Fcallback')).toEqual({
      host: 'localhost:52345',
      loopback: true,
    })
    expect(returnAddressOf('?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fcb')).toEqual({
      host: '127.0.0.1:9',
      loopback: true,
    })
    expect(returnAddressOf('?redirect_uri=https%3A%2F%2Fclaude.ai%2Fapi%2Fmcp%2Fauth_callback')).toEqual({
      host: 'claude.ai',
      loopback: false,
    })
    expect(returnAddressOf('?client_id=c')).toBeUndefined()
    expect(returnAddressOf('?redirect_uri=not%20a%20url')).toBeUndefined()
  })
})
