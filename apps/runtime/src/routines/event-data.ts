/** The most bytes of an event's data a run reads in its prompt; larger data is left out whole, never cut (ADR 0104). */
const EVENT_DATA_BYTES = 16_384

/** An event occurrence as the producer sent it: its name, its time and its data. */
type Occurrence = { readonly name: string; readonly timestamp: string; readonly data: unknown }

/**
 * What a run handed an event reads of it (ADR 0104): the event's name and time, and its data as the producer's JSON,
 * untouched. Data over {@link EVENT_DATA_BYTES} is left out with a note saying so, and the run reads it through the
 * server's own tools; the JSON is never cut. It stays untrusted data: the run's prompt labels it so, and it grants
 * nothing.
 */
export function eventMetadata({ name, timestamp, data }: Occurrence): string {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).byteLength
  if (bytes <= EVENT_DATA_BYTES) return JSON.stringify({ name, timestamp, data })
  const limit = String(EVENT_DATA_BYTES)
  const dataOmitted = `The event's data was ${String(bytes)} bytes, over the ${limit} a run reads; read it with the server's tools.`
  return JSON.stringify({ name, timestamp, dataOmitted })
}
