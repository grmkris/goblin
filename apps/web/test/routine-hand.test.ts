import { describe, expect, it } from 'vitest'
import { nobodyNote } from '../src/components/routine-hand.tsx'

describe('a routine handed to nobody', () => {
  it('says it only tells the owner while Tell me is on, and what to do when it would do nothing', () => {
    expect(nobodyNote(true)).toBe('It only tells you.')
    expect(nobodyNote(false)).toBe('It does nothing yet. Turn Tell me on, or hand it over.')
  })
})
