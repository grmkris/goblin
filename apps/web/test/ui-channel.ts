/** Real channel components with synthetic owner API data; desktop/mobile screenshots and state-retention checks. */
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { type Page, chromium } from 'playwright-core'
import { marksOf } from '../src/lib/agui/messages.ts'
import { activity, answer, asking, opening, result, said } from './agui-fixtures.ts'
import { FixtureStream, OPENINGS, installLiveReads, openingChat } from './agui-route.ts'

const baseline = process.argv.includes('--before')
const out = path.resolve(
  import.meta.dirname,
  '../../../.local/goblin-acceptance',
  `channel-${baseline ? 'before' : 'after'}-${Date.now()}`,
)
mkdirSync(out, { recursive: true })
const attachment = {
  path: '/uploads/lisbon-guide.pdf',
  name: 'Lisbon guide.pdf',
  mimeType: 'application/pdf',
  size: 342000,
}
const questions = [
  {
    id: 'pace',
    prompt: 'How busy should the days be?',
    kind: 'single',
    options: [
      { id: 'slow', label: 'Slow mornings' },
      { id: 'full', label: 'Full days' },
    ],
  },
]
const notice = {
  notice: 'notice:rt_1:evt-1',
  routine: 'rt_1',
  source: 'event',
  from: { connectionId: 'notes', label: 'Notes' },
  title: 'Flight prices dropped',
  body: 'TAP to Lisbon is €40 cheaper on the 12th.',
}
/** The chat's newest entries (AG-UI, as `apps/runtime/src/streams/` writes them), from 10: what its stream opens with. */
const recent = [
  said(10, 'Let’s plan a week in Lisbon. I’d like a quiet neighborhood, good food and time to explore.', {
    attachments: [attachment],
    at: 1792310000000,
  }),
  answer(11, {
    at: 1792310001000,
    thinking: ['Quiet and walkable: Príncipe Real and Estrela fit; keep hotels in a thread.'],
    text: 'Start with **Príncipe Real** or **Estrela** for a quieter base. Both put cafés, gardens and great places to eat within walking distance.\n\nI’ll keep hotel options in a thread so we can compare them without losing the overall plan. The [Lisbon visitor guide](https://www.visitlisboa.com/) is a useful starting point.',
    marks: { usage: { input: 28000, output: 131, cacheRead: 0, cacheWrite: 0, totalTokens: 28131 } },
  }),
  said(12, 'Save that to my notes, and ask me how busy the days should be.', { at: 1792310010000 }),
  asking(
    13,
    [
      { id: 'c-notes', arguments: { connectionId: 'notes', name: 'write', arguments: { title: 'Lisbon' } } },
      { id: 'c-ask', name: 'ask_user', arguments: { questions } },
    ],
    1792310011000,
  ),
  result(14, 'c-notes', { content: 'Remote MCP request failed (timeout).', isError: true, at: 1792310012000 }),
  result(15, 'c-ask', {
    toolName: 'ask_user',
    content: 'Asked the owner.',
    details: { kind: 'question', questions },
    at: 1792310013000,
  }),
  activity(16, 'goblin.notice', notice, { at: 1792310020000 }),
].flat()
const opened = opening(recent, { before: 10 })
/** The page before entry 10, which the history endpoint answers in the same mapping. */
const older = [
  said(8, 'Which neighbourhoods are walkable?', { at: 1792300000000 }),
  ...answer(9, {
    at: 1792300001000,
    text: 'Most of central Lisbon is, if you do not mind hills: Alfama and Chiado most of all.',
  }),
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
/** What ran behind the assistant's answer (entry 11): two model calls around a Notes call that timed out. */
const details = {
  turn: {
    operationId: 'owner:op-11',
    conversationId: '30',
    source: 'direct',
    status: 'ok',
    startedAt: 1792310000500,
    endedAt: 1792310004500,
    modelAttempts: 2,
    failedAttempts: 0,
    toolCalls: 1,
    failedToolCalls: 1,
    inputTokens: 28000,
    outputTokens: 131,
    version: '393c8952c962d36fa35db51e8f710d4cd73edd3f',
  },
  events: [],
  steps: [
    { kind: 'model.attempt', status: 'ok', offsetMs: 0, ms: 2000, model: 'deepseek-v4.1-flash', attempt: 1 },
    {
      kind: 'tool.call',
      status: 'error',
      offsetMs: 2000,
      ms: 400,
      tool: 'mcp_call',
      server: 'notes',
      serverTool: 'write',
      error: 'Remote MCP request failed (timeout).',
    },
    { kind: 'model.attempt', status: 'ok', offsetMs: 2400, ms: 1600, model: 'deepseek-v4.1-flash', toolsAdded: 1 },
  ],
  spent: { totalMs: 4000, modelMs: 3600, toolMs: 400, servers: [], otherMs: 0 },
  ranWith: {
    versions: ['393c8952c962d36fa35db51e8f710d4cd73edd3f'],
    endpoints: ['deployment'],
    thinking: ['low'],
    promptChanges: 1,
    servers: [],
  },
  coverage: { complete: true, gaps: [] },
  related: [{ operation: 'owner:op-12', kind: 'start', chat: '31', state: 'ok' }],
}
/** Every message of chat 30's history, oldest first, in the stream's mapping (what the opening shows and before). */
const everything = [...older, ...recent]
/** The history endpoint's page before entry `before`: all of it, which fits one page. */
function historyPage(before: number) {
  const messages = everything.filter((message) => {
    const entry = marksOf(message).entryId
    return entry === undefined || entry < before
  })
  return { messages, next: 8, more: false }
}

const ASKED = '1:a1792310030000'
/** The owner's next message, as the stream writes a committed one. */
const sent = [
  { type: 'RUN_STARTED', threadId: '30', runId: '30:17' },
  {
    type: 'TEXT_MESSAGE_START',
    messageId: '30:e17',
    role: 'user',
    metadata: { goblin: { entryId: 17, at: 1792310029000, branchable: true } },
  },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: '30:e17', delta: 'Find a quiet hotel near Príncipe Real.' },
  { type: 'TEXT_MESSAGE_END', messageId: '30:e17', metadata: { goblin: { entryId: 17 } } },
]
/** The answer in flight: its thinking, its first words and a tool it runs. */
const streaming = [
  { type: 'REASONING_START', messageId: `${ASKED}:s0` },
  {
    type: 'REASONING_MESSAGE_START',
    messageId: `${ASKED}:r0`,
    role: 'reasoning',
    metadata: { goblin: { at: 1792310030000 } },
  },
  { type: 'REASONING_MESSAGE_CONTENT', messageId: `${ASKED}:r0`, delta: 'Check the saved shortlist before searching.' },
  { type: 'REASONING_MESSAGE_END', messageId: `${ASKED}:r0` },
  { type: 'REASONING_END', messageId: `${ASKED}:s0` },
  { type: 'TEXT_MESSAGE_START', messageId: ASKED, role: 'assistant', metadata: { goblin: { at: 1792310030000 } } },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: ASKED, delta: 'Looking at your shortlist first.' },
  { type: 'TOOL_CALL_START', toolCallId: 'c-read', toolCallName: 'mcp_call', parentMessageId: ASKED },
  { type: 'TEXT_MESSAGE_END', messageId: ASKED, metadata: { goblin: { entryId: 18, branchable: true } } },
  {
    type: 'TOOL_CALL_ARGS',
    toolCallId: 'c-read',
    delta: JSON.stringify({ connectionId: 'notes', name: 'read', arguments: { title: 'Hotels' } }),
  },
  { type: 'TOOL_CALL_END', toolCallId: 'c-read' },
  { type: 'CUSTOM', name: 'goblin.tool_progress', value: { toolCallId: 'c-read', status: 'running' } },
  {
    type: 'CUSTOM',
    name: 'goblin.tool_progress',
    value: { toolCallId: 'c-read', output: { append: 'Reading “Hotels”…' } },
  },
  {
    type: 'STATE_DELTA',
    delta: [
      { op: 'replace', path: '/queue', value: [{ id: 21, mode: 'followUp', text: 'Under €200 a night, please.' }] },
    ],
  },
]
/** The run settles: the tool's result, the answer, the queued input taken, the run's end. */
const settled = [
  {
    type: 'TOOL_CALL_RESULT',
    messageId: '30:tc-read',
    toolCallId: 'c-read',
    role: 'tool',
    content: 'Memmo Príncipe Real; Casa do Jardim',
    metadata: { goblin: { entryId: 19, at: 1792310032000, toolName: 'mcp_call', isError: false } },
  },
  {
    type: 'TEXT_MESSAGE_START',
    messageId: '1:a1792310033000',
    role: 'assistant',
    metadata: { goblin: { at: 1792310033000 } },
  },
  {
    type: 'TEXT_MESSAGE_CONTENT',
    messageId: '1:a1792310033000',
    delta: 'Two from your shortlist are quiet and close: **Memmo Príncipe Real** and **Casa do Jardim**.',
  },
  { type: 'TEXT_MESSAGE_END', messageId: '1:a1792310033000', metadata: { goblin: { entryId: 20, branchable: true } } },
  { type: 'RUN_FINISHED', threadId: '30', runId: '30:17' },
  { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/queue', value: [] }] },
]

/** A run streamed into the open chat: screenshots while it runs (with a queued follow-up) and once it settled. */
async function live(page: Page, stream: FixtureStream, label: string) {
  await page.waitForFunction(() => document.documentElement.dataset['streams'] !== undefined)
  await stream.write(page, ...sent, ...streaming)
  await page.getByText('Looking at your shortlist first.').waitFor()
  await page.getByText('Under €200 a night, please.').waitFor()
  await page.screenshot({ path: path.join(out, `${label}-live.png`) })
  await stream.write(page, ...settled)
  await page.getByText('Casa do Jardim', { exact: false }).last().waitFor()
  await page.getByText('Under €200 a night, please.').waitFor({ state: 'hidden' })
  await page.screenshot({ path: path.join(out, `${label}-settled.png`) })
  // A reload connects again, and its opening draws the same transcript.
  await page.reload()
  await page.getByText('Two from your shortlist').waitFor()
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
const errors: string[] = []
try {
  for (const [width, scheme] of [
    [1440, 'light'],
    [390, 'light'],
    [1440, 'dark'],
    [390, 'dark'],
  ] as const) {
    const label = `${width === 390 ? 'phone' : 'desktop'}${scheme === 'dark' ? '-dark' : ''}`
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 900 },
      hasTouch: width === 390,
      isMobile: width === 390,
      colorScheme: scheme,
      reducedMotion: 'reduce',
    })
    page.on('pageerror', (error) => errors.push(error.message))
    const stream = new FixtureStream('30', opened)
    // Every other chat (the thread the panel opens) streams an empty opening.
    const streams = new Map([['30', stream]])
    const streamOf = (chat: string) => {
      const known = streams.get(chat) ?? new FixtureStream(chat, opening([]))
      streams.set(chat, known)
      return known
    }
    await installLiveReads(page)
    await page.route(OPENINGS, (route) => streamOf(openingChat(route)).opening(route))
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
          '/api/inspect/details': details,
          '/api/workspaces': [
            { id: 'ws_fixture', name: 'Travel planning', slug: 'fixture', role: 'owner', members: 1 },
          ],
          '/api/invitations': [],
          '/api/auth/get-session': {
            session: { id: 'session-fixture', userId: 'owner', expiresAt: '2099-01-01T00:00:00.000Z' },
            user: { id: 'owner', name: 'Owner', email: 'owner@example.com', emailVerified: true },
          },
        }
        if (at in responses) return json(responses[at])
        if (at.endsWith('/sources')) return json([])
        if (at.endsWith('/history')) return json(historyPage(Number(url.searchParams.get('before'))))
        if (at.endsWith('/read')) return json({ read: true })
        if (at.endsWith('/composer')) return json({ options: [] })
        errors.push(`Unexpected API request: ${at}`)
        return route.fulfill({ status: 404, json: { error: { code: 'not_found', message: 'not in fixture' } } })
      },
    )
    await page.goto(`${origin}channel.html`)
    await page.getByPlaceholder('Message #Travel').waitFor()
    // The page before the stream's window, read from the history endpoint, comes first.
    await page.getByText('Which neighbourhoods are walkable?', { exact: true }).waitFor()
    await page.getByText('How busy should the days be?').first().waitFor()
    await page.getByText('Flight prices dropped').waitFor()
    await page.getByText('Which neighbourhoods are walkable?', { exact: true }).scrollIntoViewIfNeeded()
    await page.screenshot({ path: path.join(out, `${label}-history.png`) })
    await page.getByPlaceholder('Message #Travel').fill('Keep my draft while I check channel info')
    await page.screenshot({ path: path.join(out, `${label}-chat.png`), fullPage: true })
    if (!baseline && scheme === 'dark') await live(page, stream, label)
    if (!baseline && scheme === 'light') {
      await page.getByRole('button', { name: 'Info for #Travel' }).click()
      const panel = page.getByRole('dialog', { name: '#Travel' })
      await panel.waitFor()
      await page.screenshot({ path: path.join(out, `${label}-overview.png`) })
      await panel.getByRole('tab', { name: 'Tools & skills' }).click()
      await panel.locator('summary').filter({ hasText: 'Travel skills' }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-tools-collapsed.png`) })
      await panel.locator('summary').filter({ hasText: 'Travel skills' }).click()
      await panel.getByText('trip-planning', { exact: true }).waitFor()
      // The setup editor's own reading: the listed skill is available, only the missing one is unavailable.
      await panel.getByText('notes · packing-list', { exact: true }).waitFor()
      assert.equal(await panel.getByText('notes · trip-planning', { exact: true }).count(), 0)
      await page.screenshot({ path: path.join(out, `${label}-tools.png`) })
      await panel.getByRole('tab', { name: 'Shared', exact: true }).click()
      await panel.getByRole('link', { name: 'Lisbon guide.pdf' }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-shared.png`) })
      await panel.getByRole('tab', { name: 'Work', exact: true }).click()
      await panel.getByText(/^No routines in this channel/u).waitFor()
      await panel.getByText('No external conversations route here.', { exact: true }).waitFor()
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
      // Details of the assistant's answer: the outcome, its steps on the timeline, where it led, what it ran with.
      await page.goto(`${origin}channel.html`)
      const action = page.getByRole('button', { name: 'Details', exact: true }).last()
      await action.focus()
      await action.click()
      const sheet = page.getByRole('dialog', { name: 'Details' })
      await sheet.getByText('Remote MCP request failed (timeout).', { exact: true }).waitFor()
      await sheet.getByText(/^Answered in/u).waitFor()
      await sheet.getByText('28.1K tokens on goblin’s model, thinking low, build 393c895.', { exact: true }).waitFor()
      await page.screenshot({ path: path.join(out, `${label}-details.png`) })
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached' })
      await live(page, stream, label)
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
