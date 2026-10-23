/** Local source-component proof: GitHub/custom policy save, validation and disabling, desktop/phone, light/dark. */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium, type BrowserContextOptions, type Page } from 'playwright-core'
import { CreateTrustedWorkload, type TrustedWorkloadView, presetFor } from '@goblin/contracts'
import * as Schema from 'effect/Schema'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `workloads-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const decode = Schema.decodeUnknownSync(CreateTrustedWorkload)
const errors: string[] = []
let saved = 0
let disabled = 0

async function serve(page: Page) {
  const policies: TrustedWorkloadView[] = []
  await page.route(
    (url) => url.pathname.startsWith('/api/'),
    async (route) => {
      const request = route.request()
      const pathname = new URL(request.url()).pathname
      const method = request.method()
      if (pathname === '/api/auth/get-session')
        return route.fulfill({
          json: { user: { id: 'u1', name: 'User', email: 'user@example.test' }, session: { id: 's1' } },
        })
      if (pathname === '/api/keys' && method === 'GET')
        return route.fulfill({
          json: [
            { id: 'key_ci', name: 'CI', grantId: 'key_ci', createdAt: '2026-10-23', terms: presetFor('CI', ['w1']) },
          ],
        })
      if (pathname === '/api/trusted-workloads' && method === 'GET') return route.fulfill({ json: policies })
      if (pathname === '/api/trusted-workloads' && method === 'POST') {
        const input = decode(request.postDataJSON())
        const policy = {
          id: `wl_${policies.length}`,
          ...input,
          label: input.policy.label ?? '',
          createdBy: 'u1',
          createdAt: '2026-10-23',
        }
        policies.push(policy)
        saved++
        return route.fulfill({ status: 201, json: policy })
      }
      const policy = policies.find((each) => pathname === `/api/trusted-workloads/${each.id}/disable`)
      if (policy !== undefined && method === 'POST') {
        policies.splice(policies.indexOf(policy), 1, { ...policy, disabledAt: '2026-10-23' })
        disabled++
        return route.fulfill({ json: { disabled: true } })
      }
      errors.push(`Unexpected ${method} ${pathname}`)
      return route.fulfill({ status: 404, json: {} })
    },
  )
  return policies
}

async function drive(page: Page, origin: string, label: string) {
  page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`))
  const policies = await serve(page)
  await page.goto(`${origin}workloads.html`)
  try {
    await page.getByText('No trusted workloads yet.').waitFor({ timeout: 15000 })
  } catch (cause) {
    await page.screenshot({ path: path.join(out, `${label}-failure.png`), fullPage: true })
    writeSync(1, `${JSON.stringify({ errors, body: await page.locator('body').innerText() })}\n`)
    throw cause
  }
  const save = page.getByRole('button', { name: 'Save trust policy' })
  assert(await save.isDisabled())
  await page.getByLabel('Server grant', { exact: true }).selectOption('key_ci')
  await page.getByLabel('Workload name', { exact: true }).fill('GitHub CI')
  await page.getByLabel('Repository', { exact: true }).fill('acme/worker')
  await page.getByLabel('Branch', { exact: true }).fill('dev')
  await page.getByRole('checkbox', { name: "Stop accepting this key's static secret when saving" }).click()
  await save.click()
  await page.getByRole('button', { name: 'Disable GitHub CI', exact: true }).waitFor()
  assert.deepEqual(policies[0]?.policy, {
    issuer: 'https://token.actions.githubusercontent.com',
    label: 'GitHub CI',
    claims: {
      aud: [new URL(origin).origin],
      repository: ['acme/worker'],
      ref: ['refs/heads/dev'],
      sub: ['repo:acme/worker:ref:refs/heads/dev'],
    },
  })
  await page.getByLabel('Provider', { exact: true }).selectOption('custom')
  await page.getByLabel('Workload name', { exact: true }).fill('Swarmm')
  await page.getByLabel('Issuer', { exact: true }).fill('http://issuer.example')
  await page.getByLabel('Subject', { exact: true }).fill('swarmm:prod')
  assert(await save.isDisabled(), 'HTTP issuers must be refused before save')
  await page.getByLabel('Issuer', { exact: true }).fill('https://swarmm.example')
  await save.click()
  await page.getByRole('button', { name: 'Disable Swarmm', exact: true }).waitFor()
  assert.deepEqual(policies[1]?.policy, {
    issuer: 'https://swarmm.example',
    label: 'Swarmm',
    claims: { aud: [new URL(origin).origin], sub: ['swarmm:prod'] },
  })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth), 0, label)
  await page.screenshot({ path: path.join(out, `${label}-saved.png`), fullPage: true })
  await page.getByRole('button', { name: 'Disable Swarmm', exact: true }).click()
  await page
    .getByRole('alertdialog', { name: 'Disable Swarmm?' })
    .getByRole('button', { name: 'Disable trust' })
    .click()
  await page.getByText('Disabled', { exact: true }).waitFor()
  await page.screenshot({ path: path.join(out, `${label}-disabled.png`), fullPage: true })
}

const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const sizes: readonly BrowserContextOptions[] = [
      { viewport: { width: 1440, height: 900 } },
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    ]
    for (const options of sizes) {
      const page = await browser.newPage({ ...options, colorScheme })
      await drive(page, origin, `${options.viewport?.width}-${colorScheme}`)
      await page.close()
    }
  }
  assert.deepEqual(errors, [])
  writeSync(1, `${JSON.stringify({ ok: true, saved, disabled, out })}\n`)
} finally {
  await browser.close()
  await server.close()
}
