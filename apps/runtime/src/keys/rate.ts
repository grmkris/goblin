/**
 * How many requests a caller (a server's key or an OAuth client, ADR 0086) may make of its agent in one minute (ADR
 * 0085): a fixed minute of the clock, counted in the agent, which every request a caller sends reaches. A restart
 * forgets the count, which only ever lets a caller through sooner.
 */
export const CALLER_REQUESTS_PER_MINUTE = 600

const MINUTE_MS = 60_000

/**
 * Each caller's requests in the current minute: `take(caller, now)` counts one and answers nothing, or, once the caller
 * has made `limit` this minute, counts none and answers the whole seconds until the next minute begins.
 */
export const callerMinutes = (limit = CALLER_REQUESTS_PER_MINUTE) => {
  const counts = new Map<string, { readonly minute: number; readonly count: number }>()
  return (caller: string, now: number): number | undefined => {
    const minute = Math.floor(now / MINUTE_MS)
    const seen = counts.get(caller)
    const count = seen?.minute === minute ? seen.count : 0
    if (count >= limit) return Math.max(1, Math.ceil(((minute + 1) * MINUTE_MS - now) / 1000))
    counts.set(caller, { minute, count: count + 1 })
    return undefined
  }
}
