// A chat's stream on the wire (docs/architecture/streams.md): one `data:` frame per event with LF line ends, a comment
// frame while idle, and no secret goblin issues in any frame, however a tool's result came to hold it.
import { type AguiEvent, EventType } from '@goblin/contracts'
import { describe, expect, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Fiber from 'effect/Fiber'
import * as Stream from 'effect/Stream'
import * as TestClock from 'effect/testing/TestClock'
import { sseFrames } from '../../src/streams/frames.ts'
import { REDACTED, redactSecrets } from '../../src/streams/redact.ts'

/** Secrets shaped as goblin issues them: a server's key, a thread server's token, a Standard Webhooks secret. */
const KEY = `gbk_${'a1B2'.repeat(10)}`
const THREAD_TOKEN = `swt_${'x9_Y-'.repeat(6)}`
const WEBHOOK = `whsec_${btoa('0123456789abcdef0123456789abcdef')}`

/** A tool's result that echoes all three: in its content, in its details and in a nested call's arguments. */
const leaky: readonly AguiEvent[] = [
  {
    type: EventType.TOOL_CALL_RESULT,
    messageId: '1:tcall-1',
    toolCallId: 'call-1',
    content: `Here is the key: ${KEY}`,
    role: 'tool',
    metadata: { goblin: { details: { headers: { authorization: `Bearer ${THREAD_TOKEN}` }, secret: WEBHOOK } } },
  },
  { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-2', delta: JSON.stringify({ token: THREAD_TOKEN }) },
  { type: EventType.TEXT_MESSAGE_CONTENT, messageId: '1:a1', delta: 'Nothing secret here; gbk_ alone is a prefix.' },
]

/** The body `batches` make, as text. */
const body = (batches: Stream.Stream<readonly AguiEvent[]>) =>
  Effect.map(Stream.runCollect(Stream.decodeText(sseFrames(batches))), (chunks) => chunks.join(''))

describe("a chat's stream on the wire", () => {
  it.effect('sends one data frame per event, LF only, and every string holding a secret as [redacted]', () =>
    Effect.gen(function* () {
      const text = yield* body(Stream.make(leaky))
      expect(text).not.toContain('\r')
      const frames = text.split('\n\n').filter((frame) => frame !== '')
      expect(frames).toHaveLength(leaky.length)
      for (const frame of frames) expect(frame.startsWith('data: ')).toBe(true)
      const [result, args, words] = frames.map((frame) => JSON.parse(frame.slice('data: '.length)))
      expect(result).toMatchObject({
        content: REDACTED,
        metadata: { goblin: { details: { headers: { authorization: REDACTED }, secret: REDACTED } } },
      })
      expect(args).toMatchObject({ delta: REDACTED })
      expect(words).toEqual(leaky[2])
      expect(text).not.toMatch(/gbk_\w{8}|swt_[\w-]{8}|whsec_\S{8}/u)
    }),
  )

  it('redacts a value inside any structure, leaving everything else as it was', () => {
    const value = { list: [`swt_${'q'.repeat(20)}`, 'plain'], nested: { n: 1, ok: true, empty: null } }
    expect(JSON.parse(redactSecrets(value))).toEqual({
      list: [REDACTED, 'plain'],
      nested: { n: 1, ok: true, empty: null },
    })
  })

  it.effect('keeps an idle connection open with a comment frame every fifteen seconds', () =>
    Effect.gen(function* () {
      const reading = yield* Effect.forkChild(body(Stream.never.pipe(Stream.interruptWhen(Effect.sleep('31 seconds')))))
      yield* Effect.repeat(Effect.yieldNow, { times: 20 })
      yield* TestClock.adjust('31 seconds')
      expect(yield* Fiber.join(reading)).toBe(': ping\n\n: ping\n\n')
    }),
  )
})
