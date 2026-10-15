import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Page } from 'playwright-core'
import { preview } from 'vite'

const { values } = parseArgs({ options: { url: { type: 'string' }, out: { type: 'string' } } })
const output = resolve(values.out ?? '../../.local/openui-spike')
mkdirSync(output, { recursive: true })
const server =
  values.url === undefined ? await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } }) : undefined
const url = values.url ?? server?.resolvedUrls?.local[0]
if (url === undefined) throw new Error('The preview server did not return a URL.')
const browser = await chromium.launch()
const failures: string[] = []
const checks: string[] = []

async function fit(page: Page, name: string) {
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
    `${name}: horizontal overflow`,
  )
  checks.push(`${name}: fits viewport`)
}

try {
  for (const width of [1440, 390]) {
    const label = width === 390 ? 'phone' : 'desktop'
    const page = await browser.newPage({
      viewport: { width, height: width === 390 ? 844 : 1000 },
      reducedMotion: 'reduce',
      isMobile: width === 390,
      hasTouch: width === 390,
    })
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('request', (request) => {
      if (new URL(request.url()).origin !== new URL(url).origin)
        failures.push(`Unexpected external request: ${request.url()}`)
    })
    await page.goto(url)
    await page.getByRole('heading', { name: 'A slower weekend in Lisbon' }).waitFor()
    const chooseGarden = page.getByRole('button', { name: 'Choose Casa do Jardim' })
    await chooseGarden.click()
    assert.match(await page.getByRole('region', { name: 'Local action receipt' }).innerText(), /Choose Casa do Jardim/)
    checks.push(`${label}: visible option becomes follow-up`)
    await page.getByRole('button', { name: 'Reset example' }).click()
    await fit(page, `${label} hotels`)
    await page.screenshot({ path: resolve(output, `${label}-hotels.png`), fullPage: true })

    await page.getByRole('tab', { name: 'Plan a weekend' }).click()
    await page.getByLabel('Where would you like to go?').fill('Porto')
    await page.getByLabel('How many days?').fill('4')
    await page.getByLabel('Your kind of weekend').selectOption('Packed with plans')
    await page.getByRole('button', { name: 'Plan my weekend' }).click()
    const receipt = await page.getByRole('region', { name: 'Local action receipt' }).innerText()
    assert.match(receipt, /Porto/)
    assert.match(receipt, /"label":"How many days\?","value":"4"/)
    assert.match(receipt, /Packed with plans/)
    checks.push(`${label}: form values reach action receipt`)
    await fit(page, `${label} form`)
    await page.screenshot({ path: resolve(output, `${label}-form.png`), fullPage: true })
    await page.getByRole('button', { name: 'Replay stream' }).click()
    await page.locator('[data-streaming="true"]').waitFor()
    assert.equal(await page.getByRole('form', { name: 'Interactive reply' }).count(), 0)
    checks.push(`${label}: incomplete fence stays code`)
    await page.getByRole('button', { name: 'Show all' }).click()
    await page.getByRole('button', { name: 'Plan my weekend' }).waitFor()
    assert.equal(await page.getByRole('button', { name: 'Plan my weekend' }).isEnabled(), true)
    await page.getByLabel('OpenUI source').fill('root = Stack([UnknownWidget("oops")])')
    await page.getByRole('button', { name: 'Render code' }).click()
    await page.getByText('Check the source', { exact: true }).waitFor()
    checks.push(`${label}: invalid source shown without breaking last reply`)
    await page.getByRole('button', { name: 'Reset example' }).click()
    await page.getByLabel('OpenUI source').fill('root = Stack([Heading("Edited reply", "Still Goblin components.")])')
    await page.getByRole('button', { name: 'Render code' }).click()
    await page.getByRole('heading', { name: 'Edited reply' }).waitFor()
    checks.push(`${label}: source edits render`)

    await page.getByRole('tab', { name: 'Review the week' }).click()
    await page.locator('.recharts-wrapper').waitFor()
    await page.waitForTimeout(700)
    await fit(page, `${label} dashboard`)
    await page.screenshot({ path: resolve(output, `${label}-dashboard.png`), fullPage: true })
    await page.getByRole('button', { name: 'Use dark theme' }).click()
    await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
    const foreground = await page.locator('.spike-intro h1').evaluate((node) => getComputedStyle(node).color)
    const headingColors = await page
      .locator('.spike-renderer h2')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))
    assert(
      headingColors.length > 0 && headingColors.every((color) => color === foreground),
      'Dark reply headings follow the theme',
    )
    const metricColors = await page
      .locator('.spike-renderer dd:first-of-type')
      .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).color))
    assert(
      metricColors.length > 0 && metricColors.every((color) => color === foreground),
      'Dark reply metrics follow the theme',
    )
    checks.push(`${label}: dark headings and metric values use the foreground color`)
    await page.screenshot({ path: resolve(output, `${label}-dark.png`), fullPage: true })
    if (width === 390) {
      await page.getByRole('tab', { name: 'Plan a weekend' }).click()
      assert(
        Number.parseFloat(
          await page.getByLabel('Where would you like to go?').evaluate((input) => getComputedStyle(input).fontSize),
        ) >= 16,
      )
      checks.push('phone: input text avoids Safari zoom')
    }
    await page.reload()
    await page.getByRole('heading', { name: 'A slower weekend in Lisbon' }).waitFor()
    checks.push(`${label}: reload resets to documented default`)
    await page.close()
  }
  assert.deepEqual(failures, [])
  checks.push('no page errors or external requests')
  writeFileSync(
    resolve(output, 'receipt.json'),
    JSON.stringify({ url, checks, passed: checks.length, failed: failures.length }, null, 2),
  )
  console.info(JSON.stringify({ passed: checks.length, failed: 0, output }))
} finally {
  await browser.close()
  await new Promise<void>((done) => {
    if (server === undefined) done()
    else server.httpServer.close(() => done())
  })
}
