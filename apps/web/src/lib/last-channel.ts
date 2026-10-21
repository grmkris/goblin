import { PRIMARY_CHAT } from '@goblin/contracts'
import { workspaceKey } from './workspace-path.ts'

/** Kept per workspace (ADR 0089): each has its own channels. */
const key = () => workspaceKey('last-channel')

/** The channel this tab showed last, which Home opens again: Personal's until one was opened. */
export function lastChannel(): string {
  try {
    const stored = sessionStorage.getItem(key())
    return stored !== null && /^\d{1,12}$/u.test(stored) ? stored : PRIMARY_CHAT
  } catch {
    // expected: storage is off in this tab (private mode, a policy), so Home opens Personal
    return PRIMARY_CHAT
  }
}

/** Remembers the channel showing now, for Home (a convenience of this tab: without storage Home opens Personal). */
export function rememberChannel(channel: string): void {
  try {
    sessionStorage.setItem(key(), channel)
  } catch {
    // expected: storage is off in this tab (private mode, a policy), so Home opens Personal instead
  }
}
