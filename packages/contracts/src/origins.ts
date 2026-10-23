import * as Schema from 'effect/Schema'
import { NonEmptyString } from './ids.ts'

/**
 * An MCP server origin the owner lets a key's threads connect to (ADR 0091), with exactly the tools they may call
 * there. `origin` is an https origin, normalized by `keyOriginsOf`; `tools` are explicit names, never `all`.
 */
export const KeyOrigin = Schema.Struct({
  origin: Schema.String.check(Schema.isMaxLength(200)),
  tools: Schema.Array(NonEmptyString(128)),
})
export type KeyOrigin = typeof KeyOrigin.Type

/** The most origins one key may hold, and the most tools one origin may name. */
const MAX_ORIGINS = 8
const MAX_TOOLS = 50

/** A host no key's thread may reach: an IP literal, a single label, or a name kept for local and private networks. */
const privateHost = (name: string): boolean => {
  // A trailing dot names the same host (`localhost.`, `api.internal.`): it is no way around the checks below.
  const host = name.replace(/\.+$/u, '')
  return (
    !host.includes('.') ||
    /^\d{1,3}(\.\d{1,3}){3}$/u.test(host) ||
    host.startsWith('[') ||
    ['.localhost', '.local', '.internal', '.home.arpa', '.lan'].some((suffix) => `.${host}`.endsWith(suffix))
  )
}

/** `text`'s https origin (scheme, host and port), or none when it is anything more or less than one. */
const originOf = (text: string): string | undefined => {
  if (!URL.canParse(text)) return undefined
  const url = new URL(text)
  const bare =
    url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''
  return url.protocol === 'https:' && bare && !privateHost(url.hostname) ? url.origin : undefined
}

/**
 * A key's origins as stored (ADR 0091): each origin normalized, at most 8 and none twice (`key_origin` otherwise), and
 * each with 1 to 50 tools, none of them `all` (`key_origin_tools` otherwise).
 */
export const keyOriginsOf = (
  origins: readonly KeyOrigin[],
): { readonly origins: readonly KeyOrigin[] } | { readonly problem: 'key_origin' | 'key_origin_tools' } => {
  const normalized = origins.map((each) => ({ origin: originOf(each.origin), tools: [...new Set(each.tools)] }))
  const valid = normalized.flatMap((each) => (each.origin === undefined ? [] : [{ ...each, origin: each.origin }]))
  if (origins.length > MAX_ORIGINS || valid.length < origins.length) return { problem: 'key_origin' }
  if (new Set(valid.map((each) => each.origin)).size < valid.length) return { problem: 'key_origin' }
  if (valid.some(({ tools }) => tools.length === 0 || tools.length > MAX_TOOLS || tools.includes('all')))
    return { problem: 'key_origin_tools' }
  return { origins: valid }
}

/** The origin a thread's server `url` is on, as `keyOriginsOf` stores origins; none for one no key may name. */
export const serverOriginOf = (url: string): string | undefined => {
  if (!URL.canParse(url)) return undefined
  const { protocol, hostname, origin } = new URL(url)
  return protocol === 'https:' && !privateHost(hostname) ? origin : undefined
}
