/**
 * Where every outbound sign-in comes back (ADR 0089): one address on the app's origin for every workspace, so each
 * authorization server knows goblin by one redirect URI and a sign-in in progress outlives a workspace's new slug.
 */
export const SIGN_IN_CALLBACK = '/api/mcp/oauth/callback'

/**
 * A sign-in's `state`: the workspace whose agent began it, then a random UUID. The edge routes the callback by the
 * workspace, after reading the person's membership of it; the agent takes the pending exchange the whole state names.
 */
export const signInState = (workspaceId: string): string => `${workspaceId}.${crypto.randomUUID()}`

const STATE = /^([\w-]{1,200})\.[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/u

/** The workspace a sign-in's `state` names, when it is one goblin made. */
export const stateWorkspace = (state: string | null): string | undefined =>
  state === null ? undefined : STATE.exec(state)?.[1]
