/**
 * What the transcript runners (`../ui-perf.ts`, `../ui-follow.ts`) share to drive the fixture page in a browser: a
 * static server for a built fixture, the faked stream and reads, and the device profiles. Runs in Bun, never in the page.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { snapshot } from './transcript-fixture.ts'

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

/** Serves a built fixture from `dist`; anything that is not a file is the page. */
export async function serve(dist: string): Promise<{ readonly origin: string; close(): void }> {
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://fixture').pathname
    const file = path.join(dist, name === '/' ? 'index.html' : name)
    const found = file.startsWith(dist) && existsSync(file) ? file : path.join(dist, 'index.html')
    response.writeHead(200, { 'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream' })
    response.end(readFileSync(found))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('perf_fixture_address_missing')
  return { origin: `http://127.0.0.1:${address.port}`, close: () => server.close() }
}

export type Profile = { readonly cpu: number; readonly context: Parameters<Browser['newContext']>[0] }
export const PROFILES: Record<string, Profile> = {
  mobile: {
    cpu: 4,
    context: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true },
  },
  desktop: { cpu: 1, context: { viewport: { width: 1280, height: 800 } } },
}

/**
 * The fixture chat's stream as `ui-channel.ts` serves one (`../agui-route.ts`): the join, the epoch's opening at
 * `/streams/1`, and a live read the page's batches (`fixture-batch`) arrive on, each as one `data` frame and its
 * `control`.
 */
export async function install(page: Page, entries: readonly Record<string, unknown>[]) {
  await page.addInitScript(() => {
    let written = 0
    class Live extends EventTarget {
      readonly forward = (event: Event) => {
        if (!(event instanceof MessageEvent)) return
        const data: unknown = event.data
        if (typeof data !== 'string') return
        written += 1
        this.dispatchEvent(new MessageEvent('data', { data }))
        const control = { streamNextOffset: `live-${written}`, upToDate: true }
        this.dispatchEvent(new MessageEvent('control', { data: JSON.stringify(control) }))
      }
      constructor() {
        super()
        window.addEventListener('fixture-batch', this.forward)
      }
      close() {
        window.removeEventListener('fixture-batch', this.forward)
      }
    }
    Object.defineProperty(window, 'EventSource', { value: Live })
  })
  const body = JSON.stringify(snapshot(entries))
  await page.route('**/streams/**', (route) =>
    route.fulfill({
      body,
      contentType: 'application/json',
      headers: { 'stream-next-offset': 'opening', 'stream-up-to-date': 'true' },
    }),
  )
  await page.route('**/api/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname.endsWith('/stream'))
      return route.fulfill({
        json: { url: `${url.origin}/streams/1`, epoch: 1, tier: 'full', expiresAt: '2099-01-01T00:00:00.000Z' },
      })
    return route.fulfill({ json: {} })
  })
}
