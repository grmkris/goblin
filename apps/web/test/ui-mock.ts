/** Local Chromium regressions for API fixtures: heavy bun apps/web/test/ui-mock.ts. No model or cloud. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { chromium } from 'playwright-core'
import { FixtureStream, OPENINGS, installLiveReads } from './agui-route.ts'
import { mockRoute } from './mock-route.ts'

const requests: string[] = []
const server = createServer((request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://fixture').pathname
  requests.push(pathname)
  if (pathname === '/asset.js') {
    response.writeHead(200, {
      'content-type': 'text/javascript',
      'cache-control': 'public, max-age=31536000, immutable',
    })
    response.end('document.documentElement.dataset.asset = "loaded"')
  } else if (pathname.startsWith('/api/')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"native":true}')
  } else {
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-cache' })
    response.end('<!doctype html><script src="/asset.js"></script>')
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
assert(address !== null && typeof address !== 'string')
const origin = `http://127.0.0.1:${address.port}`
const browser = await chromium.launch()
const checks: string[] = []
try {
  const page = await browser.newPage()
  await mockRoute(page, '**/api/**', (route) => route.fulfill({ status: 404, json: { missing: true } }))
  await mockRoute(page, '**/api/echo?*', (route) =>
    route.fulfill({
      status: 201,
      headers: { 'x-fixture': 'echo' },
      json: {
        method: route.request().method(),
        headers: route.request().headers(),
        body: route.request().postDataJSON(),
      },
    }),
  )
  await mockRoute(page, '**/api/items/*', (route) => route.fulfill({ json: { item: true } }))
  await mockRoute(
    page,
    ({ pathname }) => pathname === '/w/demo/api/items',
    (route) => route.fulfill({ json: [] }),
  )
  await page.goto(origin)
  const echo = await page.evaluate(async () => {
    const response = await fetch(
      new Request(`${location.origin}/api/echo?q=1`, {
        method: 'POST',
        headers: { 'x-input': 'yes' },
        body: JSON.stringify({ input: 'hello' }),
      }),
    )
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      header: response.headers.get('x-fixture'),
      body: await response.json(),
    }
  })
  assert.equal(echo.status, 201)
  assert.equal(echo.type, 'application/json')
  assert.equal(echo.header, 'echo')
  assert.deepEqual(echo.body, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;charset=UTF-8', 'x-input': 'yes' },
    body: { input: 'hello' },
  })
  checks.push('Request input, method, body, headers, status and JSON response')

  const paths = await page.evaluate(async () =>
    Promise.all([
      fetch('/api/items/1').then((r) => r.json()),
      fetch('/api/items/1/extra').then((r) => r.status),
      fetch('/w/demo/api/items').then((r) => r.json()),
      fetch('/api/echoXq=1').then((r) => r.status),
    ]),
  )
  assert.deepEqual(paths, [{ item: true }, 404, [], 404])
  await mockRoute(page, '**/api/items/*', (route) => route.fulfill({ body: 'new', contentType: 'text/plain' }))
  assert.equal(await page.evaluate(() => fetch('/api/items/1').then((r) => r.text())), 'new')
  checks.push('glob/predicate matching, literal question mark, precedence and late registration')

  await mockRoute(page, '**/api/native', (route) => route.continue())
  assert.deepEqual(await page.evaluate(() => fetch('/api/native').then((r) => r.json())), { native: true })
  await mockRoute(page, '**/api/empty', (route) => route.fulfill({ status: 204 }))
  assert.equal(await page.evaluate(() => fetch('/api/empty').then((r) => r.text())), '')
  assert.deepEqual(
    requests.filter((name) => name.startsWith('/api/')),
    ['/api/native'],
  )
  checks.push('explicit native continuation, empty responses and no API HTTP traffic')

  const accepted = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  let calls = 0
  await mockRoute(page, '**/api/slow', async (route) => {
    calls += 1
    accepted.resolve()
    await release.promise
    await route.fulfill({ json: {} })
  })
  const pending = page.evaluate(async () => {
    const controller = new AbortController()
    const request = fetch(new Request(`${location.origin}/api/slow`, { signal: controller.signal }))
    setTimeout(() => controller.abort(), 100)
    return request.then(
      () => 'unexpected success',
      (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
    )
  })
  await accepted.promise
  assert.equal(await pending, 'AbortError')
  release.resolve()
  assert.equal(
    await page.evaluate(async () => {
      const controller = new AbortController()
      controller.abort()
      return fetch('/api/slow', { signal: controller.signal }).then(
        () => '',
        (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
      )
    }),
    'AbortError',
  )
  assert.equal(calls, 1)
  checks.push('pending and pre-aborted fetches, including Request.signal')

  await page.goto(`${origin}/second`)
  await page.reload()
  assert.equal(await page.evaluate(() => document.documentElement.dataset['asset']), 'loaded')
  assert.equal(requests.filter((name) => name === '/asset.js').length, 1)
  assert.equal(await page.evaluate(() => fetch('/api/items/1').then((r) => r.text())), 'new')
  checks.push('native asset cache and mocks survive second navigation and reload')
  await page.close()

  for (const order of ['live-first', 'mock-first']) {
    const streamPage = await browser.newPage()
    const stream = new FixtureStream('7', [{ type: 'opening' }])
    if (order === 'live-first') await installLiveReads(streamPage)
    await mockRoute(streamPage, OPENINGS, (route) => stream.opening(route))
    if (order === 'mock-first') await installLiveReads(streamPage)
    await streamPage.goto(origin)
    const read = await streamPage.evaluate(async () => {
      const controller = new AbortController()
      const response = await fetch(
        new Request(`${location.origin}/api/conversations/7/stream`, { signal: controller.signal }),
      )
      const reader = response.body?.getReader()
      const first = await reader?.read()
      window.dispatchEvent(new CustomEvent('fixture-agui', { detail: { chat: '7', events: [{ type: 'next' }] } }))
      const next = await reader?.read()
      controller.abort()
      const failure = await reader?.read().then(
        () => '',
        (error: unknown) => (error instanceof DOMException ? error.name : String(error)),
      )
      return { first: new TextDecoder().decode(first?.value), next: new TextDecoder().decode(next?.value), failure }
    })
    assert.equal(read.first, 'data: {"type":"opening"}\n\n')
    assert.equal(read.next, 'data: {"type":"next"}\n\n')
    assert.equal(read.failure, 'AbortError')
    assert.equal(stream.reads, 1)
    checks.push(`AG-UI opening, incremental frames and cancellation (${order})`)
    await streamPage.close()
  }
} finally {
  await browser.close()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  )
}
console.info(JSON.stringify({ evidence: 'local Chromium, synthetic HTTP and AG-UI', checks, passed: checks.length }))
