import { describe, expect, it } from 'vitest'
import { chunks } from '../src/sources/text.ts'

describe('Source reply chunks', () => {
  it('does not split an astral code point at the chunk boundary', () => {
    const pieces = chunks(`${'a'.repeat(99)}😀b`, 100)
    expect(pieces).toEqual(['a'.repeat(99), '😀b'])
    expect(pieces.join('')).toBe('a'.repeat(99) + '😀b')
    expect(pieces.every((piece) => piece.length <= 100 && piece.isWellFormed())).toBe(true)
  })

  it('keeps paragraph and line break splitting within the Unicode-safe window', () => {
    expect(chunks(`${'a'.repeat(60)}\n${'b'.repeat(60)}`, 80)).toEqual(['a'.repeat(60), 'b'.repeat(60)])
  })
})
