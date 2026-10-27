/**
 * Local browser look at goblin's landing (`/`, signed out) against its real source components, at phone and desktop
 * widths in light and dark: the hero's session playing, waiting on its question, answered by pressing Allow or on its
 * own, and at its end; the page in full; and, under reduced motion, the session already at its question, with Allow
 * still answering it. `/health` and the session check are routed here; no account is made. It checks the way in, that
 * every drawing is drawn, that the tool card's switches and the questions answer, and that nothing scrolls sideways,
 * and keeps screenshots. Whether a signed-in session leaves for its workspace is Home's (`routes/index.tsx`, ADR 0089),
 * which this fixture does not draw.
 *
 *   heavy bun apps/web/test/ui-landing.ts [--out <dir>]
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'
import { mockRoute } from './mock-route.ts'

const STDOUT = 1
const { values: options } = parseArgs({ options: { out: { type: 'string' } } })
const out =
  options.out ?? path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `landing-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const HEALTH = { ok: true, service: 'goblin', stage: 'dev', signup: 'invite', signIn: [{ method: 'email' }] }
const errors: string[] = []

/** A page of the fixture with `/health` and Better Auth's session answered, signed out. */
async function open(browser: Browser, origin: string, label: string, context: BrowserContextOptions) {
  const page = await browser.newPage(context)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${label}: ${String(response.status())} ${response.url()}`)
  })
  // Synthetic replies do not emit Playwright response events; retain the fixture's unexpected-API guard.
  await mockRoute(page, '**/api/**', (route) => {
    errors.push(`${label}: unexpected API request ${route.request().url()}`)
    return route.fulfill({ status: 404 })
  })
  await mockRoute(page, '**/health', (route) => route.fulfill({ json: HEALTH }))
  await mockRoute(page, '**/api/auth/get-session', (route) => route.fulfill({ json: null }))
  await page.goto(`${origin}landing.html`)
  await page.locator('.hero-session').waitFor()
  return page
}

async function noSideways(page: Page, label: string) {
  const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(sideways <= 0, `${label}: scrolls sideways by ${String(sideways)}px`)
}

/**
 * The chapters after the hero: every drawing is drawn (an etching is a luminance mask, so one that failed to load or
 * lost its mask would be a filled box or nothing), the tool card's switches change what it counts, and a question
 * opens to its answer.
 */
async function chapters(page: Page, label: string) {
  const etchings = await page
    .locator('.landing-etching')
    .evaluateAll((spans) =>
      spans.map((span) => [getComputedStyle(span).maskImage, getComputedStyle(span).maskMode, span.clientWidth > 0]),
    )
  assert.equal(etchings.length, 6, `${label}: two scenes and four chapters`)
  for (const [image, mode, drawn] of etchings) {
    assert.match(String(image), /etching-[a-z]+(?:-\d+)?[.-]/u, `${label}: an etching without its drawing`)
    assert.equal(mode, 'luminance', `${label}: an etching that is not a luminance mask`)
    assert.equal(drawn, true, `${label}: an etching with no size`)
  }
  const browser = page.getByRole('switch', { name: 'Open a browser' })
  await browser.scrollIntoViewIfNeeded()
  await page.getByText('3 of 4 tools allowed').waitFor()
  await browser.click()
  await page.getByText('4 of 4 tools allowed').waitFor()
  assert.equal(await page.getByRole('combobox', { name: 'When Open a browser is called' }).inputValue(), 'run')
  await browser.click()
  await page.getByText('3 of 4 tools allowed').waitFor()
  const cost = page.getByText('What does it cost?')
  await cost.scrollIntoViewIfNeeded()
  await cost.click()
  await page.getByText('goblin has no plans and takes no payments.', { exact: false }).waitFor()
  await cost.click()
}

/** The page as a visitor meets it: the session plays, waits, is answered (`press` Allow, or left to answer itself). */
async function drive(browser: Browser, origin: string, label: string, context: BrowserContextOptions, press: boolean) {
  const page = await open(browser, origin, label, context)
  const phone = context.isMobile === true
  // A phone shows the copy first: the session is looked at where the panel is, as a visitor scrolls to it.
  const shoot = async (name: string) => {
    if (phone) await page.locator('.moss-frame-panel').scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(out, `${label}-${name}.png`) })
  }
  await page.screenshot({ path: path.join(out, `${label}-first.png`) })
  await page.waitForTimeout(1500)
  await shoot('hero-playing')
  // The question is on screen once the orb waits on the owner (the Allow button is laid out, unseen, from the start).
  await page.getByText('Waiting for you').waitFor()
  await page.waitForTimeout(500)
  await shoot('hero-asking')
  const allow = page.getByRole('button', { name: 'Allow' })
  if (press) await allow.click()
  else await allow.scrollIntoViewIfNeeded()
  await page
    .locator('.hero-ask-receipt')
    .getByText('Allowed.', { exact: false })
    .waitFor({ timeout: press ? 3000 : 9000 })
  await page.locator('.hero-final[data-shown]').waitFor()
  await page.waitForTimeout(600)
  await shoot('hero-done')
  await page.evaluate(() => window.scrollTo(0, 0))
  // The way in and the command for this origin.
  assert.equal(await page.getByRole('link', { name: 'Meet your goblin' }).first().getAttribute('href'), '/login?new=1')
  assert.match(
    (await page.locator('.landing-command code').textContent()) ?? '',
    /^claude mcp add --transport http goblin http:\/\/127\.0\.0\.1:\d+\/mcp$/u,
  )
  assert.equal(await page.getByRole('link', { name: 'Source' }).count(), 0)
  await noSideways(page, label)
  await chapters(page, label)
  // Below the fold the screenshots load lazily: scroll through once so the whole page has them.
  for (const shot of await page.locator('.landing-shot img').all()) {
    await shot.scrollIntoViewIfNeeded()
    await shot.evaluate((image: HTMLImageElement) => image.decode())
  }
  await page.evaluate(() => window.scrollTo(0, 0))
  await page.screenshot({ path: path.join(out, `${label}-page.png`), fullPage: true })
  await page.close()
}

/** Under reduced motion the session is already at its question, nothing slides, and Allow still answers it. */
async function still(browser: Browser, origin: string, label: string, context: BrowserContextOptions) {
  const page = await open(browser, origin, label, { ...context, reducedMotion: 'reduce' })
  const allow = page.getByRole('button', { name: 'Allow' })
  await allow.waitFor({ state: 'visible', timeout: 1000 })
  assert.equal(await page.getByText('Asking Ferryhopper…').isVisible(), false)
  await page.locator('.moss-frame').screenshot({ path: path.join(out, `${label}-hero-still.png`) })
  await allow.click()
  await page.locator('.hero-ask-receipt').getByText('Allowed.', { exact: false }).waitFor({ timeout: 2000 })
  await page.locator('.hero-final[data-shown]').waitFor({ timeout: 2000 })
  await page.locator('.moss-frame').screenshot({ path: path.join(out, `${label}-hero-still-done.png`) })
  await noSideways(page, label)
  await page.close()
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
const phone = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }
const desktop = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 }
try {
  await drive(browser, origin, 'phone-light', { ...phone, colorScheme: 'light' }, true)
  await drive(browser, origin, 'desktop-dark', { ...desktop, colorScheme: 'dark' }, false)
  await drive(browser, origin, 'phone-dark', { ...phone, colorScheme: 'dark' }, false)
  await drive(browser, origin, 'desktop-light', { ...desktop, colorScheme: 'light' }, true)
  await still(browser, origin, 'phone-light-reduced', { ...phone, colorScheme: 'light' })
  await still(browser, origin, 'desktop-dark-reduced', { ...desktop, colorScheme: 'dark' })
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
