import { One } from 'one'
import type { SessionStore } from './session.ts'

/** A separate Keychain/Keystore item for every origin, never AsyncStorage or browser localStorage. */
export function nativeSession(origin: string): SessionStore {
  const key = `goblin.${Array.from(origin, (char) => char.charCodeAt(0).toString(16)).join('')}`
  return {
    read: () => One.SecureStore.getItem(key),
    write: (cookie) => One.SecureStore.setItem(key, cookie),
    clear: () => One.SecureStore.deleteItem(key),
  }
}
