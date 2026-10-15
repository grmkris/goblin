/**
 * The offers this browser was told "Not now", kept under `storageKey` by each offer's key: a convenience, so Activity
 * stops asking here while the thing keeps waiting where it lives. Without storage there are none.
 */
export function notNowList(storageKey: string) {
  /** The keys told "Not now". */
  const read = (): readonly string[] => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? '[]')
      return Array.isArray(stored) ? stored.filter((key): key is string => typeof key === 'string') : []
    } catch {
      // expected: storage is off or holds something else, so everything waiting is offered
      return []
    }
  }
  /**
   * Remembers "Not now" for `key`, keeping only the keys still `offered` (one settled since needs no entry), and gives
   * the keys now remembered.
   */
  const remember = (key: string, offered: readonly string[]): readonly string[] => {
    const next = [...new Set([...read(), key])].filter((each) => each === key || offered.includes(each))
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {
      // expected: storage is off or full, so the offer is hidden only until the page is opened again
    }
    return next
  }
  return { read, remember }
}
