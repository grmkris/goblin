// The browser's live reads of the server, the transports the rest of the page reads through: a chat's AG-UI stream
// (`agui/reader.ts`) over `fetch` and `EventSource` at the URL its join answered, and the workspace feed's
// server-sent events (`workspace/connection.ts`). Every other server call goes through the typed client.
import type { StreamTransport } from './agui/reader.ts'
import { isString, record, records } from './values.ts'

const header = (response: Response, name: string): boolean => response.headers.get(name)?.toLowerCase() === 'true'

/** `url` with the protocol's reading parameters. */
function readUrl(url: string, offset: string, live?: 'long-poll' | 'sse'): string {
  const target = new URL(url, globalThis.location?.href)
  target.searchParams.set('offset', offset)
  if (live !== undefined) target.searchParams.set('live', live)
  return target.href
}

/** A server-sent event's text. */
function textOf(event: Event): string | undefined {
  if (!(event instanceof MessageEvent)) return undefined
  const data: unknown = event.data
  return isString(data) ? data : undefined
}

/** JSON as a value, or none. */
function json(data: string): unknown {
  try {
    return JSON.parse(data)
  } catch {
    // expected: a frame that is not JSON is read as none and the read starts again from its offset
    return undefined
  }
}

/** The stream over `fetch` and `EventSource`, as the browser reads it. */
export const browserTransport: StreamTransport = {
  read: async (url, offset, longPoll, signal) => {
    const response = await fetch(readUrl(url, offset, longPoll ? 'long-poll' : undefined), {
      signal,
      cache: 'no-store',
    })
    const events = response.status === 200 ? records(await response.json()) : []
    return {
      status: response.status,
      events,
      next: response.headers.get('stream-next-offset') ?? undefined,
      closed: header(response, 'stream-closed'),
      upToDate: header(response, 'stream-up-to-date') || response.status === 204,
    }
  },
  live: (url, offset, listener) => {
    const source = new EventSource(readUrl(url, offset, 'sse'))
    let pending: readonly unknown[] = []
    source.addEventListener('data', (event) => {
      const data = textOf(event)
      if (data !== undefined) pending = [...pending, ...records(json(data))]
    })
    source.addEventListener('control', (event) => {
      const data = textOf(event)
      const control = data === undefined ? undefined : record(json(data))
      if (control === undefined || !isString(control.streamNextOffset)) return
      const events = pending
      pending = []
      listener.events(events, control.streamNextOffset, control.streamClosed === true)
    })
    source.addEventListener('error', () => {
      source.close()
      listener.error()
    })
    return () => source.close()
  },
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
