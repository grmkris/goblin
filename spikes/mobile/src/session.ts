export interface SessionStore {
  readonly read: () => Promise<string | null>
  readonly write: (cookie: string) => Promise<void>
  readonly clear: () => Promise<void>
}

/** Web authentication stays in the browser's HttpOnly cookie jar. */
export const browserSession: SessionStore = {
  read: () => Promise.resolve(null),
  write: () => Promise.resolve(),
  clear: () => Promise.resolve(),
}
