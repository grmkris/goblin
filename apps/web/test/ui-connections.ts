/** The real Connections UI with an injected owner API: catalogue, compact cards, permissions and recovery. */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import type { ServerView, ToolView } from '@goblin/contracts'
import { SHELF } from './browser/services-fixture.ts'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `connections-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const SERVERS: ServerView[] = [
  {
    connectionId: 'mysi',
    label: 'mysi',
    endpoint: 'https://mysi.example/mcp',
    status: 'connected',
    live: true,
    source: 'added',
  },
  {
    connectionId: 'cloudflare',
    label: 'Cloudflare',
    endpoint: 'https://cloudflare.example/mcp',
    status: 'needs_auth',
    live: false,
    source: 'added',
  },
  {
    connectionId: 'notes',
    label: 'My research notes',
    endpoint: 'https://notes.example/mcp',
    status: 'disconnected',
    live: false,
    source: 'added',
  },
]
const TOOLS: ToolView[] = Array.from({ length: 16 }, (_, i) => ({
  name: `tool_${i}`,
  title: `Tool ${i}`,
  suggested: 'run',
  modelVisible: true,
  granted: i === 0,
  askFirst: i === 0,
}))
const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
try {
  for (const width of [1280, 390]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const label = `${width}-${colorScheme}`
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: width === 390,
        isMobile: width === 390,
        colorScheme,
        reducedMotion: colorScheme === 'dark' ? 'reduce' : 'no-preference',
      })
      const errors: string[] = []
      const writes: string[] = []
      let servers = [...SERVERS]
      let refuse = true
      let empty = false
      let release = Promise.withResolvers<void>()
      page.on('pageerror', (error) => errors.push(error.message))
      await page.route(
        (url) => url.pathname.startsWith('/api/'),
        async (route) => {
          const request = route.request()
          const pathname = new URL(request.url()).pathname
          if (request.method() !== 'GET') writes.push(`${request.method()} ${pathname}`)
          if (pathname === '/api/mcp/servers' && request.method() === 'POST') {
            await release.promise
            if (refuse)
              return route.fulfill({
                status: 502,
                json: {
                  error: {
                    code: 'upstream_mcp',
                    message: 'The MCP server did not respond as expected.',
                    connectionId: 'kiwi',
                    reason: 'remote-rpc',
                    ref: 'fixture',
                  },
                },
              })
            const added: ServerView = {
              connectionId: 'kiwi',
              label: 'Kiwi.com',
              endpoint: 'https://kiwi.example/mcp',
              status: 'connected',
              live: true,
              source: 'added',
            }
            servers.push(added)
            return route.fulfill({ status: 201, json: added })
          }
          if (pathname === '/api/mcp/kiwi/connect') return route.fulfill({ json: {} })
          if (pathname === '/api/mcp/servers') return route.fulfill({ json: empty ? [] : servers })
          if (pathname === '/api/mcp/suggested') return route.fulfill({ json: SHELF })
          if (/^\/api\/mcp\/[^/]+\/tools$/u.test(pathname)) return route.fulfill({ json: TOOLS })
          if (pathname === '/api/routines') return route.fulfill({ json: { routines: [] } })
          if (pathname === '/api/routines/settings')
            return route.fulfill({ json: { timezone: 'UTC', maxActive: 10, maxRunning: 2 } })
          if (pathname === '/api/sources') return route.fulfill({ json: { sources: [] } })
          if (pathname === '/api/mcp/registries') return route.fulfill({ json: [] })
          errors.push(`Unexpected API request: ${request.method()} ${pathname}`)
          return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not in fixture' } } })
        },
      )
      await page.goto(`${origin}connections.html`)
      await page.getByText('1 of 16 tools allowed', { exact: true }).waitFor()
      assert.equal(await page.getByRole('tab').count(), 0)
      assert.equal(await page.locator('.shelf-service').count(), 7)
      assert.equal(await page.locator('.connection-card').count(), 3)
      const layout = await page.evaluate(() => ({
        add: document.getElementById('add-title')?.getBoundingClientRect().top ?? 0,
        own: document.getElementById('servers-title')?.getBoundingClientRect().top ?? 0,
        columns: getComputedStyle(
          document.querySelector('.connections-grid') ?? document.body,
        ).gridTemplateColumns.split(' ').length,
        heights: [...document.querySelectorAll('.connection-card')].map((card) => card.getBoundingClientRect().height),
        overflow: document.documentElement.scrollWidth - innerWidth,
        shelfScrolls:
          (document.querySelector('.shelf-grid')?.scrollWidth ?? 0) >
          (document.querySelector('.shelf-grid')?.clientWidth ?? 0),
      }))
      assert(layout.add < layout.own)
      assert.equal(layout.columns, width === 390 ? 1 : 3)
      assert(
        layout.heights.every((height) => height < 210),
        `${label}: compact connections`,
      )
      assert.equal(layout.overflow, 0)
      assert.equal(layout.shelfScrolls, width === 390)
      if (width === 390) assert(layout.own < 600, 'Phone preview keeps existing connections within reach')
      await page.screenshot({ path: path.join(out, `${label}-overview.png`), fullPage: true })
      await page.getByRole('button', { name: 'See all 17 services' }).click()
      assert.equal(await page.locator('.shelf-service').count(), 17)
      assert.equal(await page.getByRole('button', { name: 'Add another Excalidraw' }).count(), 1)
      await page.getByRole('button', { name: 'Show fewer services' }).click()
      const address = page.getByRole('button', { name: 'Add by address', exact: true })
      await address.focus()
      await page.keyboard.press('Enter')
      await page.getByLabel("The server's address").fill('https://notes.example/mcp')
      await page.screenshot({ path: path.join(out, `${label}-address.png`), fullPage: true })
      await page.getByRole('button', { name: 'Close server search or address entry' }).click()
      assert(await address.evaluate((button) => button === document.activeElement))
      await page.getByRole('button', { name: 'Search catalogue' }).click()
      await page.getByRole('searchbox', { name: 'Search MCP registries' }).waitFor()
      await page.getByRole('button', { name: 'Close server search or address entry' }).click()
      const card = page.locator('#connection-mysi')
      await card.getByRole('button', { name: 'Manage access' }).click()
      await card.getByRole('switch', { name: 'Tool 0', exact: true }).waitFor()
      assert.equal(await card.getByRole('combobox', { name: 'When Tool 0 is called' }).inputValue(), 'ask')
      const sizes = await page.evaluate(() => ({
        grid: document.querySelector('.connections-grid')?.getBoundingClientRect().width,
        card: document.getElementById('connection-mysi')?.getBoundingClientRect().width,
      }))
      assert.equal(sizes.grid, sizes.card)
      await page.screenshot({ path: path.join(out, `${label}-access.png`), fullPage: true })
      await card.getByRole('button', { name: 'Hide access' }).click()
      assert.deepEqual(writes, [], 'Browsing and opening access must not grant or connect anything')
      const add = page.getByRole('button', { name: 'Add Kiwi.com', exact: true })
      await add.click()
      await page.waitForFunction(
        () => document.querySelector('[aria-label="Add Kiwi.com"]')?.getAttribute('aria-busy') === 'true',
      )
      assert.equal(await page.getByRole('button', { name: 'Add Cloudflare', exact: true }).getAttribute('disabled'), '')
      release.resolve()
      await page.getByRole('alert').filter({ hasText: 'ref fixture' }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-failed.png`), fullPage: true })
      refuse = false
      release = Promise.withResolvers<void>()
      release.resolve()
      await add.click()
      await page.locator('#connection-kiwi').waitFor()
      assert.deepEqual(writes, ['POST /api/mcp/servers', 'POST /api/mcp/servers', 'POST /api/mcp/kiwi/connect'])
      await page.goto(`${origin}connections.html#connection-mysi`)
      await page.locator('#connection-mysi').getByRole('button', { name: 'Hide access' }).waitFor()
      await page.waitForFunction(
        () => (document.getElementById('connection-mysi')?.getBoundingClientRect().top ?? 1000) < 80,
      )
      empty = true
      await page.goto(`${origin}connections.html`)
      await page.getByText('No servers yet', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-empty.png`), fullPage: true })
      assert.deepEqual(errors, [])
      await page.close()
    }
  }
  writeSync(
    1,
    `Connections browser checks passed at 1280px and 390px in light and dark, including reduced motion. Screenshots: ${out}\n`,
  )
} finally {
  await browser.close()
  await vite.close()
}
