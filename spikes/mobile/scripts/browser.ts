import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { browserFixture } from './browser-fixture.ts'

const fixture = await browserFixture()
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1 })
const errors: string[] = []
const network: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
page.on('response', (response) => {
  if (response.url().includes('/api/')) network.push(`${response.status()} ${new URL(response.url()).pathname}`)
})
page.on('requestfailed', (request) =>
  network.push(`${request.failure()?.errorText} ${new URL(request.url()).pathname}`),
)
try {
  await page.goto(`${fixture.url}/c/1`)
  await page.getByLabel('Email', { exact: true }).fill('mobile@fixture.test')
  await page.getByRole('button', { name: 'Email me a code', exact: true }).click()
  await page.getByLabel('Sign-in code', { exact: true }).fill('123456')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await page.getByText('Connected', { exact: true }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/c/1')
  await page.getByLabel('Message your goblin', { exact: true }).fill('Hello from mobile')
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await page.getByRole('button', { name: 'Retry', exact: true }).waitFor()
  assert.equal(await page.getByLabel('Message your goblin', { exact: true }).isEditable(), false)
  await page.getByRole('button', { name: 'Retry', exact: true }).click()
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor()
  assert.equal(fixture.operations.length, 2)
  assert.deepEqual(fixture.operations[0], fixture.operations[1])
  assert.equal(fixture.operations[0]?.header, fixture.operations[0]?.operationId)
  fixture.batch([
    { type: 'entry_appended', entry: { id: 1, kind: 'user', model: [{ role: 'user', content: 'Hello from mobile' }] } },
    { type: 'run_start' },
    {
      type: 'message_update',
      changes: [{ type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Working' } }],
    },
  ])
  await page.getByText('Working', { exact: true }).waitFor()
  fixture.batch([{ type: 'message_update', changes: [{ type: 'text_delta', contentIndex: 0, delta: ' with you.' }] }])
  await page.getByText('Working with you.', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => window.innerWidth), 390)
  const composer = await page.getByLabel('Message your goblin', { exact: true }).boundingBox()
  const layout = await page.evaluate(() =>
    Array.from(document.querySelectorAll('div'))
      .slice(0, 16)
      .map((element) => ({
        height: element.getBoundingClientRect().height,
        display: getComputedStyle(element).display,
        flex: getComputedStyle(element).flex,
      })),
  )
  assert.ok(composer && composer.y > 700 && composer.y + composer.height <= 844, JSON.stringify(layout))
  await mkdir('dist/proof', { recursive: true })
  await page.screenshot({ path: 'dist/proof/mobile-chat.png' })
  await Promise.all([
    page.waitForResponse((response) => response.url().endsWith('/stop')),
    page.getByRole('button', { name: 'Stop', exact: true }).click(),
  ])
  assert.equal(fixture.stops(), 1)
  await page.reload()
  await page.getByText('Connected', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Sign out', exact: true }).click()
  await page.getByRole('button', { name: 'Email me a code', exact: true }).waitFor()
  assert.deepEqual(errors, [])
  console.log(
    'PASS browser: OTP flow, deep link, send retry identity, incremental SSE, Stop, restore, sign-out; zero page errors',
  )
} catch (error) {
  await mkdir('dist/proof', { recursive: true })
  await page.screenshot({ path: 'dist/proof/browser-failure.png' })
  console.error({ errors, network, text: await page.locator('body').innerText() })
  throw error
} finally {
  await browser.close()
  await fixture.close()
}
