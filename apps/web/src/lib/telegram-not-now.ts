const KEY = 'goblin:telegram-not-now'

/**
 * The Telegram offers this browser was told "Not now" (ADR 0055), by chat key: a convenience, so Activity stops asking
 * here while the chat keeps waiting in the Chats list. Without storage there are none.
 */
export function notNowChats(): readonly string[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : []
  } catch {
    // expected: storage is off or holds something else, so every waiting chat is offered
    return []
  }
}

/**
 * Remembers "Not now" for `key`, keeping only the keys still `offered` (a chat routed since needs no entry), and gives
 * the keys now remembered.
 */
export function rememberNotNow(key: string, offered: readonly string[]): readonly string[] {
  const next = [...new Set([...notNowChats(), key])].filter((each) => each === key || offered.includes(each))
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // expected: storage is off or full, so the offer is hidden only until the page is opened again
  }
  return next
}
