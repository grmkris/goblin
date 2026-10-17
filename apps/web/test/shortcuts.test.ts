import { describe, expect, it } from 'vitest'
import { type KeyPress, isApple, isModShortcut } from '../src/lib/shortcuts.ts'

const press = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
})

describe('the app’s shortcuts', () => {
  it('takes ⌘ on Apple’s systems and Ctrl elsewhere, with nothing else held', () => {
    expect(isModShortcut(press('b', { metaKey: true }), 'b', true)).toBe(true)
    expect(isModShortcut(press('B', { metaKey: true }), 'b', true)).toBe(true)
    expect(isModShortcut(press('b', { ctrlKey: true }), 'b', true)).toBe(false)
    expect(isModShortcut(press('b', { ctrlKey: true }), 'b', false)).toBe(true)
    expect(isModShortcut(press('b', { ctrlKey: true, shiftKey: true }), 'b', false)).toBe(false)
    expect(isModShortcut(press('k', { ctrlKey: true }), 'b', false)).toBe(false)
  })

  it('knows Apple’s systems by what the browser says of them', () => {
    expect(isApple('Macintosh; Intel Mac OS X 10_15_7')).toBe(true)
    expect(isApple('iPhone; CPU iPhone OS 18_0 like Mac OS X')).toBe(true)
    expect(isApple('X11; Linux x86_64')).toBe(false)
    expect(isApple('Windows NT 10.0; Win64; x64')).toBe(false)
  })
})
