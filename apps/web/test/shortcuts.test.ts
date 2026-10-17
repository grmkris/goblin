import { describe, expect, it } from 'vitest'
import { type ShortcutPress, isModShortcut, shortcutLabel, shortcutPlatform } from '../src/lib/shortcuts.ts'

const press = (extra: Partial<ShortcutPress> = {}): ShortcutPress => ({
  key: 'k',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  isComposing: false,
  ...extra,
})

describe('the app’s shortcuts (⌘K Jump to, ⌘B the strip)', () => {
  it('are ⌘ with the key on Apple’s platforms and Ctrl with it elsewhere', () => {
    expect(isModShortcut(press({ metaKey: true }), 'k', 'apple')).toBe(true)
    expect(isModShortcut(press({ ctrlKey: true }), 'k', 'apple')).toBe(false)
    expect(isModShortcut(press({ ctrlKey: true }), 'k', 'other')).toBe(true)
    expect(isModShortcut(press({ metaKey: true }), 'k', 'other')).toBe(false)
    expect(isModShortcut(press({ key: 'K', ctrlKey: true }), 'k', 'other')).toBe(true)
    expect(isModShortcut(press({ key: 'b', metaKey: true }), 'b', 'apple')).toBe(true)
  })

  it('leave the key alone, other shortcuts with Shift or Alt, a held key and an input method’s letter', () => {
    expect(isModShortcut(press(), 'k', 'apple')).toBe(false)
    expect(isModShortcut(press({ metaKey: true, shiftKey: true }), 'k', 'apple')).toBe(false)
    expect(isModShortcut(press({ ctrlKey: true, altKey: true }), 'k', 'other')).toBe(false)
    expect(isModShortcut(press({ metaKey: true, repeat: true }), 'k', 'apple')).toBe(false)
    expect(isModShortcut(press({ metaKey: true, isComposing: true }), 'k', 'apple')).toBe(false)
    expect(isModShortcut(press({ key: 'j', metaKey: true }), 'k', 'apple')).toBe(false)
  })

  it('read the platform from the user agent and are written its way', () => {
    expect(shortcutPlatform('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('apple')
    expect(shortcutPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe('apple')
    expect(shortcutPlatform('Mozilla/5.0 (X11; Linux x86_64)')).toBe('other')
    expect(shortcutLabel('k', 'apple')).toEqual({ label: '⌘K', aria: 'Meta+K' })
    expect(shortcutLabel('b', 'other')).toEqual({ label: 'Ctrl B', aria: 'Control+B' })
  })
})
