import { projectBatch, projectSnapshot, type ConversationProjection } from '../../../apps/web/src/lib/projection.ts'
import { ApiFailure, type GoblinApi } from './api.ts'
import { readSse } from './sse.ts'

export type ConversationState = {
  readonly projection?: ConversationProjection
  readonly status: string
  readonly signedOut?: boolean
}

/** Goblin's existing pure Pi projection, with native fetch and fresh-snapshot recovery on every reconnect. */
export class MobileConversation {
  #controller: AbortController | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #attempt = 0
  #projection: ConversationProjection | undefined
  constructor(
    readonly api: GoblinApi,
    readonly chat: string,
    readonly publish: (state: ConversationState) => void,
  ) {}
  pause(): void {
    clearTimeout(this.#retry)
    this.#controller?.abort()
    this.#controller = undefined
  }
  reconnect(): void {
    this.pause()
    const controller = new AbortController()
    this.#controller = controller
    void this.#follow(controller).catch(() => {
      // expected: a disposed UI subscriber cannot receive another state; stop its stream.
      this.pause()
    })
  }
  async #follow(controller: AbortController): Promise<void> {
    const signal = controller.signal
    this.publish({ projection: this.#projection, status: 'Connecting…' })
    try {
      const snapshot = await this.api.snapshot(this.chat, signal)
      if (signal.aborted) return
      this.#projection = projectSnapshot(snapshot)
      this.publish({ projection: this.#projection, status: 'Connecting…' })
      const response = await this.api.events(this.chat, signal)
      await readSse(response, signal, (frame) => {
        const value: unknown = JSON.parse(frame.data)
        if (frame.event === 'snapshot') this.#projection = projectSnapshot(value)
        else if (frame.event === 'batch' && this.#projection) this.#projection = projectBatch(this.#projection, value)
        else return
        this.#attempt = 0
        this.publish({ projection: this.#projection, status: 'Connected' })
      })
      if (!signal.aborted) this.#again('Connection ended. Reconnecting…')
    } catch (error) {
      // expected: connection failures are visible and retry from a fresh snapshot; auth refusals stop retries.
      if (signal.aborted) return
      if (error instanceof ApiFailure && [400, 401, 403, 404].includes(error.status)) {
        this.publish({ projection: this.#projection, status: error.message, signedOut: error.status === 401 })
      } else this.#again('Connection interrupted. Reconnecting…')
    }
  }
  #again(status: string): void {
    this.publish({ projection: this.#projection, status })
    const delay = Math.min(30_000, 1000 * 2 ** this.#attempt++)
    this.#retry = setTimeout(() => this.reconnect(), delay)
  }
}
