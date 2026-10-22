import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router'
import { describe, expect, it } from 'vitest'
import { stringifySearch } from '../src/lib/search.ts'

// The consent query as the authorization server signs it: its signed keys are listed under a repeated `ba_param`.
const SIGNED =
  'response_type=code&client_id=abc&scope=openid+goblin%3Aagent&exp=1729584000&ba_param=response_type&ba_param=client_id&ba_param=scope&ba_param=exp&sig=x-Y_z'

describe('the router search writer', () => {
  it('writes a signed query back exactly as it came, its repeated key still repeated', () => {
    expect(stringifySearch(defaultParseSearch(SIGNED))).toBe(`?${SIGNED}`)
  })

  it('writes every other value as the default does', () => {
    const search = { info: true, thread: 12, stack: '1-2', focus: 'notes', reply: 'new', nested: { a: [1] } }
    expect(stringifySearch(search)).toBe(defaultStringifySearch(search))
    expect(stringifySearch({})).toBe('')
  })
})
