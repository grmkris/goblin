/**
 * Jump to (⌘K) from source in local Chromium, with the owner API answered by the fixture: the shortcut and the sidebar
 * row open it, focus moves into its field and back to where it was, the arrow keys and Enter open a result, Escape and
 * the shortcut close it, rows meet the target sizes, and opening sends no write. Desktop (Ctrl+K, Linux) and phone
 * (⌘K, iPhone, touch), light and dark; screenshots and a receipt go to `.local/goblin-acceptance/jump-<time>/`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Page, chromium } from 'playwright-core'
import type { AgentAppSummary, ServerView } from '@goblin/contracts'

/** The file descriptor this script's result line goes to (@cloudflare/workers-types makes `process` `any`). */
const STDOUT = 1

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `jump-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const SERVERS: ServerView[] = [
  {
    connectionId: 'mysi',
    label: 'mysi',
    endpoint: 'https://mysi.example/mcp',
    status: 'connected',
    live: true,
    source: 'added',
    entrypoint: 'open',
  },
  {
    connectionId: 'calendar',
    label: 'Calendar',
    endpoint: 'https://calendar.example/mcp',
    status: 'connected',
    live: true,
    source: 'added',
    entrypoint: 'open',
  },
]
const BUILT: AgentAppSummary[] = [
  {
    name: 'trip-tracker',
    title: 'Trip tracker',
    description: 'Flights, hotels and what is booked.',
    home: '20',
    app: '41',
    version: 3,
    revision: 3,
    jobs: [],
    waiting: 0,
    failure: null,
    updatedAt: 1,
  },
]
const HEALTH = {
  ok: true,
  service: 'goblin',
  signup: 'open',
  signIn: [],
  features: { largeFiles: true, agentApps: true, flows: true },
}

const UA = {
  linux: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  iphone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
}

const results: unknown[] = []

/** What has focus, as the test names it: the message field, the switcher's field, the Jump to row, or something else. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement
    if (active instanceof HTMLTextAreaElement) return 'message'
    if (active?.getAttribute('role') === 'combobox') return 'search'
    if (active?.textContent?.includes('Jump to…') === true) return 'row'
    return active?.tagName ?? 'none'
  })

const location = (page: Page) => page.getByLabel('Location').textContent()

/** The visible result rows, as label and detail. */
const rows = (page: Page) =>
  page
    .getByRole('option')
    .evaluateAll((options) => options.map((option) => option.textContent?.replaceAll(/\s+/gu, ' ').trim() ?? ''))

async function matrix(origin: string, page: Page, label: string, phone: boolean) {
  const errors: string[] = []
  const writes: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // Vite answers a module request 504 while it optimizes a dependency it found late, then reloads: not the page's.
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Outdated Optimize Dep')) errors.push(message.text())
  })
  await page.route(
    (url) => url.pathname.startsWith('/api/') || url.pathname === '/health',
    (route) => {
      const request = route.request()
      const { pathname } = new URL(request.url())
      if (request.method() !== 'GET') writes.push(`${request.method()} ${pathname}`)
      if (pathname === '/health') return route.fulfill({ json: HEALTH })
      if (pathname === '/api/mcp/servers') return route.fulfill({ json: SERVERS })
      if (pathname === '/api/agent-apps') return route.fulfill({ json: BUILT })
      errors.push(`Unexpected request: ${request.method()} ${pathname}`)
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not in fixture' } } })
    },
  )
  await page.goto(`${origin}jump.html`)
  const row = page.getByRole('button', { name: 'Jump to…' })
  await row.waitFor()
  const dialog = page.getByRole('dialog', { name: 'Jump to' })
  const search = page.getByRole('combobox', { name: 'Jump to' })
  const shortcut = phone ? 'Meta+k' : 'Control+k'

  const sideways = () => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert((await sideways()) <= 0, 'the fixture fits the screen')

  // The row names its shortcut; the hint shows at a keyboard and mouse only.
  assert.equal(await row.getAttribute('aria-keyshortcuts'), phone ? 'Meta+K' : 'Control+K')
  assert.equal(await row.locator('kbd').isVisible(), !phone, 'the shortcut hint shows only at a fine pointer')

  // The shortcut opens it from the message field; the field takes focus, the pages and Topics show, the first lit.
  await page.getByLabel('Message').focus()
  await page.keyboard.press(shortcut)
  await dialog.waitFor()
  assert.equal(await focused(page), 'search')
  const groups = await dialog.locator('[data-slot="autocomplete-group-label"]').allTextContents()
  assert.deepEqual(groups, ['Places', 'Topics'])
  assert.equal(await page.locator('[role="option"][data-highlighted]').count(), 1)
  assert.match((await rows(page))[0] ?? '', /^Activity\s?Page$/u)
  await page.screenshot({ path: path.join(out, `${label}-open.png`) })

  // Every row meets its target: 40px at a mouse, 44px on touch.
  const heights = await page
    .getByRole('option')
    .evaluateAll((options) => options.map((option) => option.getBoundingClientRect().height))
  assert(
    heights.every((height) => height >= (phone ? 44 : 40)),
    `row heights ${heights.join(', ')}`,
  )
  const overflow = await sideways()
  assert(overflow <= 0, `the page scrolls sideways by ${String(overflow)}px`)

  // A query finds a thread by its title, naming its Topic; Enter opens it in its channel's panel and closes the
  // switcher, and focus goes back to the message field.
  await search.fill('kyo')
  assert.deepEqual(await rows(page), ['Hotels in Kyoto near the stationThread in #Travel'])
  await page.screenshot({ path: path.join(out, `${label}-thread.png`) })
  await page.keyboard.press('Enter')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await location(page), '/c/20?thread=21')
  assert.equal(await focused(page), 'message')

  // The arrow keys move the highlight; Escape closes without going anywhere, and the shortcut closes it as well.
  await page.keyboard.press(shortcut)
  await dialog.waitFor()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  assert.match((await page.locator('[role="option"][data-highlighted]').textContent()) ?? '', /^Apps/u)
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await location(page), '/c/20?thread=21')
  assert.equal(await focused(page), 'message')
  await page.keyboard.press(shortcut)
  await dialog.waitFor()
  await page.keyboard.press(shortcut)
  await dialog.waitFor({ state: 'hidden' })

  // The row opens it too. The Apps: a pinned service once (not again as connected), a pinned view under its service,
  // a connected service's own App, and a built one.
  await row.click()
  await dialog.waitFor()
  const apps: string[] = []
  for (const query of ['mysi', 'board', 'cal', 'trip']) {
    await search.fill(query)
    apps.push(...(await rows(page)))
  }
  assert.deepEqual(apps, [
    'mysiApp · Pinned',
    'Hotel boardApp · mysi',
    'CalendarApp · Connected',
    'Trip trackerApp · Built for you',
  ])
  await search.fill('t')
  await page.screenshot({ path: path.join(out, `${label}-mixed.png`) })

  // A section opens its page at its anchor; a tap or a click opens a result as Enter does.
  await search.fill('rout')
  await page.getByRole('option', { name: /Routines/u }).click()
  await dialog.waitFor({ state: 'hidden' })
  assert.equal(await location(page), '/tasks#routines')
  if (!phone) assert.equal(await focused(page), 'row')

  // Nothing matches: it says so.
  await row.click()
  await search.fill('zzzz')
  await dialog.getByText('No matches.').waitFor()
  const box = await dialog.boundingBox()
  assert(box !== null)
  const viewport = page.viewportSize()?.width ?? 0
  assert(
    Math.abs(box.x - (viewport - box.x - box.width)) <= 1,
    `the dialog is centred (${String(box.x)}px from the left)`,
  )
  if (phone) assert(box.x >= 16, 'the dialog keeps a 16px gutter on a phone')
  await page.screenshot({ path: path.join(out, `${label}-empty.png`) })
  await page.keyboard.press('Escape')

  assert.deepEqual(writes, [], 'opening and jumping send no write')
  assert.deepEqual(errors, [])
  results.push({ label, heights: [Math.min(...heights), Math.max(...heights)], groups, apps })
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
try {
  for (const phone of [false, true])
    for (const colorScheme of ['light', 'dark'] as const) {
      const label = `${phone ? 390 : 1280}-${colorScheme}`
      const page = await browser.newPage({
        viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
        hasTouch: phone,
        isMobile: phone,
        userAgent: phone ? UA.iphone : UA.linux,
        colorScheme,
        reducedMotion: colorScheme === 'dark' ? 'reduce' : 'no-preference',
      })
      try {
        await matrix(origin, page, label, phone)
      } finally {
        await page.close()
      }
    }
} finally {
  writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ evidence: 'local Chromium with an HTTP fixture', results }, null, 2),
  )
  await browser.close()
  await vite.close()
}
writeSync(STDOUT, `${JSON.stringify({ checks: results.length, out })}\n`)
