import { mkdir } from 'node:fs/promises'
import { chromium } from 'playwright-core'
import { startServer } from '../service/server'
const token = crypto.randomUUID()
const server = startServer({ token })
const browser = await chromium.launch({
  // oxlint-disable-next-line goblin/no-process-env -- This native desktop CLI reads launch settings, not Worker configuration.
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  headless: true,
})
await mkdir('artifacts', { recursive: true })
let checks = 0
const check = (value: boolean, why: string) => {
  if (!value) throw new Error(why)
  checks++
}
try {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } })
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.port}/?host=browser#token=${token}`, { waitUntil: 'domcontentloaded' })
  await page.getByRole('status').filter({ hasText: 'Local fixture' }).waitFor()
  check(!page.url().includes(token), 'capability must be removed from address bar')
  await page.screenshot({ path: 'artifacts/browser-initial.png' })
  await page.getByRole('button', { name: 'Stress history' }).click()
  await page.getByText('204 messages', { exact: true }).waitFor()
  checks++
  const input = page.getByRole('textbox', { name: 'Message Goblin' })
  await input.fill('Compare all three desktop shells.')
  await input.press('Enter')
  await page.getByRole('button', { name: 'Stop reply' }).waitFor()
  const partial = page.locator('.message').last().locator('.message-body')
  await page.waitForFunction(
    () => (document.querySelector('.message:last-child .message-body')?.textContent?.length ?? 0) > 15,
  )
  const before = (await partial.innerText()).length
  await page.waitForTimeout(180)
  check((await partial.innerText()).length > before, 'reply must grow while streaming')
  await input.fill('A draft stays focused during streaming')
  await page.waitForTimeout(120)
  check(await input.evaluate((element) => document.activeElement === element), 'focus must survive streaming')
  check((await input.inputValue()) === 'A draft stays focused during streaming', 'draft must survive streaming')
  await page.locator('#transcript').evaluate((element) => {
    element.scrollTop = 100
  })
  await page.waitForTimeout(140)
  check(
    await page.locator('#transcript').evaluate((element) => element.scrollTop < 200),
    'stream must preserve reading position',
  )
  await page.getByRole('button', { name: 'Stop reply' }).click()
  await page.getByRole('status').filter({ hasText: 'Reply stopped' }).waitFor()
  const stopped = await partial.innerText()
  await page.waitForTimeout(150)
  check((await partial.innerText()) === stopped && stopped.length > 0, 'stop keeps partial without later chunks')
  await page.getByRole('button', { name: 'From your desk to your phone' }).click()
  await page.getByRole('heading', { name: 'From your desk to your phone' }).waitFor()
  await page.getByRole('button', { name: 'New conversation' }).click()
  await page.getByRole('heading', { name: 'New conversation' }).waitFor()
  check((await page.locator('.message').count()) === 0, 'new chat is empty')
  await input.fill('<img src=x onerror="window.bad=1"> **safe**')
  await input.press('Enter')
  await page.getByRole('button', { name: 'Stop reply' }).waitFor()
  check((await page.locator('.message img').count()) === 0, 'HTML is not activated')
  await page.getByRole('button', { name: 'Tools that have a view' }).click()
  await page.getByRole('heading', { name: 'Tools that have a view' }).waitFor()
  await page.waitForTimeout(150)
  check((await page.locator('.message').count()) === 2, 'switch cancels stale response')
  await page.getByRole('button', { name: 'Reconnect' }).click()
  await page.getByRole('status').filter({ hasText: 'Reconnected' }).waitFor()
  checks++
  await page.getByRole('button', { name: 'A home for your agent' }).click()
  await page.screenshot({ path: 'artifacts/browser-final.png' })
  check(errors.length === 0, `page errors: ${errors.join('; ')}`)
  process.stdout.write(`browser acceptance: ${checks} passed, 0 skipped (Chromium fixture only)\n`)
} finally {
  await browser.close()
  await server.stop()
}
