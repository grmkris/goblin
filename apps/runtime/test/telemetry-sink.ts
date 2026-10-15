import type { RunEvent } from '@goblin/contracts/telemetry'
import type { RunSink } from '../src/telemetry/events.ts'

/** Keeps every event in memory, last state per id, for a test to read. */
export class CollectedRuns implements RunSink {
  readonly name = 'collected'
  readonly #events = new Map<string, RunEvent>()
  started(event: RunEvent): void {
    this.#events.set(event.id, event)
  }
  ended(event: RunEvent): void {
    this.#events.set(event.id, event)
  }
  /** Every event in the order it first appeared. */
  events(): readonly RunEvent[] {
    return [...this.#events.values()]
  }
}
