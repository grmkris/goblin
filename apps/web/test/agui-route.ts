// A chat's AG-UI stream served to a browser fixture page, as the deployment serves it: the join endpoint answers a link,
// `/streams/<chat>` answers what was written since an offset (Durable Streams' catch-up read), and a stand-in for
// `EventSource` delivers what the test writes next as the protocol's `data` and `control` events. Only the stream's
// own reads are faked; the page's reader, reducer and components are the real ones.
import type { Page, Route } from 'playwright-core'

/**
 * The `EventSource` stand-in, installed before the page loads: one per live read the page opens on a chat's stream.
 * `dropLiveReads` makes every open one fail, as a dropped connection does.
 */
export async function installLiveReads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let opened = 0
    class Live extends EventTarget {
      readonly url: string
      readonly #forward = (event: Event) => {
        if (!(event instanceof CustomEvent)) return
        const detail: unknown = event.detail
        if (typeof detail !== 'object' || detail === null || !('path' in detail) || !('events' in detail)) return
        if (!('next' in detail) || typeof detail.path !== 'string' || !this.url.includes(detail.path)) return
        this.dispatchEvent(new MessageEvent('data', { data: JSON.stringify(detail.events) }))
        const control = { streamNextOffset: detail.next, upToDate: true }
        this.dispatchEvent(new MessageEvent('control', { data: JSON.stringify(control) }))
      }
      readonly #drop = () => this.dispatchEvent(new Event('error'))
      constructor(url: string) {
        super()
        this.url = url
        if (url.includes('/streams/')) document.documentElement.dataset['streams'] = String(++opened)
        window.addEventListener('fixture-agui', this.#forward)
        window.addEventListener('fixture-agui-drop', this.#drop)
      }
      close() {
        window.removeEventListener('fixture-agui', this.#forward)
        window.removeEventListener('fixture-agui-drop', this.#drop)
      }
    }
    Object.defineProperty(window, 'EventSource', { value: Live })
  })
}

const offsetOf = (count: number) => String(count).padStart(6, '0')

/** One chat's stream: its events so far, read by offset. */
export class FixtureStream {
  readonly #events: unknown[]
  /** How many catch-up reads the page made. */
  reads = 0

  constructor(
    readonly chat: string,
    opening: readonly unknown[],
  ) {
    this.#events = [...opening]
  }

  /** The join endpoint's answer: a link to this stream, valid long past the test. */
  link(origin: string) {
    return {
      url: new URL(`streams/${this.chat}`, origin).href,
      epoch: 1,
      tier: 'full',
      expiresAt: '2099-01-01T00:00:00.000Z',
    }
  }

  /** A catch-up read of `/streams/<chat>?offset=`: everything after the offset, and the offset after it. */
  async read(route: Route): Promise<void> {
    this.reads += 1
    const offset = new URL(route.request().url()).searchParams.get('offset') ?? '-1'
    const from = offset === '-1' ? 0 : Number(offset)
    await route.fulfill({
      json: this.#events.slice(from),
      headers: { 'stream-next-offset': offsetOf(this.#events.length), 'stream-up-to-date': 'true' },
    })
  }

  /** Writes `events`, and hands them to the live reads open on this stream. */
  async write(page: Page, ...events: readonly unknown[]): Promise<void> {
    this.#events.push(...events)
    const detail = { path: `/streams/${this.chat}`, events, next: offsetOf(this.#events.length) }
    await page.evaluate((sent) => window.dispatchEvent(new CustomEvent('fixture-agui', { detail: sent })), detail)
  }
}

/** Every live read the page holds fails, as when the network drops. */
export const dropLiveReads = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('fixture-agui-drop')))
