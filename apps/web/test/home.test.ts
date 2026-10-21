import { describe, expect, it } from 'vitest'
import { hasSessionCookie } from '../src/lib/home.ts'

const cookies =
  (jar: Readonly<Record<string, string>>) =>
  (name: string): string | undefined =>
    jar[name]

describe('Home', () => {
  it('tells a request with a session cookie, under either name, from one without, which gets the landing', () => {
    expect(hasSessionCookie(cookies({ '__Secure-better-auth.session_token': 'abc.def' }))).toBe(true)
    expect(hasSessionCookie(cookies({ 'better-auth.session_token': 'abc.def' }))).toBe(true)
    expect(hasSessionCookie(cookies({}))).toBe(false)
    expect(hasSessionCookie(cookies({ 'better-auth.session_token': '' }))).toBe(false)
    expect(hasSessionCookie(cookies({ 'better-auth.session_data': 'abc' }))).toBe(false)
  })
})
