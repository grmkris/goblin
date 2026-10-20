/**
 * The scopes the owner turns on one by one on the consent page (ADRs 0024, 0086), in the order it offers them: what
 * the app may manage, then reading conversations and runs. Every other scope a client asks for (sign-in, a refresh
 * token) comes with Allow.
 */
export const OPTIONAL_SCOPES = ['goblin:topics', 'goblin:conversations', 'goblin:personas', 'goblin:inspect'] as const
export type OptionalScope = (typeof OPTIONAL_SCOPES)[number]

/** The scopes a client asked for, from the consent page's `scope` parameter. */
export const requestedScopes = (scope: string | null): readonly string[] =>
  (scope ?? '').split(' ').filter((name) => name !== '')

/** The opt-in scopes a client asked for, in the page's order. */
export const offeredScopes = (requested: readonly string[]): readonly OptionalScope[] =>
  OPTIONAL_SCOPES.filter((scope) => requested.includes(scope))

/**
 * What the consent page posts. Each opt-in scope is granted only when the owner turned it on: Allow grants what was
 * asked for without the ones left off. A request whose opt-in scopes are all on (or that asks for none), or a denial,
 * posts no scope and grants what was asked.
 */
export function consentBody(
  requested: readonly string[],
  accept: boolean,
  on: readonly string[],
): { readonly accept: boolean; readonly scope?: string } {
  const off: readonly string[] = offeredScopes(requested).filter((scope) => !on.includes(scope))
  if (!accept || off.length === 0) return { accept }
  return { accept, scope: requested.filter((name) => !off.includes(name)).join(' ') }
}
