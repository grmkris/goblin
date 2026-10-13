import { describe, expect, it } from 'vitest'
import { GoblinApi, sessionCookie } from '../src/api.ts'
import { browserSession } from '../src/session.ts'

describe('GoblinApi', () => {
  it('retains only Better Auth session cookies', () => {
    expect(sessionCookie(new Headers({ 'set-cookie': 'better-auth.session_token=signed; Path=/; HttpOnly' }))).toBe(
      'better-auth.session_token=signed',
    )
    expect(sessionCookie(new Headers({ 'set-cookie': 'other=untrusted; Path=/' }))).toBeUndefined()
    expect(
      sessionCookie(
        new Headers({
          'set-cookie': '__Secure-better-auth.session_token=renewed; Path=/; Secure, better-auth.session_token=old',
        }),
      ),
    ).toBe('__Secure-better-auth.session_token=renewed')
    expect(sessionCookie(new Headers({ 'set-cookie': 'better-auth.session_token=; Max-Age=0' }))).toBe('')
  })
  it('sends native owner admission headers and the retained cookie', async () => {
    let seen: Request | undefined
    let cookie = 'better-auth.session_token=signed'
    const api = new GoblinApi({
      origin: 'https://dev.goblin.surf',
      native: true,
      sessions: {
        read: async () => cookie,
        write: async (value) => {
          cookie = value
        },
        clear: async () => {
          cookie = ''
        },
      },
      fetch: async (input, init) => {
        seen = new Request(input, init)
        return Response.json({ operationId: '1234567890abcdef', session: 'fixture-session', accepted: true })
      },
    })
    await api.request('/api/conversations/1/snapshot')
    expect(seen?.headers.get('origin')).toBe('https://dev.goblin.surf')
    expect(seen?.headers.get('cookie')).toBe(cookie)
    await api.submit('1', { input: 'hello', operationId: '1234567890abcdef' })
    expect(seen?.headers.get('x-goblin-operation')).toBe('1234567890abcdef')
    if (seen === undefined) throw new Error('Missing outgoing request')
    expect(JSON.parse(await seen.text())).toMatchObject({ operationId: '1234567890abcdef' })
    expect(seen?.headers.get('x-goblin-csrf')).toBe('1')
    expect(seen?.headers.get('authorization')).toBeNull()
  })

  it('rejects path escapes, foreign origins, and invalid chat selectors', async () => {
    const api = new GoblinApi({ origin: 'https://dev.goblin.surf', native: true, sessions: browserSession, fetch })
    await expect(api.request('/api/../private')).rejects.toThrow('Only the configured Goblin API')
    await expect(api.request('https://other.example/api/auth/get-session')).rejects.toThrow(
      'Only the configured Goblin API',
    )
    await expect(api.snapshot('not-a-chat', new AbortController().signal)).rejects.toThrow()
  })
})
