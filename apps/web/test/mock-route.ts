import type { Page, Request as BrowserRequest } from 'playwright-core'
import { mockFetch, type MockAnswer, type MockCall } from './mock-fetch.ts'

type MockRequest = Pick<BrowserRequest, 'url' | 'method' | 'headers' | 'postData' | 'postDataJSON'>
type Reply = {
  readonly status?: number
  readonly json?: unknown
  readonly body?: string
  readonly contentType?: string
  readonly headers?: Readonly<Record<string, string>>
}
export interface MockRoute {
  request(): MockRequest
  fulfill(reply: Reply): Promise<void>
  continue(): Promise<void>
}
type Pattern = string | ((url: URL) => boolean)
type Handler = { readonly matches: (url: URL) => boolean; readonly handle: (route: MockRoute) => unknown }
const routers = new WeakMap<Page, Promise<Handler[]>>()

/** The fixtures' glob subset: ** crosses slashes, * does not, and ? is literal, as in Playwright. */
function matcher(pattern: Pattern): (url: URL) => boolean {
  if (typeof pattern === 'function') return pattern
  const source = pattern
    .split(/(\*\*|\*)/u)
    .map((part) => {
      if (part === '**') return '.*'
      if (part === '*') return '[^/]*'
      return part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
    })
    .join('')
  const expression = new RegExp(`^${source}$`, 'u')
  return (url) => expression.test(url.href)
}

async function dispatch(handlers: readonly Handler[], call: MockCall): Promise<MockAnswer | null> {
  const handler = handlers.findLast(({ matches }) => matches(new URL(call.url)))
  if (handler === undefined) throw new Error(`Unmocked fixture fetch: ${call.method} ${call.url}`)
  let reply: MockAnswer | null | undefined
  await handler.handle({
    request: () => ({
      url: () => call.url,
      method: () => call.method,
      headers: () => ({ ...call.headers }),
      postData: () => call.body,
      postDataJSON: () => JSON.parse(call.body ?? 'null'),
    }),
    fulfill: (options) => {
      const headers = new Headers(options.headers)
      const json = 'json' in options
      if (json) headers.set('content-type', 'application/json')
      if (options.contentType !== undefined) headers.set('content-type', options.contentType)
      reply = {
        status: options.status ?? 200,
        headers: Object.fromEntries(headers),
        body: json ? (JSON.stringify(options.json) ?? null) : (options.body ?? null),
      }
      return Promise.resolve()
    },
    continue: () => {
      reply = null
      return Promise.resolve()
    },
  })
  if (reply === undefined) throw new Error(`Fixture handler did not answer: ${call.url}`)
  return reply
}

async function install(page: Page): Promise<Handler[]> {
  const handlers: Handler[] = []
  await page.exposeBinding('__goblinMock', ({ frame }, call: MockCall) => {
    if (frame !== page.mainFrame()) throw new Error('Fixture fetch must come from the main frame')
    return dispatch(handlers, call)
  })
  await page.addInitScript(mockFetch)
  await page.evaluate(mockFetch)
  return handlers
}

/**
 * Same-origin API fetch fixtures without network interception. The last matching handler wins, including handlers
 * registered after navigation. Only API, health and synthetic stream-opening fetches cross the test-process bridge;
 * Chromium loads documents/assets itself and keeps its HTTP cache. JSON/text only: retain page.route for documents,
 * binary, cross-origin traffic and genuine network failures. XHR, EventSource and WebSocket are not intercepted.
 */
export async function mockRoute(page: Page, pattern: Pattern, handle: (route: MockRoute) => unknown): Promise<void> {
  let pending = routers.get(page)
  if (pending === undefined) {
    pending = install(page)
    routers.set(page, pending)
  }
  const handlers = await pending
  handlers.push({ matches: matcher(pattern), handle })
}
