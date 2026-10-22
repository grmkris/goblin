// The browser's live reads of the server, the transports the rest of the page reads through: a chat's AG-UI stream
// (`agui/reader.ts`), read with `fetch` from its endpoint under this page's workspace, and the workspace feed's
// server-sent events (`workspace/connection.ts`). Every other server call goes through the typed client.
import { requestId } from './api.ts'
import { isString } from './values.ts'
import { apiPath } from './workspace-path.ts'

/** Opens chat `id`'s stream: same origin, with the session's cookie, never cached. */
export const chatStream =
  (id: string) =>
  (signal: AbortSignal): Promise<Response> =>
    fetch(apiPath(`/api/conversations/${encodeURIComponent(id)}/stream`), {
      headers: { accept: 'text/event-stream', 'x-goblin-request': requestId() },
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    })

/** A frame's data, joined across its `data:` lines; none for a frame without one (a comment, a heartbeat). */
function dataOf(frame: string): string | undefined {
  const lines = frame
    .split('\n')
    .flatMap((line) => (line.startsWith('data:') ? [line.slice(5).replace(/^ /u, '')] : []))
  return lines.length === 0 ? undefined : lines.join('\n')
}

/** The whole frames at the front of `buffer`, and what is left of a frame still coming. */
function framesOf(buffer: string): { readonly frames: string[]; readonly rest: string } {
  const frames = buffer.split('\n\n')
  const rest = frames.pop() ?? ''
  return { frames, rest }
}

/**
 * Reads a server-sent events body to its end: each chunk's whole frames, their `data:` as one JSON event each, handed
 * to `events` (none for a chunk of comments alone, which still says the connection is alive). A frame that is not
 * JSON fails the read: the server sent something this tab cannot follow, so it connects again for a fresh opening.
 */
export async function readEvents(response: Response, events: (events: readonly unknown[]) => void): Promise<void> {
  const reader = response.body?.getReader()
  if (reader === undefined) return
  const decoder = new TextDecoder()
  let buffer = ''
  for (let read = await reader.read(); !read.done; read = await reader.read()) {
    const chunk: unknown = read.value
    if (!(chunk instanceof Uint8Array)) throw new TypeError('The stream is not bytes.')
    const { frames, rest } = framesOf(buffer + decoder.decode(chunk, { stream: true }).replaceAll('\r\n', '\n'))
    buffer = rest
    const parsed: unknown[] = []
    for (const data of frames.flatMap((frame) => dataOf(frame) ?? [])) parsed.push(JSON.parse(data))
    events(parsed)
  }
}

/** The workspace feed's server-sent events, as `WorkspaceFeedConnection` reads them; tests give their own. */
export interface FeedSource {
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void
  close(): void
  onError(listener: () => void): void
}
/** A message event whose data is text, as every server-sent event's is. */
const isTextMessage = (event: Event): event is MessageEvent<string> =>
  event instanceof MessageEvent && isString(event.data)

export class BrowserFeedSource implements FeedSource {
  readonly source: EventSource
  constructor(url: string) {
    this.source = new EventSource(url)
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.source.addEventListener(type, (event) => {
      if (isTextMessage(event)) listener(event)
    })
  }
  close(): void {
    this.source.close()
  }
  onError(listener: () => void): void {
    this.source.addEventListener('error', listener)
  }
}
