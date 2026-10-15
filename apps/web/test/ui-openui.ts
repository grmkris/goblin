/** Native Markdown rendering and owner submission in Chromium; HTTP is intercepted, no account or model. */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, writeSync } from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright-core'
import { createServer } from 'vite'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `openui-${Date.now()}`)
const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
if (origin === undefined) throw new Error('Missing fixture URL')
const browser = await chromium.launch()
const checks: string[] = []
const errors: string[] = []
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== new URL(origin).origin) errors.push(`External request: ${request.url()}`)
    })
    const submissions: { url: string; input: string; operationId: string; csrf: string | undefined }[] = []
    let release: (() => void) | undefined
    await page.route('**/api/conversations/*/messages', async (route) => {
      const request = route.request()
      const body = JSON.parse(request.postData() ?? '{}')
      submissions.push({
        url: request.url(),
        input: body.input,
        operationId: body.operationId,
        csrf: request.headers()['x-goblin-csrf'],
      })
      if (submissions.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
        await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' })
      } else
        await route.fulfill({
          status: 202,
          contentType: 'application/json',
          body: JSON.stringify({ operationId: body.operationId, session: 'fixture', accepted: true }),
        })
    })
    await page.goto(`${origin}openui.html`)
    const reply = page.getByRole('region', { name: 'Owner reply', exact: true })
    const button = reply.getByRole('button', { name: 'Plan my weekend' })
    await button.waitFor()
    await reply.getByLabel('Destination').fill('Porto')
    await reply.getByLabel('Days away').fill('4')
    await reply.getByLabel('Pace', { exact: true }).selectOption('Busy')
    await reply.getByLabel('Destination').press('Enter')
    await page.waitForFunction(() =>
      document.querySelector('[aria-label="Owner reply"] fieldset')?.hasAttribute('disabled'),
    )
    assert.equal(submissions.length, 1)
    assert.equal(await button.isDisabled(), true)
    release?.()
    await reply.getByRole('status').filter({ hasText: 'Could not send' }).waitFor()
    assert.equal(await reply.getByLabel('Destination').inputValue(), 'Porto')
    await button.click()
    await reply.getByRole('status').filter({ hasText: 'Reply recorded.' }).waitFor()
    assert.equal(submissions.length, 2)
    assert.equal(submissions[0]?.operationId, submissions[1]?.operationId)
    assert.equal(submissions[1]?.csrf, '1')
    assert.match(submissions[1]?.url ?? '', /\/101\/messages$/u)
    assert.match(submissions[1]?.input ?? '', /^Plan my weekend\n\nForm values:/u)
    assert.match(submissions[1]?.input ?? '', /"label":"Destination","value":"Porto"/u)
    assert.match(submissions[1]?.input ?? '', /"label":"Days away","value":"4"/u)
    checks.push(`${width}: keyboard send, pending lock, preserved form, same-operation retry through owner API`)
    await page.getByRole('button', { name: 'Close chat', exact: true }).click()
    assert.equal(await button.isDisabled(), true)
    assert.equal(await page.getByRole('region', { name: 'Quoted reply' }).getByRole('button').isDisabled(), true)
    await page.getByRole('button', { name: 'Reopen chat' }).click()
    assert.equal(await button.isEnabled(), true)
    await page.getByRole('button', { name: 'Ask in the other chat' }).click()
    await page.getByRole('region', { name: 'Other chat' }).getByRole('status').waitFor()
    assert.match(submissions[2]?.url ?? '', /\/202\/messages$/u)
    checks.push(`${width}: closed and quoted replies disabled, other chat uses its own submission`)
    assert.equal(await page.getByRole('region', { name: 'Streaming reply' }).locator('form').count(), 0)
    await page.getByRole('button', { name: 'Finish reply' }).click()
    await page.getByRole('region', { name: 'Streaming reply' }).getByRole('form').waitFor()
    assert.equal(await reply.getByLabel('Destination').inputValue(), 'Porto')
    for (const label of ['Invalid reply', 'Invalid chart'])
      await page.getByRole('region', { name: label, exact: true }).locator('pre').waitFor()
    assert.equal(await page.getByRole('region', { name: 'Inert text' }).locator('img, script').count(), 0)
    assert.equal(await page.locator('[data-openui-devtools-auto-mount]').count(), 0)
    checks.push(`${width}: streaming and invalid code fallback, inert text, no inspector in development`)
    mkdirSync(out, { recursive: true })
    for (const dark of [false, true]) {
      await page.evaluate((value) => document.documentElement.classList.toggle('dark', value), dark)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false)
      await page.screenshot({ path: path.join(out, `${width}-${dark ? 'dark' : 'light'}.png`), fullPage: true })
    }
    checks.push(`${width}: light/dark layout fits`)
    await page.close()
  }
  assert.deepEqual(errors, [])
} finally {
  mkdirSync(out, { recursive: true })
  writeFileSync(
    path.join(out, 'receipt.json'),
    JSON.stringify({ checks, errors, evidence: 'local Chromium; intercepted owner API' }, null, 2),
  )
  await browser.close()
  await server.close()
}
writeSync(1, JSON.stringify({ checks, errors, out }) + '\n')
