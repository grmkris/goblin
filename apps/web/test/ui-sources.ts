/**
 * Local browser acceptance of Sources (ADR 0066) against real source components, at phone width in light and desk width
 * in dark: on a connection's card, a Source the agent proposed (no server suggests one, ADR 0068), the review card's
 * facts, a stale revision refused and then confirmed at the exact revision, and
 * the Source's conversations with a route picked; Activity's waiting conversation (set up to a Persona) and a Source
 * paused for review; Settings' Notify me via filled from the Source's answers and saved. No account or model call is
 * made; the owner API is routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'
import { mockRoute } from './mock-route.ts'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `sources-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const CHAT = {
  connectionId: 'chat',
  label: 'Chat',
  endpoint: 'https://chat.example.com/mcp',
  status: 'connected',
  live: true,
  source: 'added',
  events: 'open',
}

/** What the agent proposed for a Source on the chat server's messages: keyed by chat, the owner's when they say so. */
const PROPOSED = {
  key: [{ name: 'chat', pointer: '/chat' }],
  speaksForMe: { pointer: '/author/kind', equals: 'self' },
  read: { from: 'payload', text: '/text' },
  reply: {
    tool: 'post_reply',
    arguments: { chat: '{{key.chat}}', text: '{{text}}', operationId: '{{operationId}}' },
    maxChars: 3500,
    result: {
      accepted: { pointer: '/status', equals: 'accepted' },
      retryable: { pointer: '/status', equals: 'retryable' },
      rejected: { pointer: '/status', equals: 'rejected' },
    },
  },
}
const STREAMS = [
  {
    name: 'post.created',
    inputSchema: { type: 'object', properties: { chat: { type: 'string' } } },
    subscribable: true,
    title: 'Messages',
  },
]
const TOOLS = [{ name: 'post_reply', suggested: 'ask', modelVisible: true, granted: true }]

type Json = Record<string, unknown>

/** A Source as the owner API answers it. */
const sourceOf = (id: string, setup: unknown, state: string, fields: Json = {}): Json => ({
  id,
  connectionId: 'chat',
  label: 'Chat',
  title: 'Messages from Chat',
  setup,
  revision: 1,
  state,
  waiting: [],
  createdAt: 1,
  updatedAt: 1,
  ...fields,
})

const ACTIVE = 'src_00000000000000aa'
const REVIEW = 'src_00000000000000bb'
const SETUP = {
  ...PROPOSED,
  wake: { event: 'post.created', arguments: { chat: 'all' } },
  others: 'notice',
  newKeys: { to: 'held' },
}
const PROPOSAL = 'src_00000000000000cc'
const ROUTES = [
  {
    key: '["dm"]',
    values: { chat: 'dm' },
    route: { to: 'topic', topic: 1 },
    held: 0,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    key: '["g_team"]',
    values: { chat: 'g_team' },
    route: { to: 'held' },
    held: 2,
    revision: 0,
    updatedBy: 'default',
    createdAt: 1,
    updatedAt: 1,
  },
]

const errors: string[] = []
const confirms: unknown[] = []
const routes: unknown[] = []
const sinks: unknown[] = []

/** The owner API for one page: servers, events, tools, Sources (changed by each step) and Notify me via. */
async function serve(page: Page, label: string, sources: Map<string, Json>) {
  const routeRows = new Map<string, Json>(ROUTES.map((row) => [row.key, row]))
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  // Only the owner API: the fixture's own modules live under paths with `/api/` in them too.
  await mockRoute(
    page,
    ({ pathname }) => pathname.startsWith('/api/'),
    (route) => route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not here' } } }),
  )
  await mockRoute(page, '**/api/mcp/servers', (route) => route.fulfill({ json: [CHAT] }))
  await mockRoute(page, '**/api/mcp/chat/events', (route) => route.fulfill({ json: STREAMS }))
  await mockRoute(page, '**/api/mcp/chat/tools*', (route) => route.fulfill({ json: TOOLS }))
  await mockRoute(page, '**/api/notify-sink', (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: null })
    // SAFETY: Save sends the owner API's NotifySink.
    const body = route.request().postDataJSON() as Json
    sinks.push(body)
    return route.fulfill({ json: { ...body, label: 'Chat', updatedAt: 2 } })
  })
  await mockRoute(page, '**/api/sources', (route) => route.fulfill({ json: { sources: [...sources.values()] } }))
  await mockRoute(page, '**/api/sources/*/reply-result', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    // SAFETY: this fixture receives the typed owner API mutation from the reply rules editor.
    const body = route.request().postDataJSON() as { readonly revision: number; readonly result: unknown }
    assert.equal(body.revision, 1)
    assert.deepEqual(body.result, SETUP.reply?.result)
    const updated = { ...sources.get(id), revision: 2, state: 'proposed', setup: SETUP }
    sources.set(id, updated)
    return route.fulfill({ json: updated })
  })
  await mockRoute(page, '**/api/sources/*/confirm', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    confirms.push(route.request().postDataJSON())
    // A stale review is refused; the owner reads the current setup and confirms its revision.
    if (confirms.length % 2 === 1)
      return route.fulfill({
        status: 409,
        json: { error: { code: 'conflict', message: 'The source changed.', reason: 'source_revision' } },
      })
    const confirmed = { ...sources.get(id), state: 'active', confirmedAt: 2 }
    sources.set(id, confirmed)
    return route.fulfill({ json: confirmed })
  })
  await mockRoute(page, '**/api/sources/*/routes', (route) => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2) ?? ''
    if (route.request().method() === 'GET')
      return route.fulfill({ json: { source: sources.get(id), routes: [...routeRows.values()] } })
    // SAFETY: the route select sends the owner API's SourceRoutePick.
    const pick = route.request().postDataJSON() as { readonly key: string; readonly route: unknown }
    routes.push(pick)
    const current = sources.get(id)
    if (current !== undefined) sources.set(id, { ...current, waiting: [] })
    const row = routeRows.get(pick.key)
    const updated = { ...row, route: pick.route, held: 0, revision: 1, updatedBy: 'owner' }
    routeRows.set(pick.key, updated)
    return route.fulfill({ json: updated })
  })
}

const noSidewaysScroll = async (page: Page, label: string) => {
  const width = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(width <= 0, `${label}: scrolls sideways by ${String(width)}px`)
}

async function connection(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  await serve(page, label, new Map([[PROPOSAL, sourceOf(PROPOSAL, SETUP, 'proposed')]]))
  await page.goto(`${origin}sources.html?at=/connections`)
  await page.getByText('When /author/kind is "self": those become your own turns').waitFor()
  await page.getByText('Sent back with post_reply, in pieces of at most 3,500 characters').waitFor()
  await page.getByText('Held until you choose where they go').waitFor()
  await page.getByRole('button', { name: 'Edit reply result rules' }).click()
  await page.getByLabel('Reply result rules', { exact: true }).fill('{invalid')
  assert(
    await page.getByRole('button', { name: 'Save for review' }).isDisabled(),
    `${label}: invalid rules can be saved`,
  )
  await page.getByLabel('Reply result rules', { exact: true }).fill(JSON.stringify(SETUP.reply?.result, null, 2))
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-review.png`), fullPage: true })
  await page.getByRole('button', { name: 'Save for review' }).click()
  await page.getByText('Exact setup, revision 2').waitFor()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByText('This Source changed since you read it. Review its current revision below.').waitFor()
  await page.getByRole('button', { name: 'Confirm' }).click()
  await page.getByRole('button', { name: 'Conversations' }).waitFor()
  await page.getByRole('button', { name: 'Conversations' }).click()
  await page.getByText('chat g_team', { exact: true }).waitFor()
  await page.getByText('2 messages waiting').waitFor()
  await page.getByLabel('Where “chat g_team” goes').selectOption({ label: '#Team' })
  await page.waitForFunction(() => document.querySelector('[aria-busy="true"]') === null)
  assert.equal(
    await page.getByLabel('Where “chat g_team” goes').inputValue(),
    'answer:2',
    `${label}: route was not saved`,
  )
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-routes.png`), fullPage: true })
  await page.close()
}

async function activity(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  const sources = new Map<string, Json>([
    [
      ACTIVE,
      sourceOf(ACTIVE, SETUP, 'active', { waiting: [{ key: '["g_team"]', values: { chat: 'g_team' }, held: 2 }] }),
    ],
    [
      REVIEW,
      sourceOf(REVIEW, SETUP, 'paused', {
        title: 'Old inbox',
        paused: 'review',
        health: 'The access you confirmed it with changed.',
      }),
    ],
  ])
  await serve(page, label, sources)
  await page.goto(`${origin}sources.html?at=/activity`)
  await page.getByText('New conversation “chat g_team” on Messages from Chat').waitFor()
  await page.getByText('Review Old inbox').waitFor()
  await page.getByText('The access you confirmed it with changed.').waitFor()
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-activity.png`), fullPage: true })
  await page.getByLabel('Where “chat g_team” goes').selectOption({ label: '#Team' })
  await page.getByLabel('Who answers in “chat g_team”').selectOption({ label: '@Guide answers' })
  await page.locator('button').filter({ hasText: 'Set up' }).click()
  await page.getByText('New conversation “chat g_team” on Messages from Chat').waitFor({ state: 'detached' })
  await page.close()
}

async function settings(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const page = await browser.newPage(options)
  await serve(page, label, new Map([[ACTIVE, sourceOf(ACTIVE, SETUP, 'active')]]))
  await page.goto(`${origin}sources.html?at=/settings`)
  await page.getByText('Not set: your notices stay in Activity.').waitFor()
  assert.equal(await page.getByRole('link', { name: 'Connections', exact: true }).getAttribute('href'), '/connections')
  await page.getByLabel('Copy a Source’s answers').selectOption({ label: 'Messages from Chat' })
  await page.getByLabel('Which conversation notices go to').selectOption({ label: 'chat dm' })
  assert.equal(await page.getByLabel('Tool').inputValue(), 'post_reply', `${label}: tool not copied`)
  assert.match(await page.getByLabel('Arguments').inputValue(), /"chat": "dm"/u, `${label}: key not filled`)
  assert.deepEqual(
    JSON.parse(await page.getByLabel('Delivery and echo rules').inputValue()).result,
    SETUP.reply?.result,
    `${label}: result rules not copied`,
  )
  const policy = {
    result: {
      accepted: { pointer: '/status', equals: 'sent' },
      retryable: { pointer: '/status', equals: 'retryable' },
      rejected: { pointer: '/status', equals: 'rejected' },
      retryAt: '/retryAt',
    },
    echo: { event: 'post.created', arguments: { chat: 'all' } },
  }
  await page.getByLabel('Delivery and echo rules').fill(JSON.stringify(policy, null, 2))
  await noSidewaysScroll(page, label)
  await page.screenshot({ path: path.join(out, `${label}-notify.png`), fullPage: true })
  await page.getByRole('button', { name: 'Save' }).click()
  await page.getByText('Notices go to').waitFor()
  await page.close()
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
    await connection(browser, origin, label, options)
    await activity(browser, origin, label, options)
    await settings(browser, origin, label, options)
  }
  assert.deepEqual(errors, [])
  assert.deepEqual(confirms, [{ revision: 2 }, { revision: 2 }, { revision: 2 }, { revision: 2 }])
  assert.deepEqual(routes.slice(0, 2), [
    { key: '["g_team"]', route: { to: 'topic', topic: 2 } },
    { key: '["g_team"]', route: { to: 'persona', persona: 7, topic: 2 } },
  ])
  assert.deepEqual(sinks[0], {
    connectionId: 'chat',
    tool: 'post_reply',
    arguments: { chat: 'dm', text: '{{text}}', operationId: '{{operationId}}' },
    result: {
      accepted: { pointer: '/status', equals: 'sent' },
      retryable: { pointer: '/status', equals: 'retryable' },
      rejected: { pointer: '/status', equals: 'rejected' },
      retryAt: '/retryAt',
    },
    echo: { event: 'post.created', arguments: { chat: 'all' } },
  })
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, routes: routes.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
