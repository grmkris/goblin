import assert from 'node:assert/strict'
import type { Browser, Page, Route } from 'playwright-core'
import { EVERYTHING, type CreateTopic, type OnboardingChange, type SendMessage } from '@goblin/contracts'

const model = { source: 'deployment', deployment: true, models: ['house-model'] }
const view = { status: 'open', steps: [], model, connected: 0, kickoff: false }
type Mode = 'uncertain' | 'conflict'
const draft = { goal: 'Plan a trip to Lisbon', channel: 'Travel plans', operation: '', accepted: false }

const failure = (route: Route) =>
  route.fulfill({ status: 500, json: { error: { code: 'internal', message: 'Retry', reason: 'fixture' } } })

/** Real Start mutations with simulated refusals and uncertain responses; no account, model or external work. */
function api(mode: 'uncertain' | 'conflict') {
  const creations: CreateTopic[] = []
  const messages: SendMessage[] = []
  const changes: OnboardingChange[] = []
  const onboarding = (route: Route) => {
    const json = (body: unknown) => route.fulfill({ json: body })
    const unavailable = () => failure(route)
    if (route.request().method() === 'PUT') {
      const change: OnboardingChange = route.request().postDataJSON()
      changes.push(change)
      if (mode === 'uncertain' && change.status === 'done' && changes.filter((c) => c.status === 'done').length === 1)
        return unavailable()
    }
    return json(view)
  }
  const topic = (route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    const unavailable = () => failure(route)
    const create: CreateTopic = route.request().postDataJSON()
    creations.push(create)
    if (creations.length === 1)
      return mode === 'uncertain'
        ? unavailable()
        : json({ error: { code: 'conflict', message: 'Name exists', reason: 'name' } }, 409)
    return json(
      {
        id: 2,
        name: create.name,
        description: create.description,
        conversation: '42',
        searchExcluded: false,
        setup: EVERYTHING,
        revision: 1,
        createdBy: 'owner',
        createdAt: 1,
      },
      201,
    )
  }
  const messageRoute = (route: Route) => {
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    const unavailable = () => failure(route)
    const content: SendMessage = route.request().postDataJSON()
    messages.push(content)
    if (mode === 'uncertain' && messages.length === 1) return unavailable()
    return json({ operationId: content.operationId, session: '42', accepted: true }, 202)
  }
  const handle = (route: Route) => {
    const { pathname } = new URL(route.request().url())
    if (!pathname.startsWith('/api/')) return route.continue()
    const json = (body: unknown, status = 200) => route.fulfill({ status, json: body })
    if (pathname === '/api/agent/model-endpoint') return json(model)
    if (pathname === '/api/onboarding') return onboarding(route)
    if (pathname === '/api/topics') return topic(route)
    if (pathname === '/api/conversations/42/messages') return messageRoute(route)
    throw new Error(`Unexpected start-flow request: ${pathname}`)
  }
  return { handle, creations, messages, changes }
}

const stored = (page: Page) => page.evaluate(() => sessionStorage.getItem('goblin:start-draft'))
async function retry(page: Page) {
  const button = page.getByRole('button', { name: 'Continue starting conversation' })
  await button.waitFor()
  await button.click()
}

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
    await page.getByText(mode === 'conflict' ? /clashes with something/u : /Something went wrong/u).waitFor()
    if (mode === 'conflict') {
      await page.getByLabel('Channel name').fill('Lisbon plans')
      await page.getByRole('button', { name: 'Start conversation', exact: true }).click()
    } else {
      const frozen = await stored(page)
      await page.reload()
      assert.equal(await stored(page), frozen)
      assert.equal(await page.getByLabel('Channel name').isDisabled(), true)
      await retry(page)
      await page.getByText(/Something went wrong/u).waitFor()
      await retry(page)
      await page.waitForFunction(
        () => JSON.parse(sessionStorage.getItem('goblin:start-draft') ?? '{}').accepted === true,
      )
      await page.getByText(/Something went wrong/u).waitFor()
      await retry(page)
    }
    await page.getByText('Opened channel 42', { exact: true }).waitFor()
    if (mode === 'conflict') assert.notEqual(fixture.creations[0]?.operationId, fixture.creations[1]?.operationId)
    assert.equal(await stored(page), null)
    assert.deepEqual(
      fixture.changes.filter((change) => change.kickoff).map((change) => change.kickoffChat),
      mode === 'uncertain' ? ['42', '42'] : ['42'],
    )
    assert.equal(new Set(fixture.messages.map((message) => message.operationId)).size, 1)
    assert.equal(fixture.messages.length, mode === 'uncertain' ? 2 : 1)
    if (mode === 'uncertain')
      assert(fixture.creations.every((create) => JSON.stringify(create) === JSON.stringify(fixture.creations[0])))
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
  }
}

export async function startFlowChecks(browser: Browser, origin: string): Promise<void> {
  await runMode(browser, origin, 'uncertain')
  await runMode(browser, origin, 'conflict')
}
