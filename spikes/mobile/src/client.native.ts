import { GoblinApi } from './api.ts'
import { nativeSession } from './session.native.ts'
export function createClient(): GoblinApi {
  const configured: unknown = import.meta.env.ONE_PUBLIC_GOBLIN_URL
  const origin = (typeof configured === 'string' ? configured : 'https://dev.goblin.surf').replace(/\/$/u, '')
  return new GoblinApi({ origin, native: true, sessions: nativeSession(origin) })
}
