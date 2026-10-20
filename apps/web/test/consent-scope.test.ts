import { describe, expect, it } from 'vitest'
import { consentBody, offeredScopes, requestedScopes } from '../src/lib/consent-scope.ts'

describe('the consent page’s grant', () => {
  const asked = requestedScopes('openid offline_access goblin:topics goblin:personas goblin:inspect')

  it('offers each goblin scope it was asked for, in its own order', () => {
    expect(offeredScopes(asked)).toEqual(['goblin:topics', 'goblin:personas', 'goblin:inspect'])
    expect(offeredScopes(requestedScopes('openid goblin:everything'))).toEqual([])
  })

  it('leaves out every goblin scope the owner did not turn on', () => {
    expect(consentBody(asked, true, [])).toEqual({ accept: true, scope: 'openid offline_access' })
    expect(consentBody(asked, true, ['goblin:personas'])).toEqual({
      accept: true,
      scope: 'openid offline_access goblin:personas',
    })
    expect(consentBody(asked, true, ['goblin:topics', 'goblin:personas', 'goblin:inspect'])).toEqual({ accept: true })
  })

  it('grants a request with no goblin scope as asked, and a denial is a denial', () => {
    expect(consentBody(requestedScopes('openid offline_access'), true, [])).toEqual({ accept: true })
    expect(consentBody(asked, false, [])).toEqual({ accept: false })
    expect(requestedScopes(null)).toEqual([])
  })
})
