/**
 * Whether Home (`/`, routes/index.tsx) opens a workspace or goblin's landing, on the server: signed in means the request
 * carries Better Auth's session cookie, under its `__Secure-` name over https and its plain name on the local stack. The
 * cookie is only a hint, since `OwnerGate` decides on every owner page.
 */
const SESSION_COOKIES = ['__Secure-better-auth.session_token', 'better-auth.session_token'] as const

/** Whether a request carries a session cookie, as `cookie` reads one by name. */
export const hasSessionCookie = (cookie: (name: string) => string | undefined): boolean =>
  SESSION_COOKIES.some((name) => (cookie(name) ?? '') !== '')
