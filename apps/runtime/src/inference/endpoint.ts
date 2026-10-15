// The owner's own model endpoint (ADR 0059): an OpenAI-compatible base URL and its key, checked by listing its models.
// The URL is a public https one, as an added MCP server's is; the list is the endpoint's claim, bounded and decoded.
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { InvalidInput } from '../http/errors.ts'
import { userEndpoint } from '../mcp/servers/endpoint.ts'

const MAX_MODELS = 500
const MAX_BODY = 1024 * 1024

const ModelList = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) })),
})
const decodeList = Schema.decodeUnknownOption(ModelList)

/** The base URL as the owner gave it, checked (public https, no credentials) and without a trailing slash. */
export const endpointBase = (raw: string): string => userEndpoint(raw).href.replace(/\/+$/u, '')

/**
 * The model ids `base` serves to `key` (`GET <base>/models`), in its order and without repeats. A refused key, an
 * answer that is not a model list, or one with no models is `InvalidInput`; an endpoint that cannot be reached too.
 */
export async function listModels(base: string, key: string, fetcher: typeof fetch): Promise<readonly string[]> {
  let response: Response
  try {
    response = await fetcher(`${base}/models`, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    // expected: the owner is told the endpoint could not be reached, never why in the network's words.
    throw new InvalidInput({ reason: 'model_endpoint_unreachable' })
  }
  if (response.status === 401 || response.status === 403) throw new InvalidInput({ reason: 'model_key_refused' })
  if (!response.ok) throw new InvalidInput({ reason: 'model_endpoint_refused' })
  const text = await response.text()
  if (text.length > MAX_BODY) throw new InvalidInput({ reason: 'model_list_too_large' })
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new InvalidInput({ reason: 'model_list_unreadable' })
  }
  const list = Option.getOrUndefined(decodeList(body))
  if (list === undefined) throw new InvalidInput({ reason: 'model_list_unreadable' })
  const ids = [...new Set(list.data.map((each) => each.id))].slice(0, MAX_MODELS)
  if (ids.length === 0) throw new InvalidInput({ reason: 'model_list_empty' })
  return ids
}

/** A key as the owner may see it again: its last four characters, or none of a short one. */
export const keyHint = (key: string): string => (key.length >= 16 ? `…${key.slice(-4)}` : '…')
