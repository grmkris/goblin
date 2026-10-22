/**
 * The real sidebar (ADR 0078) over a populated workspace: one highlighted row per page, counts, every pin state, the
 * strip and its shortcut, the Topics popover, and the phone's drawer and dot. The page is in a workspace
 * (`/w/swarmm-prod/…`, ADR 0089) where the person is an admin, with two more workspaces and two invitations waiting
 * (ADR 0093): the workspace menu's count, roles and tooltip, and the invitations answered in place there and in
 * Activity. Two server keys made rooms and Personas (ADR 0108): each key's rooms fold under the Topics, filter and page
 * once open, a room's info says what it is, and the Personas page folds each key's. Screenshots land in .local.
 */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Locator, type Page, type Route, chromium } from 'playwright-core'
import {
  type InvitationPreview,
  ONBOARDING_STEPS,
  type OnboardingView,
  type ServerView,
  type WorkspaceView,
} from '@goblin/contracts'

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

/** The person's workspaces: the page is in Swarmm, where they are an admin. */
const WORKSPACES: WorkspaceView[] = [
  { id: 'ws-home', name: "Ada's workspace", slug: 'ada-home', role: 'owner', members: 1 },
  { id: 'ws-swarmm', name: 'Swarmm', slug: 'swarmm-prod', role: 'admin', members: 4 },
  { id: 'ws-sidequest', name: 'Sidequest team', slug: 'sidequest', role: 'member', members: 6 },
]
const HERE = 'swarmm-prod'

/** Two invitations waiting: one to join, one into a workspace whose owner's own models take no members (ADR 0095). */
const LAB_NOTES = 'b'.repeat(32)
const INVITATIONS: InvitationPreview[] = [
  {
    id: 'a'.repeat(32),
    workspace: 'Aurora studio',
    invitedBy: 'Grace',
    email: 'ada@example.com',
    role: 'member',
    state: 'pending',
  },
  {
    id: LAB_NOTES,
    workspace: 'Lab notes',
    invitedBy: 'Linus',
    email: 'ada@example.com',
    role: 'admin',
    state: 'pending',
  },
]
const JOINED: WorkspaceView = {
  id: 'ws-aurora',
  name: 'Aurora studio',
  slug: 'aurora-studio',
  role: 'member',
  members: 3,
}

const ONBOARDING: OnboardingView = {
  status: 'done',
  steps: ONBOARDING_STEPS.map((id) => ({ id, done: true })),
  model: { source: 'deployment', deployment: true, models: [] },
  connected: 2,
  kickoff: true,
}

const ANSWER = /^\/api\/invitations\/([a-f0-9]{32})\/(accept|decline)$/u

/**
 * The API as one browser context sees it: the workspace's (under `/w/<slug>/api/…`) and the person's (`/api/…`).
 * Answering an invitation takes it off the list, except joining Lab notes, which is refused as its owner's own.
 * Anything else is a test failure.
 */
function fakeApi(errors: string[]) {
  let invitations = [...INVITATIONS]
  const reads: Readonly<Record<string, () => unknown>> = {
    '/api/mcp/servers': () => SERVERS,
    '/api/health': () => ({ features: { agentApps: true } }),
    '/api/workspaces': () => WORKSPACES,
    '/api/invitations': () => invitations,
    '/api/onboarding': () => ONBOARDING,
    '/api/sources': () => ({ sources: [] }),
  }
  const answer = (id: string, how: string) => {
    if (how === 'accept' && id === LAB_NOTES)
      return {
        status: 409,
        json: { error: { code: 'conflict', message: 'Refused.', reason: 'owner_models', ref: '7f3a9c12e4b5a6d7' } },
      }
    invitations = invitations.filter((invitation) => invitation.id !== id)
    return { json: how === 'accept' ? JOINED : { declined: true } }
  }
  return (route: Route) => {
    const request = route.request()
    const pathname = new URL(request.url()).pathname.replace(/^\/w\/[a-z0-9-]+(?=\/api\/)/u, '')
    const [, id = '', how = ''] = ANSWER.exec(pathname) ?? []
    if (request.method() === 'POST' && how !== '') return route.fulfill(answer(id, how))
    const read = request.method() === 'GET' ? reads[pathname] : undefined
    if (read !== undefined) return route.fulfill({ json: read() })
    errors.push(`Unexpected API request: ${request.method()} ${pathname}`)
    return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'Not in fixture' } } })
  }
}

/**
 * Serves the fixture at a workspace's address (`/w/<slug>/navigation.html`), as the app is served, and a joined
 * workspace's home as a page of its own.
 */
async function inWorkspaces(page: Page, origin: string, errors: string[]) {
  await page.route(
    (url) => /^\/w\/[a-z0-9-]+\/navigation\.html$/u.test(url.pathname),
    (route) => route.continue({ url: `${origin}navigation.html${new URL(route.request().url()).search}` }),
  )
  await page.route(
    (url) => /^\/w\/[a-z0-9-]+\/$/u.test(url.pathname),
    (route) => route.fulfill({ contentType: 'text/html', body: '<p>Joined</p>' }),
  )
  await page.route((url) => /^(?:\/w\/[a-z0-9-]+)?\/api\//u.test(url.pathname), fakeApi(errors))
}

/** The text each of `rows` shows, its runs of white space as one space. */
const words = async (rows: Locator) => (await rows.allInnerTexts()).map((row) => row.replace(/\s+/gu, ' ').trim())

/** The workspace menu's trigger: the sidebar's head. */
const brand = (page: Page) => page.locator('nav.shell-sidebar .sidebar-brand').first()

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
    await inWorkspaces(page, origin, errors)
    const at = async (where: string) => {
      await page.goto(`${origin}w/${HERE}/navigation.html?at=${encodeURIComponent(where)}`)
      await page.locator('nav.shell-sidebar').first().waitFor()
      await page.getByText('Signed out').first().waitFor()
      await page.locator('.sidebar-invites').first().waitFor()
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
    assert.deepEqual(await page.locator('.list-fold').allInnerTexts(), ['Made by swarmm-prod (2)', 'Archived (1)'])
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-personas.png`) })

    // Counts: Activity (two invitations, an unread notification and a schedule in trouble), Work (a Delegate at
    // work), All threads.
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
    assert.deepEqual(counts, { Activity: '4', Work: '1', 'All threads': '1' })
    // Every pin keeps its place and says why it does not open.
    const pins = await page.locator('[data-section="pinned"] .sidebar-row').allTextContents()
    assert.deepEqual(pins, ['mysi', 'Trip tracker', 'Old boardClosed', 'Cloud consoleSigned out'])
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)
    assert.equal(overflow, 0)

    // A key's rooms: a folded section each under the Topics, the key active last first, with a dot while a room has
    // unread replies; folded, the room the page shows keeps its row.
    const rooms = page.locator('nav.shell-sidebar [data-section="rooms"]')
    assert.deepEqual(await words(rooms.locator('.sidebar-section-toggle')), [
      'swarmm-prod · 24 rooms , unread replies',
      'sidequest-dev · 2 rooms',
    ])
    assert.equal(await rooms.locator('.sidebar-row').count(), 0)
    await at('/c/1070')
    assert.deepEqual(await current(page), ['page deal-08'])
    assert.equal(await rooms.first().locator('.sidebar-row').count(), 1)
    // Open: a filter field, then the rooms active last first, twenty at a time.
    await rooms.first().locator('.sidebar-section-toggle').click()
    const names = rooms.first().locator('a.sidebar-row .sidebar-row-name')
    assert.equal(await names.count(), 20)
    assert.deepEqual((await names.allTextContents()).slice(0, 3), ['deal-08', 'deal-24', 'deal-23'])
    await rooms.first().evaluate((section) => section.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-rooms.png`) })
    await rooms.first().getByRole('button', { name: 'Show 4 more' }).click()
    assert.equal(await names.count(), 24)
    const filter = rooms.first().getByRole('searchbox', { name: 'Filter the rooms of swarmm-prod' })
    await filter.fill('DEAL-1')
    assert.deepEqual(
      await names.allTextContents(),
      Array.from({ length: 10 }, (_, n) => `deal-${String(19 - n)}`),
    )
    await filter.fill('nothing')
    await rooms.first().getByText('No rooms match.').waitFor()
    await rooms.first().evaluate((section) => section.scrollIntoView({ block: 'start' }))
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-rooms-filtered.png`) })
    await rooms.first().locator('.sidebar-section-toggle').click()

    // A room's info: the Room chip beside its name and what goblin reaches there.
    await at('/room-info')
    const info = page.getByRole('dialog', { name: '#deal-08' })
    await info.getByText('goblin here reaches only this Topic.').waitFor()
    assert.equal(await info.locator('[data-slot="badge"]').textContent(), 'Room')
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-room-info.png`) })

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

    // The workspace menu says where the page is and what waits: the role in its name and tooltip, a count of the
    // invitations, which come first in the menu, then each workspace with the person's role in it.
    await at('/c/1')
    assert.equal(
      await brand(page).getAttribute('aria-label'),
      'Workspace: Swarmm, you are an admin, 2 invitations waiting',
    )
    assert.equal(await brand(page).locator('.sidebar-invites').textContent(), '2')
    await brand(page).hover()
    await page.locator('[data-slot="tooltip-content"]', { hasText: 'You are an admin of Swarmm' }).waitFor()
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-workspace-tooltip.png`) })
    await brand(page).click()
    const menu = page.getByRole('menu')
    await menu.waitFor()
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-workspace-menu.png`) })
    assert.deepEqual(await words(menu.locator('[role="menuitem"]')), [
      'Aurora studio From Grace, as a member',
      'No thanks',
      'Join',
      'Lab notes From Linus, as an admin',
      'No thanks',
      'Join',
      "Ada's workspace Owner",
      'Swarmm Admin',
      'Sidequest team Member',
      'New workspace',
      'Workspace settings',
    ])
    // At a mouse, No thanks and Join take a press 5px above what they draw (40px tall in all) without growing.
    const reach = await menu.locator('[role="menuitem"]', { hasText: /^(No thanks|Join)$/u }).evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect()
        const above = document.elementFromPoint(box.left + box.width / 2, box.top - 5)?.closest('[role="menuitem"]')
        return above === item && box.height < 40
      }),
    )
    assert.deepEqual(reach, [true, true, true, true])
    // Joining a workspace whose owner's own models take no members is refused in place, in words.
    await menu.getByRole('group', { name: 'Lab notes' }).getByRole('menuitem', { name: 'Join' }).click()
    await menu.getByRole('alert').filter({ hasText: "Lab notes offers its owner's own subscription models" }).waitFor()
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-workspace-refusal.png`) })
    // No thanks answers in place: the menu stays open, the invitation goes and the count follows.
    await menu.getByRole('group', { name: 'Lab notes' }).getByRole('menuitem', { name: 'No thanks' }).click()
    await menu.getByRole('group', { name: 'Lab notes' }).waitFor({ state: 'detached' })
    assert(await menu.isVisible(), 'the menu stays open')
    assert.equal(await brand(page).locator('.sidebar-invites').textContent(), '1')
    await page.keyboard.press('Escape')

    // Activity's Needs you lists the invitation that waits, and Join opens the workspace joined.
    await at('/activity')
    const invitation = page.locator('.invitation-row')
    assert.deepEqual(await invitation.locator('.list-row-title').allTextContents(), ['An invitation to Aurora studio'])
    await page.screenshot({ path: path.join(out, `desktop-${colorScheme}-activity.png`) })
    await invitation.getByRole('button', { name: 'Join' }).click()
    await page.waitForURL((url) => url.pathname === '/w/aurora-studio/')

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
    await inWorkspaces(page, origin, errors)
    await page.goto(`${origin}w/${HERE}/navigation.html?at=/activity`)
    await page.locator('.invitation-row').nth(1).waitFor()
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-activity.png`), fullPage: true })
    await page.goto(`${origin}w/${HERE}/navigation.html?at=/room-info`)
    await page.getByText('goblin here reaches only this Topic.').waitFor()
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-room-info.png`) })
    await page.goto(`${origin}w/${HERE}/navigation.html?at=/apps`)
    const menu = page.getByRole('button', { name: /^Open navigation/u })
    await menu.waitFor()
    await page.waitForFunction(() => document.querySelector('.nav-button-dot') !== null)
    assert.equal(await menu.getAttribute('aria-label'), 'Open navigation, 4 waiting in Activity')
    assert.equal(await page.locator('.nav-button-dot').count(), 1)
    assert.equal(await page.locator('.shell-nav').count(), 0)
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-page.png`) })
    await menu.tap()
    const drawer = page.getByRole('dialog', { name: 'Navigation' })
    await drawer.waitFor()
    await page.waitForTimeout(400)
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-drawer.png`) })
    const brandHeight = await drawer
      .locator('.sidebar-brand')
      .evaluate((trigger) => (trigger instanceof HTMLElement ? trigger.offsetHeight : 0))
    assert(brandHeight >= 44, `the workspace menu takes a finger (${String(brandHeight)})`)
    await drawer.locator('.sidebar-brand').tap()
    await page.getByRole('menu').waitFor()
    const short = await page
      .getByRole('menu')
      .locator('[role="menuitem"]')
      .evaluateAll((items) => items.filter((item) => item instanceof HTMLElement && item.offsetHeight < 44).length)
    assert.equal(short, 0, 'every menu item takes a finger')
    await page.waitForTimeout(200)
    await page.screenshot({ path: path.join(out, `phone-${colorScheme}-workspace-menu.png`) })
    await page.keyboard.press('Escape')
    await page.getByRole('menu').waitFor({ state: 'detached' })
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
