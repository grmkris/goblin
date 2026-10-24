import { RegisterApp } from '@goblin/contracts'
import * as Schema from 'effect/Schema'
import { describe, expect, it } from 'vitest'

const accepts = (returnUrl: string) =>
  Schema.is(RegisterApp)({
    name: 'An app',
    returnUrls: [returnUrl],
    terms: {
      name: 'An app',
      level: 'read',
      extras: [],
      lifetime: 'never',
      reach: { workspaces: 'list', each: [], origins: [] },
    },
  })

describe("an app's return address (ADR 0118)", () => {
  it('is https only: the OAuth provider takes no other for a confidential client', () => {
    expect(accepts('https://product.example/goblin/installed')).toBe(true)
    expect(accepts('http://127.0.0.1:9/installed')).toBe(false)
    expect(accepts('http://localhost:9/installed')).toBe(false)
    expect(accepts('http://product.example/installed')).toBe(false)
  })
})
