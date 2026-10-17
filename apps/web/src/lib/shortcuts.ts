// The app's keyboard shortcuts: a key with ⌘ on Apple's platforms and with Ctrl elsewhere (⌘K Jump to, ⌘B the
// sidebar's strip). Pure.

/** Which modifier the platform's shortcuts use: ⌘ on Apple's, Ctrl elsewhere. */
export type ShortcutPlatform = 'apple' | 'other'

/** The platform a browser's user agent names (an iPad's says Macintosh, which is right for its keyboard). */
export const shortcutPlatform = (userAgent: string): ShortcutPlatform =>
  /mac|iphone|ipad|ipod/iu.test(userAgent) ? 'apple' : 'other'

/** A key press, as much of it as decides whether it is a shortcut. */
export type ShortcutPress = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly repeat: boolean
  readonly isComposing: boolean
}

/**
 * Whether a key press is the platform's modifier with `key` alone: ⌘ on Apple's platforms, Ctrl elsewhere. Shift or
 * Option/Alt with it is another shortcut; a held key does not repeat it; an input method's letter composes.
 */
export function isModShortcut(press: ShortcutPress, key: string, platform: ShortcutPlatform): boolean {
  if (press.key.toLowerCase() !== key || press.repeat || press.isComposing) return false
  if (press.altKey || press.shiftKey) return false
  return platform === 'apple' ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey
}

/** A shortcut as the platform writes it (`⌘K`, `Ctrl K`) and as `aria-keyshortcuts` names it. */
export const shortcutLabel = (
  key: string,
  platform: ShortcutPlatform,
): { readonly label: string; readonly aria: string } =>
  platform === 'apple'
    ? { label: `⌘${key.toUpperCase()}`, aria: `Meta+${key.toUpperCase()}` }
    : { label: `Ctrl ${key.toUpperCase()}`, aria: `Control+${key.toUpperCase()}` }
