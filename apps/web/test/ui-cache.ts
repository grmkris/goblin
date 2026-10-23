/**
 * Cold, second-navigation and reload receipts for the real transcript fixture. No cloud, account or model.
 * heavy bun apps/web/test/ui-cache.ts [--dist <built-fixture>] [--out <receipt.json>] [--assert]
 * Controls isolate routing and asset headers: --route-control, --no-cache-headers.
 */
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { chromium, type Browser, type Page } from 'playwright-core'
import { install, serve } from './perf/browser.ts'
import { build, receiptDirectory, revision } from './perf/revision.ts'
import { history } from './perf/transcript-fixture.ts'

const { values: options } = parseArgs({
  options: {
    dist: { type: 'string' },
    out: { type: 'string' },
    reps: { type: 'string', default: '3' },
    assert: { type: 'boolean', default: false },
    'route-control': { type: 'boolean', default: false },
    'no-cache-headers': { type: 'boolean', default: false },
  },
})
const directory = receiptDirectory('cache')
const out = options.out ?? path.join(directory, 'receipt.json')
mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 })
const dist = options.dist ?? path.join(directory, 'build')
if (options.dist === undefined) build(revision('.'), dist, 'test/perf/vite.config.ts')

async function resourceStats(page: Page) {
  return page.evaluate(() => {
    const resources = performance
      .getEntriesByType('resource')
      .filter((entry): entry is PerformanceResourceTiming => entry instanceof PerformanceResourceTiming)
    const assets = resources.filter((entry) => new URL(entry.name).pathname.startsWith('/assets/'))
    const cached = resources.filter((entry) => entry.transferSize === 0 && entry.decodedBodySize > 0)
    return {
      readyMs: window.perf.ready,
      resources: resources.length,
      cached: cached.length,
      assets: assets.length,
      cachedAssets: cached.filter((entry) => new URL(entry.name).pathname.startsWith('/assets/')).length,
      transferredAssetBytes: assets.reduce((sum, entry) => sum + entry.transferSize, 0),
    }
  })
}

async function measure(browser: Browser, origin: string, rep: number) {
  const samples = []
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
  try {
    const page = await context.newPage()
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    let cacheHits = 0
    let requests = 0
    const cdp = await context.newCDPSession(page)
    await cdp.send('Network.enable')
    cdp.on('Network.requestServedFromCache', () => {
      cacheHits += 1
    })
    page.on('request', () => {
      requests += 1
    })
    const { entries, parts } = history(100)
    await install(page, entries)
    // An inert network route is enough to disable the entire cache: this is an intentional negative control.
    if (options['route-control']) await page.route('**/__never_routed__', (route) => route.continue())
    for (const navigation of ['cold', 'second', 'reload']) {
      cacheHits = 0
      requests = 0
      const start = performance.now()
      if (navigation === 'reload') await page.reload()
      else await page.goto(`${origin}/?parts=${parts}&visit=${navigation}`)
      await page.waitForFunction(() => window.perf.ready !== undefined)
      const metrics = await resourceStats(page)
      const row = {
        rep,
        navigation,
        wallMs: Math.round(performance.now() - start),
        requests,
        cdpCacheHits: cacheHits,
        ...metrics,
      }
      samples.push(row)
      if (options.assert && navigation !== 'cold') {
        assert(metrics.assets > 0, 'No hashed assets were measured')
        if (options['route-control'] || options['no-cache-headers']) assert.equal(metrics.cachedAssets, 0)
        else {
          assert.equal(metrics.cachedAssets, metrics.assets)
          assert.equal(metrics.transferredAssetBytes, 0)
          // CDP's requestServedFromCache event does not count every disk-cache response; resource timing does.
        }
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await context.close()
  }
  return samples
}

const served = await serve(dist, !options['no-cache-headers'])
const missing = await fetch(`${served.origin}/assets/missing-fixture.js`)
assert.equal(missing.status, 404)
assert.equal(missing.headers.get('cache-control'), 'no-store')
const browser = await chromium.launch()
const rows = []
try {
  for (let rep = 0; rep < Number(options.reps); rep += 1) rows.push(...(await measure(browser, served.origin, rep)))
} finally {
  await browser.close()
  served.close()
}
writeFileSync(
  out,
  JSON.stringify(
    {
      evidence: 'local Chromium, built transcript fixture',
      chromium: browser.version(),
      controls: { routing: options['route-control'], noCacheHeaders: options['no-cache-headers'] },
      rows,
    },
    null,
    2,
  ) + '\n',
)
console.info(JSON.stringify({ out, samples: rows.length, rows }))
