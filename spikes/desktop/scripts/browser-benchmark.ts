import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright-core'
import { startServer } from '../service/server'

function distribution(values: number[]) {
  // oxlint-disable-next-line unicorn/no-array-sort -- The spike targets ES2022; sort a private copy without mutating samples.
  const sorted = [...values].sort((a, b) => a - b)
  const size = sorted.length
  return {
    count: size,
    median: size ? (sorted[Math.floor((size - 1) / 2)] + sorted[Math.floor(size / 2)]) / 2 : null,
    p95: size ? sorted[Math.ceil(size * 0.95) - 1] : null,
    peak: size ? sorted[size - 1] : null,
  }
}
async function scroll(page: Page, seconds: number) {
  return page.evaluate(async (durationMs) => {
    const transcript = document.querySelector('#transcript')
    if (!(transcript instanceof HTMLElement)) throw new Error('Transcript missing')
    const before = {
      messageCount: transcript.children.length,
      domNodeCount: transcript.querySelectorAll('*').length,
      scrollHeight: transcript.scrollHeight,
      clientHeight: transcript.clientHeight,
      devicePixelRatio,
      visibility: document.visibilityState,
      streaming: !document.querySelector('#stop')?.hasAttribute('hidden'),
    }
    if (before.scrollHeight <= before.clientHeight) throw new Error('Fixture is not scrollable')
    const intervals: number[] = []
    const work: number[] = []
    const longTasks: number[] = []
    const observer = PerformanceObserver.supportedEntryTypes.includes('longtask')
      ? new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) longTasks.push(entry.duration)
        })
      : undefined
    observer?.observe({ type: 'longtask' })
    transcript.scrollTop = 0
    let start: number | undefined
    let previous: number | undefined
    let minPosition = Infinity
    let maxPosition = 0
    try {
      await new Promise<void>((resolve, reject) => {
        let frame = 0
        const deadline = setTimeout(() => {
          cancelAnimationFrame(frame)
          reject(new Error('Frame callback timeout'))
        }, durationMs + 5000)
        const step = (now: number) => {
          start ??= now
          if (previous !== undefined) intervals.push(now - previous)
          previous = now
          const progress = Math.min(1, (now - start) / durationMs)
          const began = performance.now()
          const fraction = progress < 0.5 ? progress * 2 : (1 - progress) * 2
          transcript.scrollTop = (transcript.scrollHeight - transcript.clientHeight) * fraction
          const position = transcript.scrollTop
          minPosition = Math.min(minPosition, position)
          maxPosition = Math.max(maxPosition, position)
          work.push(performance.now() - began)
          if (progress === 1) {
            clearTimeout(deadline)
            resolve()
          } else frame = requestAnimationFrame(step)
        }
        frame = requestAnimationFrame(step)
      })
      for (const entry of observer?.takeRecords() ?? []) longTasks.push(entry.duration)
    } finally {
      observer?.disconnect()
    }
    return {
      before,
      after: {
        messageCount: transcript.children.length,
        domNodeCount: transcript.querySelectorAll('*').length,
        scrollTop: transcript.scrollTop,
        streaming: !document.querySelector('#stop')?.hasAttribute('hidden'),
      },
      minPosition,
      maxPosition,
      frameIntervalsMs: intervals,
      scrollStepJsMs: work,
      longTaskDurationsMs: observer ? longTasks : null,
    }
  }, seconds * 1000)
}

async function runTrial(browser: Browser, trial: number, workload: string, seconds: number) {
  const token = crypto.randomUUID()
  const server = startServer({ token, liveOrigin: 'http://127.0.0.1:1' })
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, deviceScaleFactor: 1 })
  try {
    const page = await context.newPage()
    page.setDefaultTimeout(15000)
    let pageErrors = 0
    page.on('pageerror', () => pageErrors++)
    await page.goto(`http://127.0.0.1:${server.port}/?host=browser#token=${token}`)
    await page.getByRole('status').filter({ hasText: 'Local fixture' }).waitFor()
    await page.getByRole('button', { name: 'Stress history' }).click()
    await page.getByText('204 messages', { exact: true }).waitFor()
    if (workload === 'streaming_history') {
      await page.getByRole('textbox', { name: 'Message Goblin' }).fill('Fixture scroll benchmark')
      await page.getByRole('textbox', { name: 'Message Goblin' }).press('Enter')
      await page.getByRole('button', { name: 'Stop reply' }).waitFor()
      await page.getByText('206 messages', { exact: true }).waitFor()
    }
    const raw = await scroll(page, seconds)
    if (
      raw.before.messageCount !== (workload === 'history' ? 204 : 206) ||
      raw.frameIntervalsMs.length < 2 ||
      pageErrors
    )
      throw new Error('Invalid benchmark trial')
    return {
      trial,
      workload,
      status: 'pass',
      ...raw,
      frameIntervalsSummaryMs: distribution(raw.frameIntervalsMs),
      scrollStepJsSummaryMs: distribution(raw.scrollStepJsMs),
    }
  } catch {
    // expected: Persist a fixed failed receipt; Playwright errors can include the capability-bearing URL.
    return { trial, workload, status: 'fail', reason: 'browser_fixture_or_scroll_probe_failed' }
  } finally {
    await context.close()
    await server.stop()
  }
}

const argv = process.argv.slice(2).filter((arg) => arg !== '--')
let trials = 3
let seconds = 2
let output = `artifacts/browser-benchmark-${Date.now()}.json`
for (let i = 0; i < argv.length; i += 2) {
  const flag = argv[i]
  const value = argv[i + 1]
  if (!value) throw new Error('Expected --trials N --seconds N --output PATH')
  if (flag === '--trials') trials = Number(value)
  else if (flag === '--seconds') seconds = Number(value)
  else if (flag === '--output') output = value
  else throw new Error('Unknown browser benchmark option')
}
if (!Number.isInteger(trials) || trials < 1 || trials > 20 || !Number.isInteger(seconds) || seconds < 1 || seconds > 10)
  throw new Error('Use 1–20 trials and 1–10 seconds')
if (await Bun.file(output).exists()) throw new Error('Use a new output path to preserve previous evidence')
await mkdir(dirname(output), { recursive: true })
const receipts: object[] = []
let failures = 0
const browser = await chromium.launch({
  // oxlint-disable-next-line goblin/no-process-env -- The local benchmark selects an installed browser executable.
  ...(process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {}),
  headless: true,
})
try {
  for (let trial = 1; trial <= trials; trial++) {
    for (const workload of ['history', 'streaming_history']) {
      const receipt = await runTrial(browser, trial, workload, seconds)
      receipts.push(receipt)
      if (receipt.status === 'fail') failures++
    }
  }
  await writeFile(
    output,
    JSON.stringify(
      {
        schemaVersion: 1,
        scope: 'headless Chromium / shared retained DOM only',
        chromium: browser.version(),
        secondsPerScroll: seconds,
        trialsPerWorkload: trials,
        limitations: [
          'requestAnimationFrame intervals are scheduling proxies, not native GPU-presented frames.',
          'scrollStepJsMs times the scroll assignment/read only, not all renderer layout or paint work.',
          'Programmatic scrolling does not measure trackpad or OS event delivery.',
          'Streaming adds two rows to the 204-message fixture; the finite reply may finish during the trial.',
          'Long task data is null when unsupported, and includes browser work only.',
          'No native WebView, Metal, IME, VoiceOver or screenshots are measured.',
        ],
        receipts,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  await browser.close()
}
process.stdout.write(`browser benchmark: ${trials * 2 - failures} passed, ${failures} failed\n`)
process.exitCode = failures ? 1 : 0
