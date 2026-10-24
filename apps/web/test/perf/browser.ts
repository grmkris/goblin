/**
 * What the transcript runners (`../ui-perf.ts`, `../ui-follow.ts`) share to drive the fixture page in a browser: a
 * static server for a built fixture, the faked stream and reads, and the device profiles. Runs in Bun, never in the page.
 */
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import type { Browser, Page } from 'playwright-core'
import { OPENINGS, installLiveReads } from '../agui-route.ts'
import { mockRoute } from '../mock-route.ts'
import { snapshot } from './transcript-fixture.ts'

const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

/** Built assets mirror public/_headers; documents revalidate. Missing assets must never cache an HTML fallback. */
export async function serve(dist: string, cacheHeaders = true): Promise<{ readonly origin: string; close(): void }> {
  const server = createServer((request, response) => {
    const name = new URL(request.url ?? '/', 'http://fixture').pathname
    const file = path.join(dist, name === '/' ? 'index.html' : name)
    const found = file.startsWith(dist) && existsSync(file) ? file : path.join(dist, 'index.html')
    if (name.startsWith('/assets/') && found !== file) {
      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    const headers: Record<string, string> = { 'content-type': TYPES[path.extname(found)] ?? 'application/octet-stream' }
    if (cacheHeaders)
      headers['cache-control'] = name.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
    response.writeHead(200, headers)
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
 * The fixture chat's stream as `ui-channel.ts` serves one (`../agui-route.ts`): its opening, then the page's batches
 * (`fixture-batch`) as they come, each as its events' `data` frames.
 */
export async function install(page: Page, entries: readonly Record<string, unknown>[]) {
  await installLiveReads(page)
  const body = JSON.stringify(snapshot(entries))
  await mockRoute(page, OPENINGS, (route) => route.fulfill({ body, contentType: 'application/json' }))
  await mockRoute(page, '**/api/**', (route) => route.fulfill({ json: {} }))
}
