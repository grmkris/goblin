import { purposeMac, purposeMacMatches } from '../../runtime/purpose-key.ts'

/** The purpose a webhook's route token is made for. */
const PURPOSE = 'goblin/mcp-events-hook/connection'

/**
 * The route token of one connection's Events webhook (ADR 0041): purpose-separated from the credential key, bound to
 * the user and the connection, and checked before the Worker looks up this user's object.
 */
export const eventsHookToken = (credentialKey: string, workspaceId: string, connectionId: string): Promise<string> =>
  purposeMac(credentialKey, PURPOSE, `${workspaceId}\n${connectionId}`)
export const eventsHookTokenValid = (
  credentialKey: string,
  workspaceId: string,
  connectionId: string,
  token: string,
): Promise<boolean> => purposeMacMatches(credentialKey, PURPOSE, `${workspaceId}\n${connectionId}`, token)
/** Where a connection's producer posts its Events: one URL per connection, so subscriptions never collide. */
export const eventsHookUrl = (appUrl: string, workspaceId: string, connectionId: string, token: string): string =>
  `${new URL(appUrl).origin}/hooks/mcp-events/${encodeURIComponent(workspaceId)}/${encodeURIComponent(connectionId)}/${token}`
