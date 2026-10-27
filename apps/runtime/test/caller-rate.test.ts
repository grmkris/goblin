import { describe, expect, it } from 'vitest'
import { CALLER_REQUESTS_PER_MINUTE, callerMinutes } from '../src/credentials/rate.ts'

const MINUTE = 60_000
/** 2026-10-20 15:00:00Z, the start of a minute. */
const AT = Date.UTC(2026, 9, 20, 15, 0, 0)

describe("a caller's requests per minute (ADRs 0085, 0086)", () => {
  it('takes 600 in one minute, refuses the next until the minute ends, and takes them again after', () => {
    const take = callerMinutes()
    for (let n = 0; n < CALLER_REQUESTS_PER_MINUTE; n += 1) expect(take('in-1', AT + n * 50)).toBeUndefined()
    expect(take('in-1', AT + 45_500)).toBe(15)
    expect(take('in-1', AT + MINUTE - 1)).toBe(1)
    expect(take('other', AT + 45_500)).toBeUndefined()
    expect(take('in-1', AT + MINUTE)).toBeUndefined()
  })

  it('never refuses a client that sends steadily below the limit, however long it keeps going', () => {
    const take = callerMinutes()
    // 100 a minute without a pause for an hour: the plugin's limiter cut such a client off after six minutes.
    for (let n = 0; n < 6000; n += 1) expect(take('in-1', AT + n * 600)).toBeUndefined()
  })
})
