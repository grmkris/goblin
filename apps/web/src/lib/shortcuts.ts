// The app's keyboard shortcuts with the platform's modifier: ⌘ on Apple's systems, Ctrl elsewhere. Pure.

/** What a shortcut needs to know of a key press. */
export type KeyPress = {
  readonly key: string
  readonly metaKey: boolean
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
}

/** Whether the system is Apple's, by what the browser says of it: ⌘ is its modifier. */
export const isApple = (platform: string): boolean => /mac|iphone|ipad|ipod/iu.test(platform)

/** Whether `event` is the platform's modifier with `key` and nothing else held. */
export const isModShortcut = (event: KeyPress, key: string, apple: boolean): boolean =>
  event.key.toLowerCase() === key &&
  !event.altKey &&
  !event.shiftKey &&
  (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)

/** The platform the browser runs on, as `isApple` reads it. */
export const browserPlatform = (): string =>
  typeof navigator === 'undefined' ? '' : (navigator.userAgent.match(/\(([^)]*)\)/u)?.[1] ?? navigator.userAgent)
