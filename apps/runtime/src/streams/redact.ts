// The last pass over a chat's stream before it leaves the agent (docs/architecture/streams.md): no secret goblin issues
// may reach a reader. Credentials never enter the events (they live sealed in the MCP store and the auth store), so
// this is a backstop, not the boundary: a string that holds something shaped like one of goblin's secrets is sent as
// `[redacted]`, whole.

/** What a string that held a secret is sent as. */
export const REDACTED = '[redacted]'

/**
 * The secrets goblin issues or keeps, as they look: a thread server's token (`swt_`, what a server declares a thread's
 * MCP server with) and a Standard Webhooks secret (`whsec_`, base64, `mcp/events/`). Eight characters past the prefix
 * are enough: a fragment of one, split across two text deltas, is caught as often as it can be.
 */
const SECRET = /swt_[\w-]{8}|whsec_[A-Za-z0-9+/=]{8}/u

/** `value` as JSON, every string in it that holds one of goblin's secrets sent as `[redacted]` instead. */
export const redactSecrets = (value: unknown): string =>
  JSON.stringify(value, (_key, each: unknown) => (typeof each === 'string' && SECRET.test(each) ? REDACTED : each))
