/**
 * Local browser acceptance of the Telegram channel's chats (ADR 0055) against real source components, at phone width in
 * light and desk width in dark: the Chats list in mysi's card (the private chat with its topic, a waiting group with its
 * topic, a group goblin routed, a paused and a left one), a route picked and its responder (shown at once, then
 * saved), a refused pick put back with a calm line, the New chats default, the line and link while goblin sees only
 * the private chat, and Activity's offers (Not now remembered across a reload, Set up making a new Topic). No account
 * or model call is made; the owner API is routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `telegram-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

type Row = Record<string, unknown> & { readonly chat: string; readonly thread: number }

const row = (fields: Row): Row => ({
  kind: 'supergroup',
  status: 'routed',
  held: 0,
  offer: false,
  listed: true,
  revision: 0,
  ...fields,
})

/** The chats as the owner API answers them while goblin sees all the bot's chats. */
const chats = (): Row[] => [
  row({ chat: 'dm', thread: 0, title: 'Kris', kind: 'private', route: { mode: 'answer', topic: 1 } }),
  row({
    chat: 'dm',
    thread: 12,
    title: 'Ideas',
    chatTitle: 'Kris',
    kind: 'private',
    inherited: { mode: 'answer', topic: 1 },
  }),
  row({ chat: 'g_trip', thread: 0, title: 'Trip planning', isForum: true, status: 'pending', held: 3, offer: true }),
  row({ chat: 'g_trip', thread: 5, title: 'Packing list', chatTitle: 'Trip planning', status: 'pending', offer: true }),
  row({
    chat: 'g_book',
    thread: 0,
    title: 'Book club',
    kind: 'group',
    route: { mode: 'listen', topic: 3 },
    updatedBy: 'agent',
    updatedAt: 1,
    revision: 2,
  }),
  row({
    chat: 'g_family',
    thread: 0,
    title: 'Family',
    kind: 'group',
    status: 'paused',
    route: { mode: 'answer', topic: 1, persona: 7 },
  }),
  row({
    chat: 'g_old',
    thread: 0,
    title: 'Old team',
    kind: 'group',
    status: 'left',
    route: { mode: 'ignore' },
    listed: false,
  }),
]

const CHANNEL = { connectionId: 'mysi', enabledAt: 1_791_849_600, transport: 'events', reach: 'all', newChats: 'ask' }
const WIDEN = 'https://dev.mysi.lol/consent/widen?client=goblin'

const errors: string[] = []
const picks: unknown[] = []
const settings: unknown[] = []

/** The owner API for one page: the channel, its chats (changed by each pick), the settings, and nothing else. */
async function serve(page: Page, label: string, list: { reach: string; chats: Row[]; newChats: string }) {
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  // Only the owner API: the fixture's own modules live under paths with `/api/` in them too.
  await page.route(
    ({ pathname }) => pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not here' } } }),
  )
  await page.route('**/api/mcp/servers', (route) => route.fulfill({ json: [] }))
  await page.route('**/api/agent/channel', (route) =>
    route.fulfill({ json: { ...CHANNEL, reach: list.reach, newChats: list.newChats } }),
  )
  await page.route('**/api/agent/channel/chats', (route) =>
    route.fulfill({
      json: {
        reach: list.reach,
        ...(list.reach === 'dm' && { widenUrl: WIDEN }),
        newChats: list.newChats,
        synced: true,
        chats: list.chats,
      },
    }),
  )
  await page.route('**/api/agent/channel/settings', async (route) => {
    // SAFETY: the select sends the owner API's TelegramSettings.
    const body = route.request().postDataJSON() as { readonly newChats: string }
    settings.push(body)
    list.newChats = body.newChats
    await new Promise((resolve) => setTimeout(resolve, 200))
    return route.fulfill({ json: { ...CHANNEL, reach: list.reach, newChats: body.newChats } })
  })
  await page.route('**/api/agent/channel/routes', async (route) => {
    // SAFETY: the row sends the owner API's RoutePick.
    const pick = route.request().postDataJSON() as Record<string, unknown> & { chat: string; thread?: number }
    picks.push(pick)
    await new Promise((resolve) => setTimeout(resolve, 300))
    if (pick.chat === 'g_book') return route.fulfill({ status: 503, json: { error: 'Unavailable' } })
    const at = list.chats.findIndex((each) => each.chat === pick.chat && each.thread === (pick.thread ?? 0))
    const before = list.chats[at]
    assert(before !== undefined, `${label}: a pick for a chat not listed`)
    const topic = pick.newTopic === undefined ? pick.topic : 4
    const next =
      pick.mode === 'ignore'
        ? { mode: 'ignore' }
        : { mode: pick.mode, topic, ...(pick.persona !== undefined && { persona: pick.persona }) }
    const after: Row = {
      ...before,
      status: before.status === 'pending' ? 'routed' : before.status,
      route: next,
      held: 0,
      offer: false,
      updatedBy: 'owner',
      revision: Number(before.revision) + 1,
    }
    list.chats[at] = after
    return route.fulfill({ json: after })
  })
}

const noSidewaysScroll = async (page: Page, label: string) => {
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
}

async function chatsList(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  const list = { reach: 'all', chats: chats(), newChats: 'ask' }
  await serve(page, label, list)
  await page.goto(`${origin}telegram.html?at=/connections`)
  await page.getByText('Trip planning', { exact: true }).waitFor()
  await page.getByText('3 messages waiting').waitFor()
  await page.getByText('Group, set by goblin').waitFor()
  for (const words of ['Paused', 'Left', 'Waiting for you', 'Private chat'])
    await page.getByText(words, { exact: true }).first().waitFor()
  assert.equal(await page.getByLabel('Where “Ideas” goes').inputValue(), 'inherit', `${label}: topic not following`)
  assert.equal(await page.getByLabel('Where “Trip planning” goes').inputValue(), '', `${label}: waiting chat routed`)
  assert.equal(await page.getByLabel('Who answers in “Family”').inputValue(), 'persona:7', `${label}: Persona lost`)
  await noSidewaysScroll(page, label)
  if (options.isMobile === true) {
    const select = await page.getByLabel('Where “Trip planning” goes').boundingBox()
    const chat = await page.locator('.telegram-chat', { hasText: 'Trip planning' }).first().boundingBox()
    assert(select !== null && chat !== null && select.width >= chat.width - 1, `${label}: select is not full width`)
  }
  await page.screenshot({ path: path.join(out, `${label}-chats.png`), fullPage: true })

  // A pick shows at once and ends the wait; who answers follows it.
  await page.getByLabel('Where “Trip planning” goes').selectOption({ label: '#Travel' })
  assert.equal(await page.getByText('3 messages waiting').count(), 0, `${label}: still waiting while it saves`)
  await page.getByLabel('Who answers in “Trip planning”').waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null)
  await page.getByLabel('Who answers in “Trip planning”').selectOption({ label: '@Guide answers' })
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null)
  assert.equal(await page.getByLabel('Where “Trip planning” goes').inputValue(), 'answer:2')
  assert.equal(await page.getByLabel('Who answers in “Trip planning”').inputValue(), 'persona:7')

  // A refused pick is put back, with why under the title.
  await page.getByLabel('Where “Book club” goes').selectOption({ label: 'Ignore' })
  await page.getByText('Could not change where “Book club” goes.').waitFor()
  assert.equal(await page.getByLabel('Where “Book club” goes').inputValue(), 'listen:3', `${label}: refusal kept`)

  await page.getByLabel('New chats').selectOption({ label: 'New topic' })
  await page.getByText('Each new chat gets a Topic of its own').waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null)
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-routed.png`), fullPage: true })
  await page.close()
}

async function reach(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  await serve(page, label, { reach: 'dm', chats: chats().filter(({ chat }) => chat === 'dm'), newChats: 'ask' })
  await page.goto(`${origin}telegram.html?at=/connections`)
  await page.getByText('goblin sees only your private chat.').waitFor()
  const link = page.getByRole('link', { name: 'Let goblin see your groups' })
  assert.equal(await link.getAttribute('href'), WIDEN)
  assert.equal(await link.getAttribute('target'), '_blank')
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-reach.png`), fullPage: true })
  await page.close()
}

async function activity(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const context = await browser.newContext(options)
  const page = await context.newPage()
  const list = { reach: 'all', chats: chats(), newChats: 'ask' }
  await serve(page, label, list)
  await page.goto(`${origin}telegram.html?at=/activity`)
  await page.getByText('New Telegram chat “Trip planning”').waitFor()
  await page.getByText('New Telegram topic “Packing list” in Trip planning').waitFor()
  await page.getByText('3 messages waiting').waitFor()
  assert.equal(await page.getByLabel('Where “Trip planning” goes').inputValue(), 'answer:new', `${label}: no new Topic`)
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-activity.png`), fullPage: true })

  const packing = page.locator('.telegram-offer', { hasText: 'Packing list' })
  await packing.getByRole('button', { name: 'Not now' }).click()
  await packing.waitFor({ state: 'detached' })
  await page.reload()
  await page.getByText('New Telegram chat “Trip planning”').waitFor()
  assert.equal(await page.getByText('Packing list').count(), 0, `${label}: Not now forgotten on reload`)

  await page.locator('.telegram-offer', { hasText: 'Trip planning' }).getByRole('button', { name: 'Set up' }).click()
  await page.getByText('Nothing needs you.').waitFor()
  await context.close()
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
try {
  const views: readonly [string, BrowserContextOptions][] = [
    ['phone-light', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' }],
    ['desk-dark', { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }],
  ]
  for (const [label, options] of views) {
    await chatsList(browser, origin, label, options)
    await reach(browser, origin, label, options)
    await activity(browser, origin, label, options)
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(picks.slice(0, 4), [
    { chat: 'g_trip', thread: 0, mode: 'answer', topic: 2 },
    { chat: 'g_trip', thread: 0, mode: 'answer', topic: 2, persona: 7 },
    { chat: 'g_book', thread: 0, mode: 'ignore' },
    { chat: 'g_trip', thread: 0, mode: 'answer', newTopic: 'Trip planning' },
  ])
  assert.equal(picks.length, 8)
  assert.deepEqual(settings, [{ newChats: 'topic' }, { newChats: 'topic' }])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, picks: picks.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
