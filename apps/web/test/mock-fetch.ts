/** The serializable boundary between an in-page fetch and its fixture handler. */
export interface MockCall {
  readonly url: string
  readonly method: string
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | null
}

export interface MockAnswer {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | null
}

declare global {
  interface Window {
    __goblinMock(call: MockCall): Promise<MockAnswer | null>
    __goblinMockInstalled?: boolean
  }
}

/** Runs through addInitScript/evaluate: deliberately self-contained, with no imported runtime values. */
export function mockFetch(): void {
  if (window !== window.top || window.__goblinMockInstalled) return
  window.__goblinMockInstalled = true
  const native = window.fetch.bind(window)

  const fetchMock = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href)
    // AG-UI's existing live-read stand-in owns these streams. Assets and cross-origin fetches stay native.
    if (
      url.origin !== location.origin ||
      !/^(?:\/w\/[^/]+)?\/api\/|^\/__fixture\/|^\/health$/u.test(url.pathname) ||
      /\/conversations\/[^/]+\/stream$/u.test(url.pathname)
    )
      return native(input, init)
    const request = new Request(input instanceof Request ? input : url, init)
    request.signal.throwIfAborted()
    const body = request.body === null ? null : await request.clone().text()
    request.signal.throwIfAborted()
    let abort: (() => void) | undefined
    const cancellation = new Promise<never>((_resolve, reject) => {
      abort = () => reject(request.signal.reason)
      request.signal.addEventListener('abort', abort, { once: true })
    })
    let reply: MockAnswer | null
    try {
      reply = await Promise.race([
        window.__goblinMock({
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          body,
        }),
        cancellation,
      ])
    } finally {
      if (abort !== undefined) request.signal.removeEventListener('abort', abort)
    }
    if (reply === null) return native(request)
    const response = new Response(request.method === 'HEAD' ? null : reply.body, {
      status: reply.status,
      headers: reply.headers,
    })
    Object.defineProperty(response, 'url', { value: request.url })
    return response
  }
  Object.defineProperty(window, 'fetch', { configurable: true, writable: true, value: fetchMock })
}
