// The Durable Streams protocol as the agent writes it (`@durable-streams/server-cloudflare`'s `StreamObject`, one per
// stream path): create an epoch's stream with its opening events, append with the producer headers, close, and erase.
// goblin keys each object by its path and never mounts the library's own router; readers reach it through the Worker
// (`http/streams.ts`).
import type { StreamTier } from '@goblin/contracts'

/** One request to the stream object its path names, as the agent sends it (a test wraps it to lose answers). */
export type StreamsFetch = (request: Request) => Promise<Response>

/** The stream objects of `namespace`, each the one `idFromName` gives its path. */
export const streamsFetchOf =
  (namespace: DurableObjectNamespace): StreamsFetch =>
  (request) =>
    namespace.get(namespace.idFromName(new URL(request.url).pathname)).fetch(request)

/** Where a chat's stream of one tier lives in one epoch: the stream object's path, never a URL a reader sees. */
export const streamPath = (workspaceId: string, chat: string, tier: StreamTier, epoch: number): string =>
  `/s/${workspaceId}/${chat}/${tier}/${epoch}`

/** The origin internal stream requests are made on; only their path reaches the object. */
const ORIGIN = 'https://streams.internal'

/** How long a stream lives after its last read or write (sliding), in seconds: seven days. */
export const STREAM_TTL_SECONDS = 604_800

/** The one producer every stream has: the agent, at producer epoch 0 (an epoch of goblin's is a new stream). */
const PRODUCER = { 'producer-id': 'goblin', 'producer-epoch': '0' }

/**
 * How one write ended: `ok` (the stream holds it, also when it already did: a retry's duplicate), `retry` (it may not
 * have, try the same bytes again), `gone` (the stream expired or was erased) or `broken` (the stream will not take it,
 * so continuity is lost).
 */
export type Sent = 'ok' | 'retry' | 'gone' | 'broken'

/** What a status says about a write. */
const outcome = (status: number): Sent => {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 404 || status === 410) return 'gone'
  if (status === 408 || status === 429 || status >= 500) return 'retry'
  return 'broken'
}

/** One outbox row: `-1` creates the stream with its body, an empty body closes it, any other body is appended. */
export type Write = { readonly seq: number; readonly body: string }

/** The request that makes `write` on the stream at `path`. */
const requestOf = (path: string, write: Write): Request => {
  const url = `${ORIGIN}${path}`
  if (write.seq < 0)
    return new Request(url, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'stream-ttl': String(STREAM_TTL_SECONDS) },
      body: write.body,
    })
  const producer = { ...PRODUCER, 'producer-seq': String(write.seq) }
  if (write.body === '') return new Request(url, { method: 'POST', headers: { ...producer, 'stream-closed': 'true' } })
  return new Request(url, {
    method: 'POST',
    headers: { ...producer, 'content-type': 'application/json' },
    body: write.body,
  })
}

/**
 * Sends one outbox row to the stream at `path`. A create that finds the stream already there succeeded before (its
 * path is its epoch's own, and the row its only creator); an append the stream already holds answers 204, also `ok`.
 */
export async function send(fetchStream: StreamsFetch, path: string, write: Write): Promise<Sent> {
  try {
    const response = await fetchStream(requestOf(path, write))
    await response.body?.cancel()
    return outcome(response.status)
  } catch {
    // expected: a failed request may or may not have reached the stream, so the same bytes go again later
    return 'retry'
  }
}

/** Whether the stream at `path` is there: `unknown` when the object could not be asked. */
export async function streamExists(fetchStream: StreamsFetch, path: string): Promise<'yes' | 'no' | 'unknown'> {
  try {
    const response = await fetchStream(new Request(`${ORIGIN}${path}`, { method: 'HEAD' }))
    return response.ok ? 'yes' : response.status === 404 || response.status === 410 ? 'no' : 'unknown'
  } catch {
    // expected: the object could not be asked; the caller goes on as if it were there
    return 'unknown'
  }
}

/** Erases the stream at `path`; true once it is gone, also when it was gone before. */
export async function eraseStream(fetchStream: StreamsFetch, path: string): Promise<boolean> {
  const response = await fetchStream(new Request(`${ORIGIN}${path}`, { method: 'DELETE' }))
  await response.body?.cancel()
  return response.ok || response.status === 404 || response.status === 410
}
