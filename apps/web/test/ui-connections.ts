/** The real Connections UI with an injected owner API: catalogue, compact cards, permissions and recovery. */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { mockRoute } from './mock-route.ts'
import type { ServerView, SetupCatalog, ToolView } from '@goblin/contracts'
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
    skillsOffered: true,
    skillsEnabled: false,
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
const SKILLS: SetupCatalog['libraries'][number]['skills'] = Array.from({ length: 10 }, (_, i) => ({
  name: `Research skill ${i + 1}`,
  uri: `skill://research/${i + 1}/SKILL.md`,
  description: `Find and compare sources for research step ${i + 1}.`,
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
      let catalogReads = 0
      let catalogAvailable = true
      let skills = SKILLS
      let catalogRelease = Promise.withResolvers<void>()
      let release = Promise.withResolvers<void>()
      page.on('pageerror', (error) => errors.push(error.message))
      await mockRoute(
        page,
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
      await mockRoute(page, '**/api/mcp/skills', (route) => {
        const change = JSON.parse(route.request().postData() ?? '{}')
        writes.push('PUT /api/mcp/skills')
        servers = servers.map((server) =>
          server.connectionId === change.connectionId ? { ...server, skillsEnabled: change.enabled } : server,
        )
        return route.fulfill({ json: change })
      })
      await mockRoute(page, '**/api/setup/catalog', async (route) => {
        catalogReads += 1
        await catalogRelease.promise
        return route.fulfill({
          json: {
            servers: [],
            apps: [],
            libraries: servers
              .filter((server) => server.skillsEnabled)
              .map((server) => ({
                connectionId: server.connectionId,
                label: server.label,
                available: catalogAvailable,
                skills,
              })),
          },
        })
      })
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
      const library = card.getByRole('region', { name: 'Skills', exact: true })
      await library.getByText('Turn on Use its skills', { exact: false }).waitFor()
      assert.equal(catalogReads, 0, 'A disabled skills library is never read')
      assert.deepEqual(writes, [], 'Opening access is read-only')
      await library.getByRole('switch', { name: 'Use its skills' }).click()
      await library.getByRole('status').getByText('Reading its skill library…').waitFor()
      catalogRelease.resolve()
      await library.getByText('10 skills available', { exact: true }).waitFor()
      await library.getByText('Research skill 1', { exact: true }).waitFor()
      await library.getByText('Find and compare sources for research step 1.', { exact: true }).waitFor()
      assert.equal(await library.locator('.skill-row:visible').count(), 8)
      const more = library.locator('summary')
      await more.focus()
      await page.keyboard.press('Enter')
      await library.getByText('Research skill 10', { exact: true }).waitFor()
      assert.equal(await library.locator('.skill-row:visible').count(), 10)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
      assert.deepEqual(writes, ['PUT /api/mcp/skills'], 'Only the explicit skill toggle writes')
      writes.length = 0
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
      catalogAvailable = false
      await page.reload()
      await library.getByText('Skills are on, but this server’s library is unavailable right now.').waitFor()
      catalogAvailable = true
      skills = []
      await library.getByRole('button', { name: 'Try again' }).click()
      await library.getByText('This server has no skills available right now.').waitFor()
      await page.screenshot({ path: path.join(out, `${label}-skills-empty.png`), fullPage: true })
      // Toggling must invalidate a fresh cached catalog, including another read after re-enabling.
      await library.getByRole('switch', { name: 'Use its skills' }).click()
      await library.getByText('Turn on Use its skills', { exact: false }).waitFor()
      skills = SKILLS.slice(0, 1)
      catalogRelease = Promise.withResolvers<void>()
      catalogRelease.resolve()
      await library.getByRole('switch', { name: 'Use its skills' }).click()
      await library.getByText('1 skill available', { exact: true }).waitFor()
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
