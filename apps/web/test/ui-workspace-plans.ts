/** Browser proof of the native setup review and partial retry; API responses are fixtures, not live provider proof. */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { EVERYTHING, type SourceView, type WorkspacePlanView } from '@goblin/contracts'
import { chromium, type BrowserContextOptions } from 'playwright-core'
import { createServer } from 'vite'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `workspace-plans-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })

const source = (suffix: string, title: string): SourceView => ({
  id: `src_${suffix.repeat(16)}`,
  connectionId: 'chat',
  label: 'Chat',
  title,
  setup: {
    wake: { event: 'message.received', arguments: { chat: suffix } },
    key: [{ name: 'chat', pointer: '/chat' }],
    speaksForMe: { pointer: '/from/isOwner', equals: true },
    others: 'drop',
    read: { from: 'payload', id: '/id', text: '/text' },
    reply: {
      tool: 'message_send',
      arguments: { chat: '{{key.chat}}', text: '{{text}}', operationId: '{{operationId}}' },
      maxChars: 3500,
    },
    newKeys: { to: 'topic', topic: 4 },
  },
  revision: 1,
  state: 'proposed',
  proposedBy: 'agent',
  waiting: [],
  createdAt: 1,
  updatedAt: 1,
})

const plan = (): WorkspacePlanView => ({
  id: `wsp_${'a'.repeat(32)}`,
  chat: '1',
  revision: 1,
  title: 'My conversations',
  purpose: 'Bring my private chats into Goblin.',
  state: 'proposed',
  items: [
    { kind: 'source', source: source('a', 'Personal messages') },
    { kind: 'source', source: source('b', 'Work messages') },
  ],
  topics: [
    {
      id: 4,
      name: 'Messages',
      conversation: '4',
      searchExcluded: false,
      revision: 1,
      setup: EVERYTHING,
      createdBy: 'owner',
      createdAt: 1,
    },
  ],
  completed: [],
  problem: null,
  continuation: 'pending',
  createdAt: 1,
})

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin, 'missing browser fixture origin')
const browser = await chromium.launch()
const errors: string[] = []
try {
  const views: readonly [string, BrowserContextOptions][] = [
    ['phone-light', { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, colorScheme: 'light' }],
    ['desktop-dark', { viewport: { width: 1280, height: 800 }, colorScheme: 'dark' }],
  ]
  for (const [label, options] of views) {
    const page = await browser.newPage(options)
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
    let current = plan()
    let attempts = 0
    await page.route('**/api/workspace-plans/*', (route) => route.fulfill({ json: current }))
    await page.route('**/api/workspace-plans/*/apply', async (route) => {
      assert.equal(route.request().method(), 'POST')
      assert.equal(route.request().headers()['x-goblin-csrf'], '1')
      assert.deepEqual(route.request().postDataJSON(), { revision: 1 })
      attempts += 1
      if (attempts === 1) {
        current = { ...current, state: 'attention', completed: [0], problem: 'UpstreamMcp' }
        return route.fulfill({
          status: 409,
          json: { error: { code: 'conflict', message: 'A setup step needs attention.', reason: 'fixture' } },
        })
      }
      current = { ...current, state: 'ready', completed: [0, 1], problem: null, continuation: 'sent' }
      return route.fulfill({ json: current })
    })
    await page.goto(`${origin}workspace-plan.html`)
    await page.getByText('My conversations', { exact: true }).waitFor()
    await page.getByText('When /from/isOwner is true: those become your own turns').first().waitFor()
    assert.equal(await page.getByRole('button', { name: 'Exact settings', exact: true }).count(), 2)
    await page.getByRole('button', { name: 'Exact settings', exact: true }).first().click()
    await page.getByRole('tab', { name: 'Raw', exact: true }).click()
    await page.getByText('"message_send"', { exact: false }).first().waitFor()
    await page.getByRole('button', { name: 'Exact settings', exact: true }).first().click()
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${label}: horizontal overflow`,
    )
    await page.screenshot({ path: path.join(out, `${label}-review.png`), fullPage: true })
    await page.getByRole('button', { name: 'Activate setup', exact: true }).click()
    await page.getByText('Some steps need attention.', { exact: false }).waitFor()
    await page.reload()
    await page.getByText('Needs attention', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
    await page.getByText('Configuration is active.', { exact: false }).waitFor()
    await page.reload()
    await page.getByText('Configuration is active.', { exact: false }).waitFor()
    assert.equal(await page.getByRole('button', { name: /Activate setup|Continue setup/u }).count(), 0)
    assert.equal(attempts, 2)
    assert(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${label}: activated overflow`,
    )
    await page.screenshot({ path: path.join(out, `${label}-configured.png`), fullPage: true })
    current = { ...plan(), state: 'preparing', items: [], topics: [], problem: 'UpstreamMcp:transport' }
    let preparations = 0
    await page.route('**/api/workspace-plans/*/prepare', (route) => {
      assert.equal(route.request().method(), 'POST')
      assert.equal(route.request().headers()['x-goblin-csrf'], '1')
      assert.deepEqual(route.request().postDataJSON(), { revision: 1 })
      preparations += 1
      current = plan()
      return route.fulfill({ json: current })
    })
    await page.reload()
    await page.getByRole('button', { name: 'Retry preparation', exact: true }).click()
    await page.getByRole('button', { name: 'Activate setup', exact: true }).waitFor()
    assert.equal(preparations, 1)
    assert.equal(attempts, 2, 'preparation must never activate the setup')
    await page.close()
  }
  assert.deepEqual(errors, [])
  writeSync(1, `${JSON.stringify({ ok: true, out, views: views.length })}\n`)
} finally {
  await browser.close()
  await server.close()
}
