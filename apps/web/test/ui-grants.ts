/** Local browser regression: one request per bulk action, confirmed switches, pending controls and retry. */
import assert from 'node:assert/strict'
import { mkdirSync, writeSync } from 'node:fs'
import path from 'node:path'
import { createServer } from 'vite'
import { chromium } from 'playwright-core'
import { GrantBatchChange, type Grant, type ToolView } from '@goblin/contracts'
import * as Schema from 'effect/Schema'

const out = path.resolve(import.meta.dirname, '../../../.local/goblin-acceptance', `grants-${Date.now()}`)
mkdirSync(out, { recursive: true, mode: 0o700 })
const tools: ToolView[] = Array.from({ length: 80 }, (_, i) => ({
  name: `tool_${i}`,
  title: `Tool ${i}`,
  suggested: 'run',
  modelVisible: i !== 1,
  granted: i === 0,
  askFirst: i === 0,
  ...(i < 2 ? { appResource: 'ui://notes/board' } : {}),
}))
const server = await createServer({ configFile: path.join(import.meta.dirname, 'browser/vite.config.ts') })
await server.listen()
const origin = server.resolvedUrls?.local[0]
assert(origin)
const browser = await chromium.launch()
try {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    const errors: string[] = []
    const calls: string[] = []
    let held: Grant[] = [{ connectionId: 'notes', capability: 'tool', name: 'tool_0', askFirst: true }]
    let reply = Promise.withResolvers<void>()
    let refuse = false
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const request = route.request()
        const pathname = new URL(request.url()).pathname
        calls.push(`${request.method()} ${pathname}`)
        if (pathname === '/api/mcp/notes/tools') {
          await route.fulfill({ json: tools })
          return
        }
        assert.equal(pathname, '/api/mcp/grants/batch')
        const change = Schema.decodeUnknownSync(GrantBatchChange)(request.postDataJSON())
        assert.equal(change.connectionId, 'notes')
        if (refuse) {
          await route.fulfill({
            status: 502,
            json: {
              error: {
                code: 'upstream_mcp',
                message: 'The MCP server did not respond as expected.',
                connectionId: 'notes',
                reason: 'remote-rpc',
                ref: 'fixture',
              },
            },
          })
          return
        }
        await reply.promise
        if (change.allowed)
          held.push(...change.names.map((name) => ({ connectionId: 'notes', capability: 'tool' as const, name })))
        else held = held.filter((grant) => !change.names.includes(grant.name))
        await route.fulfill({ json: { grants: held, missing: [] } })
      },
    )
    await page.goto(`${origin}grants.html`)
    await page.getByText('1 of 80 allowed', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Allow all', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[role="switch"][data-disabled]').length === 81)
    assert.equal(await page.getByRole('switch', { name: 'Tool 1', exact: true }).getAttribute('aria-checked'), 'false')
    assert.equal(calls.filter((call) => call.startsWith('PUT')).length, 1)
    reply.resolve()
    await page.getByText('80 of 80 allowed', { exact: true }).waitFor()
    assert.equal(await page.getByRole('combobox', { name: 'When Tool 0 is called' }).inputValue(), 'ask')
    await page.screenshot({ path: path.join(out, `${width}-allowed.png`) })
    refuse = true
    await page.getByRole('button', { name: 'None', exact: true }).click()
    await page.getByRole('button', { name: 'None', exact: true }).waitFor({ state: 'visible' })
    await page.getByText(/ref fixture/).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('[role="switch"][data-disabled]').length === 0)
    assert.equal(await page.getByRole('switch', { name: 'Tool 1', exact: true }).getAttribute('aria-checked'), 'true')
    refuse = false
    reply = Promise.withResolvers<void>()
    await page.getByRole('button', { name: 'None', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('[role="switch"][data-disabled]').length === 81)
    reply.resolve()
    await page.getByText('0 of 80 allowed', { exact: true }).waitFor()
    assert.deepEqual(calls, [
      'GET /api/mcp/notes/tools',
      ...Array.from({ length: 3 }, () => 'PUT /api/mcp/grants/batch'),
    ])
    assert.deepEqual(errors, [])
    await page.close()
  }
  writeSync(1, `Batch grants browser checks passed at 1280px and 390px. Screenshots: ${out}\n`)
} finally {
  await browser.close()
  await server.close()
}
