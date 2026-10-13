import { GoblinApi } from './api.ts'
import { browserSession } from './session.ts'
export function createClient(): GoblinApi {
  return new GoblinApi({ origin: window.location.origin, native: false, sessions: browserSession })
}
