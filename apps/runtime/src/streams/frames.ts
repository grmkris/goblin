import type { AguiEvent } from '@goblin/contracts'
import * as Stream from 'effect/Stream'
import { redactSecrets } from './redact.ts'

// A chat's stream on the wire (docs/architecture/streams.md): server-sent events, one `data:` frame per AG-UI event,
// LF line ends, and nothing else a reader must know of: no `event:` names, ids or retry hints.

/** Comment frames keep an idle connection open through proxies that close silent ones. */
const HEARTBEAT = '15 seconds'

/** One event as its frame, its secrets redacted (`redact.ts`). */
const frameOf = (event: AguiEvent): string => `data: ${redactSecrets(event)}\n\n`

/** `batches` as the bytes of a server-sent events body: each event a frame, a `: ping` comment every fifteen seconds. */
export const sseFrames = <E, R>(batches: Stream.Stream<readonly AguiEvent[], E, R>): Stream.Stream<Uint8Array, E, R> =>
  batches.pipe(
    Stream.map((events) => events.map(frameOf).join('')),
    Stream.merge(
      Stream.tick(HEARTBEAT).pipe(
        Stream.drop(1),
        Stream.map(() => ': ping\n\n'),
      ),
      { haltStrategy: 'left' },
    ),
    Stream.encodeText,
  )
