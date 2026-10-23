/**
 * The real Apps launcher (ADR 0078) with an injected owner API and a populated workspace: the four sections in order,
 * signed-out and gone pins kept in place, search, one-step reopen, a failed built-app read kept to its section, the
 * empty state's build action, target sizes and no page overflow, at desktop and phone sizes in both themes.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, type Page } from 'playwright-core'
import { mockRoute } from './mock-route.ts'
import type { AgentAppSummary, AppView, ServerView } from '@goblin/contracts'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `apps-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const server = (connectionId: string, extra: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'added',
  ...extra,
})
const SERVERS: ServerView[] = [
  server('mysi', { title: 'mysi', entrypoint: 'open' }),
  server('calendar-work', { label: 'Work', title: 'Calendar', status: 'needs_auth', entrypoint: 'home' }),
  server('calendar-home', { label: 'Home', title: 'Calendar', entrypoint: 'home' }),
  server('notes', { label: 'My research notes', title: 'Notes' }),
  server('trivago', { label: 'trivago hotels' }),
]
const job = {
  action: 'send',
  every: '1d',
  at: '07:00',
  nextAt: 0,
  lastAt: null,
  status: null,
  error: null,
  failures: 0,
  paused: null,
} as const
const built = (name: string, extra: Partial<AgentAppSummary>): AgentAppSummary => ({
  name,
  title: name,
  description: '',
  home: '20',
  app: null,
  version: 4,
  revision: 17,
  jobs: [],
  waiting: 0,
  failure: null,
  updatedAt: 1,
  ...extra,
})
const BUILT: AgentAppSummary[] = [
  built('trips', {
    title: 'Trip tracker',
    description: 'Flights, hotels and bookings for every trip, with what is still to book.',
    app: '40',
    waiting: 2,
  }),
  built('digest', { title: 'Morning digest', description: 'A short summary of the day, every morning.', jobs: [job] }),
  built('budget', {
    title: 'Household budget with a long name that wraps',
    description:
      'Tracks spending against the month’s plan by category, flags anything over budget and keeps a running total that reads at a glance.',
    app: '41',
  }),
]
const REOPENED: AppView = {
  id: '40',
  conversation: '20',
  title: 'Trip tracker',
  createdAt: 40,
  source: { kind: 'agent', name: 'trips', release: 'r4', version: 4, revision: 17, jobs: [] },
}

type Answers = { readonly servers: ServerView[]; readonly built: AgentAppSummary[] | 'fail' }

/** Answers the owner API as `answers` says, and records every write. */
async function serve(page: Page, answers: Answers, writes: string[], errors: string[]) {
  await mockRoute(
    page,
    (url) => url.pathname === '/health' || url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const { pathname } = new URL(request.url())
      if (request.method() !== 'GET') writes.push(`${request.method()} ${pathname}`)
      if (pathname === '/health')
        return route.fulfill({ json: { features: { largeFiles: false, agentApps: true, flows: false } } })
      if (pathname === '/api/mcp/servers') return route.fulfill({ json: answers.servers })
      if (pathname === '/api/agent-apps')
        return answers.built === 'fail'
          ? route.fulfill({ status: 503, json: { error: { code: 'unavailable', message: 'Down', ref: 'fixture' } } })
          : route.fulfill({ json: answers.built })
      if (pathname === '/api/apps/40' && request.method() === 'PATCH') return route.fulfill({ json: REOPENED })
      errors.push(`Unexpected API request: ${request.method()} ${pathname}`)
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not in fixture' } } })
    },
  )
}

const headings = (page: Page) => page.locator('h2').allTextContents()
const cardNames = (page: Page) => page.locator('.launcher-name').allTextContents()

/** That a 32px icon button is pressed `reach` px left of its centre, and the button before it keeps its own edge. */
async function targets(page: Page, reach: number) {
  return page.evaluate((offset) => {
    const more = document.querySelector<HTMLElement>('.launcher-actions > [aria-haspopup="menu"]')
    const open = more?.previousElementSibling
    if (more === null || !(open instanceof HTMLElement)) return { reached: false, separate: false }
    const box = more.getBoundingClientRect()
    const before = open.getBoundingClientRect()
    const y = box.top + box.height / 2
    const reached = more.contains(document.elementFromPoint(box.left + box.width / 2 - offset, y))
    const separate = open.contains(document.elementFromPoint(before.right - 1, before.top + before.height / 2))
    return { reached, separate }
  }, reach)
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
try {
  for (const width of [1280, 390]) {
    for (const colorScheme of ['light', 'dark'] as const) {
      const label = `${width}-${colorScheme}`
      const touch = width === 390
      const page = await browser.newPage({
        viewport: { width, height: 900 },
        hasTouch: touch,
        isMobile: touch,
        colorScheme,
        reducedMotion: colorScheme === 'dark' ? 'reduce' : 'no-preference',
      })
      const errors: string[] = []
      const writes: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await serve(page, { servers: SERVERS, built: BUILT }, writes, errors)
      await page.goto(`${origin}apps.html`)
      await page.getByRole('heading', { name: 'Built for you' }).waitFor()
      await page.locator('.launcher-card[data-kind="built"]').first().waitFor()
      assert.deepEqual(await headings(page), ['Pinned', 'Recent', 'Connected', 'Built for you'], label)
      assert.equal(await page.getByRole('tab').count(), 0, 'No tab strip')
      // Pinned keeps every stored pin in order, the signed-out and the gone ones too.
      assert.deepEqual(await page.locator('[data-kind="pin"] .launcher-name').allTextContents(), [
        'mysi',
        'Trip board',
        'Calendar',
        'Old receipt',
      ])
      assert.equal(await page.locator('[data-kind="pin"]').getByText('Signed out').count(), 1)
      assert.equal(await page.locator('[data-kind="pin"]').getByText('Not available').count(), 1)
      // Recent: open, unpinned tool-result views, newest first.
      assert.deepEqual(await page.locator('[data-kind="recent"] .launcher-name').allTextContents(), [
        'Weather in Lisbon',
        'Flight options',
        'Hotel results',
      ])
      // Connected: two accounts on one service stay two, and a tools-only connection is not an app.
      assert.deepEqual(await page.locator('[data-kind="connected"] .launcher-name').allTextContents(), [
        'mysi',
        'Calendar',
        'Calendar',
      ])
      assert.equal(await page.getByRole('button', { name: 'Reconnect' }).count(), 2)
      const layout = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - innerWidth,
        columns: getComputedStyle(document.querySelector('.launcher-grid') ?? document.body).gridTemplateColumns.split(
          ' ',
        ).length,
        radius: getComputedStyle(document.querySelector('.launcher-card') ?? document.body).borderRadius,
      }))
      assert.equal(layout.overflow, 0, `${label}: no sideways scroll`)
      assert.equal(layout.columns, touch ? 1 : 3, `${label}: columns`)
      assert.equal(layout.radius, '12px')
      const hit = await targets(page, touch ? 21 : 19)
      assert(hit.reached, `${label}: ⋯ takes ${touch ? 44 : 40}px`)
      assert(hit.separate, `${label}: Open and ⋯ do not overlap`)
      await page.screenshot({ path: path.join(out, `${label}-overview.png`), fullPage: true })
      // Search finds by name and by a connection's label, and says when nothing matches.
      const search = page.getByRole('searchbox', { name: 'Search apps by name or connection' })
      await search.fill('work')
      assert.deepEqual(await cardNames(page), ['Calendar', 'Calendar'])
      await search.fill('zzz')
      await page.getByText('No apps match “zzz”.').waitFor()
      await search.fill('')
      // Opening a closed built app reopens it and opens its page, in one step.
      await page.getByRole('button', { name: 'Open Trip tracker' }).click()
      await page.waitForFunction(() => document.body.dataset.opened === '40')
      assert.deepEqual(writes, ['PATCH /api/apps/40'], 'Only Open wrote, and only the reopen')
      assert.deepEqual(errors, [])
      await page.close()
    }
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors: string[] = []
  const writes: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  // A failed built-app read stays in its section; the others show, and nothing says there are no apps.
  await serve(page, { servers: SERVERS, built: 'fail' }, writes, errors)
  await page.goto(`${origin}apps.html`)
  await page.getByText('Could not load the apps built for you.', { exact: false }).waitFor()
  assert.deepEqual(await headings(page), ['Pinned', 'Recent', 'Connected', 'Built for you'])
  assert.equal(await page.getByText('No apps yet').count(), 0)
  await page.screenshot({ path: path.join(out, '1280-built-failed.png'), fullPage: true })
  await page.unrouteAll()
  // No App at all: Add a connection, and the build request written into a new thread of the last channel.
  await serve(page, { servers: [SERVERS[3] ?? server('notes')], built: [] }, writes, errors)
  await page.goto(`${origin}apps.html?empty`)
  await page.getByText('No apps yet').waitFor()
  await page.screenshot({ path: path.join(out, '1280-empty.png'), fullPage: true })
  await page.getByRole('button', { name: 'Ask goblin to build an app' }).click()
  assert.equal(await page.evaluate(() => document.body.dataset.asked), '1:Make me an app that ')
  assert.deepEqual(writes, [], 'Asking to build sends nothing')
  assert.deepEqual(errors, [])
  writeSync(1, `Apps browser checks passed at 1280px and 390px in light and dark. Screenshots: ${out}\n`)
} finally {
  await browser.close()
  await vite.close()
}
