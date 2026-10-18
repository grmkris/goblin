/** Real channel components with synthetic owner API data; desktop/mobile screenshots and state-retention checks. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'

const baseline = process.argv.includes('--before')
const out = path.resolve(
  import.meta.dirname,
  '../../../.local/goblin-acceptance',
  `channel-${baseline ? 'before' : 'after'}-${Date.now()}`,
)
mkdirSync(out, { recursive: true })
const entries = [
  {
    id: 10,
    kind: 'pi.user',
    model: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Let’s plan a week in Lisbon. I’d like a quiet neighborhood, good food and time to explore.',
          },
          {
            type: 'text',
            text: JSON.stringify({
              attachments: [
                {
                  path: '/uploads/lisbon-guide.pdf',
                  name: 'Lisbon guide.pdf',
                  mimeType: 'application/pdf',
                  size: 342000,
                },
              ],
            }),
          },
        ],
        timestamp: 1792310000000,
      },
    ],
  },
  {
    id: 11,
    kind: 'pi.assistant',
    model: [
      {
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Start with **Príncipe Real** or **Estrela** for a quieter base. Both put cafés, gardens and great places to eat within walking distance.\n\nI’ll keep hotel options in a thread so we can compare them without losing the overall plan. The [Lisbon visitor guide](https://www.visitlisboa.com/) is a useful starting point.',
          },
        ],
        timestamp: 1792310001000,
      },
    ],
  },
]
const catalog = {
  servers: [
    {
      connectionId: 'notes',
      label: 'Notes',
      status: 'connected',
      tools: [
        { name: 'read', title: 'Read a note' },
        { name: 'write', title: 'Write a note' },
      ],
    },
  ],
  libraries: [
    {
      connectionId: 'notes',
      label: 'Travel skills',
      available: true,
      skills: [
        {
          name: 'trip-planning',
          uri: 'skill://travel/SKILL.md',
          description: 'Build a practical itinerary around dates, budget and interests.',
        },
      ],
    },
  ],
  apps: [],
}
const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
const errors: string[] = []
try {
  for (const width of [1440, 390]) {
    const label = width === 390 ? 'phone' : 'desktop'
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: width === 390,
      isMobile: width === 390,
      colorScheme: 'light',
      reducedMotion: 'reduce',
    })
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      (route) => {
        const url = new URL(route.request().url())
        const at = url.pathname
        const json = (body: unknown) => route.fulfill({ json: body })
        const responses: Record<string, unknown> = {
          '/api/health': { features: { agentApps: true } },
          '/api/agent/model': {
            current: 'house-model',
            options: [
              {
                id: 'house-model',
                label: 'House model',
                route: 'goblin',
                note: '',
                images: true,
                contextWindow: 128000,
              },
            ],
          },
          '/api/mcp/servers': [
            {
              connectionId: 'notes',
              label: 'Notes',
              endpoint: 'https://notes.example/mcp',
              status: 'connected',
              live: true,
              source: 'added',
            },
          ],
          '/api/mcp/grants': [
            { connectionId: 'notes', capability: 'tool', name: 'read', granted: true },
            { connectionId: 'notes', capability: 'tool', name: 'write', granted: true, askFirst: true },
          ],
          '/api/setup/catalog': catalog,
          '/api/onboarding': {
            status: 'done',
            steps: [
              { id: 'welcome', done: true },
              { id: 'model', done: true },
              { id: 'services', done: true },
              { id: 'goblin', done: true },
            ],
            model: { source: 'deployment', deployment: true, models: ['house-model'] },
            connected: 1,
            kickoff: true,
          },
          '/api/agent/usage': { used: 0, limit: null, resetsAt: 1_800_000_000 },
          '/api/routines': { routines: [] },
          '/api/sources': { sources: [] },
        }
        if (at in responses) return json(responses[at])
        if (at.endsWith('/snapshot')) return json({ type: 'snapshot', entries, tools: [], inbox: [] })
        if (at.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' })
        if (at.endsWith('/queue')) return json({ inputs: [] })
        if (at.endsWith('/sources')) return json([])
        if (at.endsWith('/history')) return json({ entries, more: false })
        if (at.endsWith('/read')) return json({ read: true })
        if (at.endsWith('/composer')) return json({ options: [] })
        errors.push(`Unexpected API request: ${at}`)
        return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not in fixture' } } })
      },
    )
    await page.goto(`${origin}channel.html`)
    await page.getByPlaceholder('Message #Travel').waitFor()
    await page.getByPlaceholder('Message #Travel').fill('Keep my draft while I check channel info')
    await page.screenshot({ path: path.join(out, `${label}-chat.png`) })
    if (!baseline) {
      await page.getByRole('button', { name: 'Info for #Travel' }).click()
      const panel = page.getByRole('dialog', { name: '#Travel' })
      await panel.waitFor()
      await page.screenshot({ path: path.join(out, `${label}-overview.png`) })
      await panel.getByRole('tab', { name: 'Tools & skills' }).click()
      await panel.locator('summary').filter({ hasText: 'Travel skills' }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-tools-collapsed.png`) })
      await panel.locator('summary').filter({ hasText: 'Travel skills' }).click()
      await panel.getByText('trip-planning', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-tools.png`) })
      await panel.getByRole('tab', { name: 'Shared', exact: true }).click()
      await panel.getByRole('link', { name: 'Lisbon guide.pdf' }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-shared.png`) })
      await page
        .getByRole('button', { name: width === 390 ? 'Back to channel' : 'Close channel info', exact: true })
        .click()
      await panel.waitFor({ state: 'detached' })
      assert.equal(
        await page.getByPlaceholder('Message #Travel').inputValue(),
        'Keep my draft while I check channel info',
      )
      await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === 'Info for #Travel')
      await page.goto(`${origin}channel.html?at=${encodeURIComponent('/c/30?thread=31&info=true')}`)
      await page.getByRole('dialog', { name: '#Travel' }).waitFor()
      await page
        .getByRole('button', { name: width === 390 ? 'Back to channel' : 'Close channel info', exact: true })
        .click()
      await page.getByPlaceholder('Reply…').waitFor()
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0)
    await page.close()
  }
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({ ok: true, out }))
} finally {
  await browser.close()
  await server.close()
}
