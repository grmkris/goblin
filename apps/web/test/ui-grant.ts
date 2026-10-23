/**
 * Local browser acceptance of the grant editor (ADR 0114) against real source components: a key made and changed in
 * Settings, an MCP client's consent changed and approved, a client's grant changed from Settings, and a widening
 * approved. Desktop (1440) and phone (390), light and dark; the rows are at least 40px to point at and 44px to touch,
 * and nothing scrolls sideways. No account or agent is used; the Worker's and the agent's answers are routed here.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Browser, type BrowserContextOptions, type Page, type Route, chromium } from 'playwright-core'
import {
  type ApiKeyView,
  type ConsentTerms,
  GRANT_SPEC,
  type GrantTerms,
  type InboundClient,
  PRESET,
  type WorkspaceView,
  presetFor,
} from '@goblin/contracts'

const STDOUT = 1
const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `grant-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const WORKSPACES: readonly WorkspaceView[] = [
  { id: 'ws_acme', name: 'Acme', slug: 'acme', role: 'owner', members: 2 },
  { id: 'ws_beta', name: 'Beta Labs, the long-named research workspace', slug: 'beta', role: 'admin', members: 6 },
]
const TOPICS = ['Personal', 'Launch', 'Support', 'Customer interviews for the October pricing study'].map(
  (name, index) => ({
    id: index + 1,
    name,
    conversation: String(index + 1),
    revision: 1,
    archived: false,
    reach: 'sealed',
    updatedAt: 1,
  }),
)
const SERVERS = [
  {
    connectionId: 'notes',
    label: 'Notes',
    endpoint: 'https://notes.example',
    status: 'connected',
    live: true,
    source: 'added',
  },
  {
    connectionId: 'mail',
    label: 'Mail',
    endpoint: 'https://mail.example',
    status: 'connected',
    live: true,
    source: 'added',
  },
]
const SPEC = { levels: GRANT_SPEC.levels, extras: GRANT_SPEC.extras, reachOptions: [] }
const KEYS: readonly ApiKeyView[] = [
  {
    id: 'key_swarm',
    name: 'swarm',
    start: 'gbk_aaaaaa',
    createdAt: '2026-10-20T00:00:00.000Z',
    lastUsedAt: '2026-10-22T00:00:00.000Z',
    grantId: 'key_swarm',
    terms: { ...presetFor('swarm', ['ws_acme']), level: 'manage' },
  },
  {
    id: 'key_crm',
    name: 'crm',
    start: 'gbk_bbbbbb',
    createdAt: '2026-10-21T00:00:00.000Z',
    expiresAt: '2026-11-20T00:00:00.000Z',
    grantId: 'key_crm',
    terms: {
      name: 'crm',
      level: 'read',
      reach: {
        workspaces: 'list',
        each: [
          {
            workspace: 'ws_acme',
            topics: { kind: 'list', ids: ['2'] },
            personas: { kind: 'all' },
            connections: { kind: 'all' },
          },
        ],
        origins: [{ origin: 'https://mcp.crm.example', tools: ['contact_find', 'note_add'] }],
      },
      extras: ['inspect'],
      lifetime: '30d',
    },
  },
]
const CLIENT: InboundClient = {
  clientId: 'claude-code',
  name: 'Claude Code',
  uri: 'https://claude.ai/code',
  reach: { all: true, workspaces: [] },
  grantId: 'cg_claude',
  terms: { ...PRESET, name: 'Claude Code' },
}
const WIDENED: GrantTerms = KEYS[1]?.terms ?? PRESET

const errors: string[] = []
const sent: { readonly label: string; readonly method: string; readonly path: string; readonly body: unknown }[] = []

/** One answer: its body, and its status when it is not 200. */
type Answer = { readonly body: unknown; readonly status?: number }
const ok = (body: unknown): Answer => ({ body })

/** The Worker's and the agents' answers, by `METHOD /path`, each from what the page sent and the page's origin. */
const ANSWERS: Readonly<Record<string, (payload: unknown, origin: string) => Answer>> = {
  'GET /api/workspaces': () => ok(WORKSPACES),
  'GET /api/auth/get-session': () =>
    ok({ user: { id: 'u1', email: 'kris@example.com', name: 'Kris' }, session: { id: 's1' } }),
  'GET /api/auth/oauth2/public-client': () => ok({ client_name: 'Claude Code', client_uri: 'https://claude.ai/code' }),
  ...Object.fromEntries(
    ['acme', 'beta'].flatMap((slug) => [
      [`GET /w/${slug}/api/topics`, () => ok({ topics: TOPICS })],
      [`GET /w/${slug}/api/personas`, () => ok({ personas: [] })],
      [`GET /w/${slug}/api/mcp/servers`, () => ok(SERVERS)],
    ]),
  ),
  'GET /api/keys': () => ok(KEYS),
  'POST /api/keys': (payload) => {
    // SAFETY: the page sends CreateApiKeyTerms; the assertions below read it as such.
    const made = payload as { readonly name: string; readonly terms: GrantTerms }
    const key = { ...KEYS[0], id: 'key_new', name: made.name, grantId: 'key_new', terms: made.terms }
    return { body: { key, secret: `gbk_${'c'.repeat(64)}` }, status: 201 }
  },
  // SAFETY: the page sends UpdateApiKeyTerms.
  'PATCH /api/keys/key_crm': (payload) => ok({ ...KEYS[1], terms: (payload as { readonly terms: GrantTerms }).terms }),
  'GET /api/clients': () => ok([CLIENT]),
  'GET /api/clients/claude-code/terms': () =>
    ok({ spec: SPEC, defaults: CLIENT.terms ?? PRESET, current: null } satisfies ConsentTerms),
  'PUT /api/clients/claude-code/grant': (payload) =>
    // SAFETY: the page sends ClientGrantTerms.
    ok({ grantId: 'cg_claude', terms: (payload as { readonly terms: GrantTerms }).terms, expiresAt: null }),
  'POST /api/auth/oauth2/consent': (_payload, origin) =>
    ok({ redirect: true, url: `${origin}/grant.html?screen=done` }),
  'GET /api/grants/key_crm/terms': () =>
    ok({
      spec: SPEC,
      defaults: WIDENED,
      current: WIDENED,
      grantId: 'key_crm',
      summary: {
        ...WIDENED,
        grantId: 'key_crm',
        keyId: 'key_crm',
        expiresAt: '2026-11-20T00:00:00.000Z',
        widenUrl: '',
      },
    } satisfies ConsentTerms),
  // SAFETY: the page sends WidenRequest.
  'PUT /api/grants/key_crm': (payload) => ok({ ...(payload as object), expiresAt: '2026-11-20T00:00:00.000Z' }),
}

/** The answers this page asks for; anything else is a failed fixture. */
async function serve(page: Page, label: string) {
  await page.route(
    (url) => url.pathname.startsWith('/api/') || url.pathname.startsWith('/w/'),
    async (route: Route) => {
      const request = route.request()
      const url = new URL(request.url())
      const body: unknown = request.method() === 'GET' ? undefined : request.postDataJSON()
      sent.push({ label, method: request.method(), path: url.pathname, body })
      const call = `${request.method()} ${url.pathname}`
      const answer = ANSWERS[call]
      if (answer === undefined) errors.push(`${label}: unexpected ${call}`)
      const { body: answered, status = 200 } = answer?.(body, url.origin) ?? {
        body: { error: { code: 'not_found', message: 'That does not exist.' } },
        status: 404,
      }
      await route.fulfill({ status, json: answered })
    },
  )
}

/** Every choice row is a full hit area, and nothing scrolls sideways. */
async function checkLayout(page: Page, label: string, touch: boolean) {
  const rows = await page
    .locator('[data-slot="grant-choice"]')
    .evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height).filter((height) => height > 0))
  const least = touch ? 44 : 40
  assert(rows.length > 0, `${label}: no choice rows`)
  assert(
    rows.every((height) => height >= least),
    `${label}: rows ${rows.join(',')}`,
  )
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(wide <= 0, `${label}: scrolls sideways by ${String(wide)}px`)
}

const lastSent = (label: string, method: string, at: string) =>
  sent.findLast((each) => each.label === label && each.method === method && each.path === at)?.body

async function keys(page: Page, origin: string, label: string, touch: boolean) {
  await page.goto(`${origin}grant.html?screen=keys`)
  await page.getByText('gbk_aaaaaa…').waitFor()
  await page.getByText(/It can read 1 Topic, all Personas and all connections, and may bring 1 MCP server/u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-keys.png`), fullPage: true })
  await page.getByLabel('Name', { exact: true }).fill('deploy-bot')
  await page
    .getByText(/deploy-bot can write everything\s·\sno setup, routines, inspect or keys\s·\suntil revoked/u)
    .waitFor()
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('radio', { name: /^Manage/u }).click()
  await page.getByRole('radiogroup', { name: 'Topics' }).getByRole('radio', { name: 'Pick…' }).click()
  await page.getByRole('checkbox', { name: 'Launch' }).click()
  await page.getByRole('checkbox', { name: /^Inspect/u }).click()
  await page.getByLabel('Access lasts').selectOption('30d')
  await page.getByText(/deploy-bot can manage 1 Topic, all Personas and all connections\s·\swith inspect/u).waitFor()
  await checkLayout(page, `${label} keys`, touch)
  await page.screenshot({ path: path.join(out, `${label}-keys-editor.png`), fullPage: true })
  await page.getByRole('button', { name: 'Make key' }).click()
  await page.getByText(/Copy the key for/u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-keys-secret.png`), fullPage: true })
  assert.deepEqual(lastSent(label, 'POST', '/api/keys'), {
    name: 'deploy-bot',
    terms: {
      name: 'deploy-bot',
      level: 'manage',
      reach: {
        workspaces: 'list',
        each: [
          {
            workspace: 'ws_acme',
            topics: { kind: 'list', ids: ['2'] },
            personas: { kind: 'all' },
            connections: { kind: 'all' },
          },
        ],
        origins: [],
      },
      extras: ['inspect'],
      lifetime: '30d',
    },
  })
  await page.getByRole('button', { name: 'Done' }).click()
  await page.getByRole('button', { name: 'Change access' }).nth(1).click()
  await page.getByRole('radio', { name: /^Write/u }).click()
  await page.getByRole('button', { name: 'Save access' }).click()
  await page.getByRole('button', { name: 'Save access' }).waitFor({ state: 'detached' })
  assert.equal(
    // SAFETY: the page sent UpdateApiKeyTerms.
    (lastSent(label, 'PATCH', '/api/keys/key_crm') as { readonly terms: GrantTerms }).terms.level,
    'write',
  )
}

async function consent(page: Page, origin: string, label: string, touch: boolean) {
  await page.goto(`${origin}grant.html?screen=consent&client_id=claude-code`)
  await page.getByRole('heading', { name: 'Allow “Claude Code” to use goblin?' }).waitFor()
  await page.getByText(/Claude Code can write everything in all your workspaces/u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-consent.png`), fullPage: true })
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('radio', { name: 'Only these' }).click()
  await page.getByRole('checkbox', { name: /^Acme/u }).click()
  await page.getByText(/Claude Code can write everything in Acme\s·/u).waitFor()
  await checkLayout(page, `${label} consent`, touch)
  await page.screenshot({ path: path.join(out, `${label}-consent-editor.png`), fullPage: true })
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByText('Back at the client.').waitFor()
  const granted = lastSent(label, 'PUT', '/api/clients/claude-code/grant')
  assert.deepEqual(granted, {
    terms: {
      ...PRESET,
      name: 'Claude Code',
      reach: {
        workspaces: 'list',
        each: [
          { workspace: 'ws_acme', topics: { kind: 'all' }, personas: { kind: 'all' }, connections: { kind: 'all' } },
        ],
        origins: [],
      },
    },
  })
  assert.deepEqual(lastSent(label, 'POST', '/api/auth/oauth2/consent'), { accept: true })
  const order = sent.filter((each) => each.label === label && each.method !== 'GET').map((each) => each.path)
  assert.deepEqual(order, ['/api/clients/claude-code/grant', '/api/auth/oauth2/consent'])
}

async function clients(page: Page, origin: string, label: string, touch: boolean) {
  await page.goto(`${origin}grant.html?screen=clients`)
  await page.getByText(/It can write everything in all your workspaces/u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-clients.png`), fullPage: true })
  await page.getByRole('button', { name: 'Change', exact: true }).click()
  await page.getByRole('radio', { name: /^Read/u }).click()
  await page.getByRole('button', { name: 'Narrow' }).nth(1).click()
  await page.getByRole('radiogroup', { name: 'connections' }).getByRole('radio', { name: 'Pick…' }).click()
  await page.getByRole('checkbox', { name: 'Notes' }).click()
  await checkLayout(page, `${label} clients`, touch)
  await page.screenshot({ path: path.join(out, `${label}-clients-editor.png`), fullPage: true })
  await page.getByRole('button', { name: 'Save access' }).click()
  await page.getByRole('button', { name: 'Save access' }).waitFor({ state: 'detached' })
  // SAFETY: the page sent ClientGrantTerms.
  const saved = lastSent(label, 'PUT', '/api/clients/claude-code/grant') as { readonly terms: GrantTerms }
  assert.equal(saved.terms.level, 'read')
  assert.deepEqual(saved.terms.reach.each, [
    {
      workspace: 'ws_beta',
      topics: { kind: 'all' },
      personas: { kind: 'all' },
      connections: { kind: 'list', ids: ['notes'] },
    },
  ])
}

async function widen(page: Page, origin: string, label: string) {
  await page.goto(`${origin}grant.html?screen=widen&grant=key_crm&level=manage&reach=ws_acme/topic/3&extra=setup`)
  await page.getByRole('heading', { name: 'Approving adds' }).waitFor()
  await page.getByText('Manage instead of read').waitFor()
  // Names, not ids: the key's from its grant, the Topic's from Acme's own list, the workspace's from the person's.
  await page.getByText(/The API key crm was refused/u).waitFor()
  await page.getByText('Topic “Support” in Acme').waitFor()
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert(wide <= 0, `${label} widen: scrolls sideways by ${String(wide)}px`)
  await page.screenshot({ path: path.join(out, `${label}-widen.png`), fullPage: true })
  await page.getByRole('button', { name: 'Approve' }).click()
  await page.getByText(/^Approved\./u).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-widen-approved.png`), fullPage: true })
  // SAFETY: the page sent WidenRequest.
  const approved = lastSent(label, 'PUT', '/api/grants/key_crm') as {
    readonly grantId: string
    readonly terms: GrantTerms
  }
  assert.equal(approved.grantId, 'key_crm')
  assert.equal(approved.terms.level, 'manage')
  assert.deepEqual(approved.terms.extras, ['inspect', 'setup'])
  assert.deepEqual(approved.terms.reach.each[0]?.topics, { kind: 'list', ids: ['2', '3'] })
}

async function drive(browser: Browser, origin: string, label: string, options: BrowserContextOptions) {
  const touch = options.hasTouch === true
  for (const screen of [keys, consent, clients] as const) {
    const page = await browser.newPage(options)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    await serve(page, `${label}-${screen.name}`)
    await screen(page, origin, `${label}-${screen.name}`, touch)
    await page.close()
  }
  const page = await browser.newPage(options)
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  await serve(page, `${label}-widen`)
  await widen(page, origin, `${label}-widen`)
  await page.close()
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
try {
  for (const scheme of ['light', 'dark'] as const) {
    await drive(browser, origin, `desktop-${scheme}`, { viewport: { width: 1440, height: 900 }, colorScheme: scheme })
    await drive(browser, origin, `phone-${scheme}`, {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      colorScheme: scheme,
    })
  }
  assert.deepEqual(errors, [])
  writeSync(STDOUT, `${JSON.stringify({ ok: true, out, requests: sent.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
