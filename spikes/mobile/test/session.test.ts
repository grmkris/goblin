import { expect, it } from 'vitest'
import { GoblinApi } from '../src/api.ts'

function deferred<T>() {
  const box: { resolve?: (value: T | PromiseLike<T>) => void } = {}
  const promise = new Promise<T>((complete) => {
    box.resolve = complete
  })
  return { promise, resolve: (value: T | PromiseLike<T>) => box.resolve?.(value) }
}

it('sign-out drains in-flight secure-store writes and ignores late session renewal responses', async () => {
  const writing = deferred<void>()
  const finishWrite = deferred<void>()
  const late = deferred<Response>()
  let cookie: string | null = 'better-auth.session_token=old'
  let reads = 0
  const api = new GoblinApi({
    origin: 'https://goblin.test',
    native: true,
    sessions: {
      read: async () => cookie,
      write: async (value) => {
        writing.resolve()
        await finishWrite.promise
        cookie = value
      },
      clear: async () => {
        cookie = null
      },
    },
    fetch: async (input) => {
      const url = input instanceof Request ? input.url : input.toString()
      if (url.endsWith('/sign-out')) return Response.json({ success: true })
      reads += 1
      if (reads === 2) return late.promise
      return Response.json(null, { headers: { 'set-cookie': 'better-auth.session_token=new; HttpOnly' } })
    },
  })
  const refresh = api.hasSession()
  const delayed = api.hasSession()
  await writing.promise
  const signOut = api.signOut()
  finishWrite.resolve()
  await refresh
  await signOut
  expect(cookie).toBeNull()
  late.resolve(Response.json(null, { headers: { 'set-cookie': 'better-auth.session_token=late; HttpOnly' } }))
  await delayed
  expect(cookie).toBeNull()
})
