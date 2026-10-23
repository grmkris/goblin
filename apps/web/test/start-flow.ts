import assert from 'node:assert/strict'
import type { Browser, Page, Route } from 'playwright-core'
import { EVERYTHING, type OnboardingKickoff } from '@goblin/contracts'

const model = { source: 'deployment', deployment: true, models: ['house-model'] }
const view = { status: 'open', steps: [], model, connected: 0, kickoff: false }
const FAILURES = {
  uncertain: { status: 500, json: { error: { code: 'internal', message: 'Retry', reason: 'fixture' } } },
  conflict: { status: 409, json: { error: { code: 'conflict', message: 'Name exists', reason: 'topic_name_taken' } } },
  archived: { status: 400, json: { error: { code: 'invalid_input', message: 'Archived', reason: 'topic_archived' } } },
  lateConflict: { status: 409, json: { error: { code: 'conflict', message: 'Retry', reason: 'fixture_late' } } },
  untyped: { status: 409, body: 'Conflict' },
} as const
type Mode = keyof typeof FAILURES
const draft = { goal: 'Plan a trip to Lisbon', channel: 'Travel plans', groups: ['travel'], operation: '' }

/**
 * Start's kickoff against a simulated owner API: the first attempt fails, either with no answer the page can trust
 * (`uncertain`, `untyped`), a later admission failure (`archived`, `lateConflict`) or a pre-creation name refusal
 * (`conflict`); the next succeeds. No account, model or external work.
 */
function api(mode: Mode) {
  const kickoffs: OnboardingKickoff[] = []
  const kickoff = (route: Route) => {
    const sent: OnboardingKickoff = route.request().postDataJSON()
    kickoffs.push(sent)
    if (kickoffs.length === 1) return route.fulfill(FAILURES[mode])
    const topic = {
      id: 2,
      name: sent.channel,
      description: sent.goal,
      conversation: '42',
      reach: 'sealed',
      setup: EVERYTHING,
      revision: 1,
      createdBy: 'owner',
      createdAt: 1,
    }
    return route.fulfill({ json: { topic, view: { ...view, status: 'done', kickoff: true } } })
  }
  const handle = (route: Route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    if (pathname === '/api/agent/model-endpoint') return route.fulfill({ json: model })
    if (pathname === '/api/onboarding') return route.fulfill({ json: view })
    if (pathname === '/api/onboarding/kickoff') return kickoff(route)
    throw new Error(`Unexpected start-flow request: ${pathname}`)
  }
  return { handle, kickoffs }
}

const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem('goblin:start-draft'))

async function runMode(browser: Browser, origin: string, mode: Mode): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' })
  const fixture = api(mode)
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/api/**', fixture.handle)
  try {
    await page.goto(`${origin}start.html?at=/start/goblin`)
    await page.evaluate((value) => sessionStorage.setItem('goblin:start-draft', JSON.stringify(value)), draft)
    await page.reload()
    await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
    await page.locator('.start-content [data-slot="receipt"]').waitFor()
    if (mode === 'conflict') {
      // A refusal made nothing: the draft opens again for a new name.
      await page.getByLabel('Channel name').fill('Lisbon plans')
      await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
    } else {
      // An unknown outcome may have made the channel: the draft stays frozen across a reload, and the retry replays it.
      const frozen = await stored(page)
      await page.reload()
      assert.equal(await stored(page), frozen)
      assert.equal(await page.getByLabel('Channel name').isDisabled(), true)
      await page.getByRole('button', { name: 'Continue starting conversation' }).click()
    }
    await page.getByText('Opened channel 42', { exact: true }).waitFor()
    assert.equal(await stored(page), null)
    const [first, second] = fixture.kickoffs
    assert.equal(fixture.kickoffs.length, 2)
    if (mode === 'conflict') {
      assert.notEqual(first?.operationId, second?.operationId)
      assert.equal(second?.channel, 'Lisbon plans')
    } else assert.deepEqual(first, second)
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

export async function startFlowChecks(browser: Browser, origin: string): Promise<void> {
  for (const mode of Object.keys(FAILURES)) {
    // SAFETY: Object.keys enumerates only the five fixed fixture modes above.
    await runMode(browser, origin, mode as Mode)
  }
}
