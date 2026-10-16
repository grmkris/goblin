/**
 * Local browser look at first-run Start (ADR 0062) against its real source components, at phone and desktop widths:
 * the splash, the welcome, the model step on the deployment's models and on the owner's own, services before and after a
 * server connects (with its suggested access offered, then in place), and the kickoff. No account or model call is
 * made; the owner API is routed here. It checks that no screen scrolls sideways and keeps screenshots.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, chromium } from 'playwright-core'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `start-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const DEPLOYMENT = { source: 'deployment', deployment: true, models: ['house-model', 'house-model-mini'] }
const OWN = {
  source: 'owner',
  deployment: true,
  baseUrl: 'https://models.example/v1',
  keyHint: 'k3y9',
  models: ['own-model'],
}
const NOTES = {
  connectionId: 'notes',
  label: 'Notes',
  endpoint: 'https://notes.example/mcp',
  status: 'connected',
  live: true,
  source: 'added',
}
/** The connected server's tools: one that says it only reads, one that does not. */
const tools = (granted: boolean) =>
  [
    { name: 'read_note', suggested: 'run', readOnlyHint: true },
    { name: 'write_note', suggested: 'ask', readOnlyHint: false },
  ].map((tool) => ({
    ...tool,
    description: tool.name,
    modelVisible: true,
    granted,
    ...(granted && tool.suggested === 'ask' ? { askFirst: true } : {}),
  }))
const steps = (done: readonly string[]) =>
  ['welcome', 'model', 'services', 'goblin'].map((id) => ({ id, done: done.includes(id) }))
const view = (done: readonly string[], model = DEPLOYMENT, connected = 0) => ({
  status: 'open',
  steps: steps(done),
  model,
  connected,
  kickoff: false,
})

/** Each screen: where the page opens, Start's view, the model endpoint, the servers and the connected one's tools. */
const SCREENS = [
  { name: 'splash', at: '/splash', view: view([]), servers: [], granted: false },
  { name: 'welcome', at: '/start/welcome', view: view([]), servers: [], granted: false },
  { name: 'model', at: '/start/model', view: view(['welcome']), servers: [], granted: false },
  { name: 'model-own', at: '/start/model', view: view(['welcome', 'model'], OWN), servers: [], granted: false },
  { name: 'services', at: '/start/services', view: view(['welcome', 'model']), servers: [], granted: false },
  {
    name: 'services-connected',
    at: '/start/services?connected=notes',
    view: view(['welcome', 'model'], DEPLOYMENT, 1),
    servers: [NOTES],
    granted: false,
  },
  {
    name: 'services-suggested',
    at: '/start/services?connected=notes',
    view: view(['welcome', 'model'], DEPLOYMENT, 1),
    servers: [NOTES],
    granted: true,
  },
  {
    name: 'goblin',
    at: '/start/goblin',
    view: view(['welcome', 'model', 'services'], DEPLOYMENT, 1),
    servers: [NOTES],
    granted: true,
  },
] as const

/** The shelf as the runtime serves it (apps/runtime/src/mcp/servers/shelf.ts), one server already added. */
const SHELF = [
  [
    'mysi',
    'mysi',
    'yours',
    true,
    'Your my* apps in one connection: notes, browsers, Telegram, email, skills and terminals.',
  ],
  [
    'cloudflare',
    'Cloudflare',
    'publish',
    true,
    'Publish a page or a small app as a Worker on your Cloudflare account.',
  ],
  [
    'kiwi',
    'Kiwi.com',
    'travel',
    false,
    'Flight search across airlines, with prices and a booking link for each option.',
  ],
  ['trivago', 'trivago', 'travel', false, 'Hotels and their prices across booking sites, in a view you can browse.'],
  [
    'ferryhopper',
    'Ferryhopper',
    'travel',
    false,
    'Ferry routes, times and prices, mostly around Europe, in a view you can browse.',
  ],
  [
    'wikidata',
    'Wikidata',
    'knowledge',
    false,
    'Facts about people, places and works, and how they connect, from Wikidata.',
  ],
  [
    'microsoft-learn',
    'Microsoft Learn',
    'knowledge',
    false,
    "Microsoft's documentation and code samples: Azure, .NET, Microsoft 365 and the rest.",
  ],
  [
    'aws-knowledge',
    'AWS Knowledge',
    'knowledge',
    false,
    'AWS documentation and guidance, and which services each region offers.',
  ],
  [
    'huggingface',
    'Hugging Face',
    'knowledge',
    false,
    'Search models, datasets and Spaces on Hugging Face, and read their files.',
  ],
  [
    'coingecko',
    'CoinGecko',
    'crypto',
    false,
    "Crypto prices, market caps and coin details from CoinGecko's public data.",
  ],
  [
    'etherscan',
    'Etherscan',
    'crypto',
    false,
    'Balances, transactions and contracts on Ethereum and other EVM chains, on its keyless tier.',
  ],
  ['excalidraw', 'Excalidraw', 'apps', false, 'Hand-drawn diagrams your agent sketches, live in the chat.'],
  [
    'subwayinfo',
    'SubwayInfo.nyc',
    'apps',
    false,
    'New York transit: live subway, bus, ferry and rail arrivals, alerts and trip plans.',
  ],
  [
    'deepwiki',
    'DeepWiki',
    'code',
    false,
    'Questions about any public GitHub repository, answered from its generated wiki.',
  ],
  ['context7', 'Context7', 'code', false, 'Current documentation and code examples for programming libraries.'],
  ['cloudflare-docs', 'Cloudflare Docs', 'code', false, "Search Cloudflare's developer documentation."],
  ['svelte', 'Svelte', 'code', false, 'Svelte and SvelteKit documentation, and a checker that fixes Svelte code.'],
].map(([id, title, group, signIn, description]) => ({
  id,
  title,
  description,
  endpoint: `https://${String(id)}.example/mcp`,
  group,
  signIn,
  ...(['cloudflare', 'trivago', 'wikidata', 'huggingface', 'excalidraw', 'cloudflare-docs', 'svelte'].includes(
    String(id),
  )
    ? { icon: `/shelf/${String(id)}.svg` }
    : {}),
  added: id === 'excalidraw',
}))

/** The shelf's columns at this width: one on a phone, two on a tablet, three beside Start's panel on a desktop. */
const COLUMNS: Readonly<Record<string, number>> = { 'phone-light': 1, 'tablet-light': 2, 'desktop-dark': 3 }

const errors: string[] = []

/** Waits for what screen `name` shows: its title (the splash, its mark), and what tells its state apart. */
async function shows(page: Page, name: (typeof SCREENS)[number]['name']): Promise<void> {
  if (name === 'splash') return page.getByRole('status').waitFor()
  await page.locator('#start-title').waitFor()
  if (name === 'model') return page.getByText("Your agent uses this deployment's 2 models.").waitFor()
  if (name === 'model-own') return page.getByText('https://models.example/v1').waitFor()
  if (name === 'services-connected') {
    await page.getByText('Notes is connected. goblin can use none of its tools yet.').waitFor()
    return page.getByRole('button', { name: 'Use suggested access' }).waitFor()
  }
  if (name === 'services-suggested') {
    await page.getByText('Notes is connected, with its suggested access.').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Use suggested access' }).count(), 0)
  }
}

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  for (const screen of SCREENS) {
    const page = await browser.newPage(options)
    page.on('pageerror', (error) => errors.push(`${label} ${screen.name}: ${error.message}`))
    page.on('response', (response) => {
      if (response.status() >= 400)
        errors.push(`${label} ${screen.name}: ${String(response.status())} ${response.url()}`)
    })
    await page.route('**/api/**', (route) => {
      const { pathname } = new URL(route.request().url())
      // Only the owner API is answered here; the fixture's own modules (`/@fs/…/src/api/…`) load as they are.
      if (!pathname.startsWith('/api/')) return route.continue()
      const json = (body: unknown) => route.fulfill({ json: body })
      if (pathname === '/api/auth/get-session')
        return json({ session: { id: 's', userId: 'u' }, user: { id: 'u', email: 'owner@example.com' } })
      if (pathname === '/api/onboarding') return json(screen.view)
      if (pathname === '/api/agent/model-endpoint') return json(screen.view.model)
      if (pathname === '/api/mcp/servers') return json(screen.servers)
      if (pathname === '/api/mcp/notes/tools') return json(tools(screen.granted))
      if (pathname === '/api/mcp/suggested') return json(SHELF)
      return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not here' } } })
    })
    await page.goto(`${origin}start.html?at=${encodeURIComponent(screen.at)}`)
    await page.waitForLoadState('networkidle')
    await shows(page, screen.name)
    if (screen.name === 'services') {
      const shelf = await page.evaluate(() => ({
        columns: getComputedStyle(document.querySelector('.shelf-grid') ?? document.body).gridTemplateColumns.split(' ')
          .length,
        icons: [...document.querySelectorAll<HTMLImageElement>('.server-mark > img')].map((icon) => icon.naturalWidth),
        initials: document.querySelectorAll('.server-mark[data-hue]').length,
      }))
      assert.equal(shelf.columns, COLUMNS[label], `${label}: shelf columns`)
      assert.equal(shelf.icons.length, 7, `${label}: shelf icons`)
      assert(
        shelf.icons.every((width) => width > 0),
        `${label}: every shelf icon loads`,
      )
      assert.equal(shelf.initials, 10, `${label}: initials for servers without an icon`)
    }
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
    assert(sideways <= 0, `${label} ${screen.name}: scrolls sideways by ${String(sideways)}px`)
    await page.screenshot({ path: path.join(out, `${label}-${screen.name}.png`), fullPage: true })
    await page.close()
  }
}

const vite = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await vite.listen()
const origin = vite.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
try {
  await drive(browser, origin, 'phone-light', {
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    colorScheme: 'light',
  })
  await drive(browser, origin, 'tablet-light', { viewport: { width: 820, height: 1180 }, colorScheme: 'light' })
  await drive(browser, origin, 'desktop-dark', { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' })
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out })}\n`)
} finally {
  await browser.close()
  await vite.close()
}
