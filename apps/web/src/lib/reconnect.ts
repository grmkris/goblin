/** Timers, injectable so tests can drive reconnection without waiting. */
export type ReconnectScheduler = {
  readonly schedule: (run: () => void, delayMs: number) => () => void
}
export const browserScheduler: ReconnectScheduler = {
  schedule: (run, delayMs) => {
    const handle = setTimeout(run, delayMs)
    return () => clearTimeout(handle)
  },
}

/** 1s, 2s, 4s ... capped at 30s, with up to 20% jitter so reconnecting tabs do not stampede. */
export const reconnectDelay = (attempt: number, jitter = Math.random()): number =>
  Math.round(Math.min(30_000, 1000 * 2 ** attempt) * (1 + 0.2 * jitter))
