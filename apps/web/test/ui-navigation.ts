/**
 * The real sidebar (ADR 0078) over a populated workspace: one highlighted row per page, counts, every pin state, the
 * strip and its shortcut, the Topics popover, and the phone's drawer and dot. Screenshots land in .local.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Page, chromium } from 'playwright-core'
import type { ServerView } from '@goblin/contracts'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `navigation-${Date.now()}`)
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
    connectionId: 'cloud',
    label: 'Cloud console',
    endpoint: 'https://cloud.example/mcp',
    status: 'needs_auth',
    live: false,
    source: 'added',
    entrypoint: 'dashboard',
  },
  {
    connectionId: 'notes',
    label: 'Notes',
    endpoint: 'https://notes.example/mcp',
    status: 'connected',
    live: true,
    source: 'added',
  },
]

/** The shown rows of the sidebar (or the drawer) that say they are where the page is (a hidden one is never read out). */
async function current(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll('nav.shell-sidebar [aria-current]')]
      .filter((row) => row.checkVisibility())
      .map((row) => `${row.getAttribute('aria-current') ?? ''} ${row.textContent?.trim().replace(/\s+/gu, ' ') ?? ''}`),
  )
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
const results: string[] = []
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        const pathname = new URL(route.request().url()).pathname
        if (pathname === '/api/mcp/servers') return route.fulfill({ json: SERVERS })
        if (pathname === '/api/health') return route.fulfill({ json: { features: { agentApps: true } } })
        errors.push(`Unexpected API request: ${route.request().method()} ${pathname}`)
        return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not in fixture' } } })
      },
    )
    const at = async (where: string) => {
      await page.goto(`${origin}navigation.html?at=${encodeURIComponent(where)}`)
      await page.locator('nav.shell-sidebar').first().waitFor()
      await page.getByText('Signed out').first().waitFor()
    }

    await at('/c/30?thread=31')
    assert.deepEqual(await current(page), ['page Hotel options in Lisbon'])
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-thread.png`) })

    await at('/a/9')
    assert.deepEqual(await current(page), ['page Trip tracker'])
    await at('/a/7')
    assert.deepEqual(await current(page), ['true Apps'])
    await at('/connections/mysi/app')
    assert.deepEqual(await current(page), ['page mysi'])
    await at('/p/7')
    assert.deepEqual(await current(page), ['true Personas'])
    await at('/personas')
    assert.deepEqual(await current(page), ['page Personas'])
    assert.equal(await page.locator('.list-row').count(), 2, 'active Personas listed, the archived folded')
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-personas.png`) })

    // Counts: Activity (an unread notification and a schedule in trouble), Work (a Delegate at work), All threads.
    const counts = await page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll('nav.shell-sidebar .sidebar-row')]
          .filter((row) => row.querySelector('.sidebar-count'))
          .map((row) => [
            row.querySelector('.sidebar-row-name')?.textContent ?? '',
            row.querySelector('.sidebar-count')?.textContent ?? '',
          ]),
      ),
    )
    assert.deepEqual(counts, { Activity: '2', Work: '1', 'All threads': '1' })
    // Every pin keeps its place and says why it does not open.
    const pins = await page.locator('[data-section="pinned"] .sidebar-row').allTextContents()
    assert.deepEqual(pins, ['mysi', 'Trip tracker', 'Old boardClosed', 'Cloud consoleSigned out'])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    assert.equal(overflow, 0)

    // The strip: ⌘B or Ctrl+B, remembered across a reload, names in tooltips, the Topics behind one `#`.
    await at('/c/1')
    await page.keyboard.press('Control+b')
    await page.waitForFunction(() => document.documentElement.dataset.sidebar === 'collapsed')
    const strip = await page.evaluate(() => document.querySelector('.shell-nav')?.getBoundingClientRect().width ?? 0)
    assert(strip < 64, `strip is narrow (${strip})`)
    await page.reload()
    await page.locator('nav.shell-sidebar').first().waitFor()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.sidebar), 'collapsed')
    await page.locator('.sidebar-place', { hasText: 'Activity' }).hover()
    await page.locator('[data-slot="tooltip-content"]', { hasText: 'Activity' }).waitFor()
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-strip.png`) })
    await page.getByRole('button', { name: /^Topics/u }).click()
    await page.getByRole('link', { name: 'Travel' }).click()
    await page.waitForFunction(() => document.querySelector('[data-slot="popover-content"]') === null)
    assert.deepEqual(await current(page), ['true Topics'])
    await page.getByRole('button', { name: 'Expand sidebar' }).click()
    assert.equal(await page.evaluate(() => document.documentElement.dataset.sidebar), undefined)

    assert.deepEqual(errors, [])
    results.push(`desktop ${colorScheme}: ok`)
    await context.close()
  }

  for (const colorScheme of ['light', 'dark'] as const) {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme,
    })
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => route.fulfill({ json: new URL(route.request().url()).pathname === '/api/mcp/servers' ? SERVERS : {} }),
    )
    await page.goto(`${origin}navigation.html?at=/apps`)
    const menu = page.getByRole('button', { name: /^Open navigation/u })
    await menu.waitFor()
    assert.equal(await menu.getAttribute('aria-label'), 'Open navigation, 2 waiting in Activity')
    assert.equal(await page.locator('.nav-button-dot').count(), 1)
    assert.equal(await page.locator('.shell-nav').count(), 0)
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-page.png`) })
    await menu.tap()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await drawer.waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-drawer.png`) })
    await drawer.getByRole('link', { name: 'Personas' }).tap()
    await drawer.waitFor({ state: 'detached' })
    await page.getByRole('heading', { name: 'Personas' }).first().waitFor()
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    assert.equal(overflow, 0)
    assert.deepEqual(errors, [])
    results.push(`phone ${colorScheme}: ok`)
    await context.close()
  }
} finally {
  await browser.close()
  await vite.close()
}
console.log(results.join('\n'))
console.log(`screenshots: ${out}`)
