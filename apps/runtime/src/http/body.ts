import * as Predicate from 'effect/Predicate'
import { InvalidInput, PayloadTooLarge } from './errors.ts'

const DEFAULT_LIMIT = 65_536

/** Read at most `limit` bytes of the request body, whatever `content-length` claims (chunked bodies have none). */
export const readBytes = async (
  request: Pick<Request, 'headers' | 'body'>,
  limit = DEFAULT_LIMIT,
): Promise<Uint8Array<ArrayBuffer>> => {
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > limit) throw new PayloadTooLarge({ limit })
  if (request.body === null) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    // The stream's chunk type differs between runtimes' lib types; a request body streams bytes either way.
    const read: unknown = await reader.read()
    if (Predicate.hasProperty(read, 'done') && read.done === true) break
    const value = Predicate.hasProperty(read, 'value') ? read.value : undefined
    if (!(value instanceof Uint8Array)) throw new InvalidInput({ reason: 'body is not bytes' })
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new PayloadTooLarge({ limit })
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
