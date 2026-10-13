import { describe, expect, it } from 'vitest'
import { GoblinApi } from '../src/api.ts'
import { MobileConversation, type ConversationState } from '../src/conversation.ts'
import { browserSession } from '../src/session.ts'

const snapshot = { type: 'snapshot', entries: [], tools: [], inbox: [] }
const entry = { id: 1, kind: 'user', model: [{ role: 'user', content: 'Hello' }] }
const frame = (event: string, data: object) =>
  new TextEncoder().encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

function fixture() {
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined
  let snapshots = 0
  let cancelled = 0
  const states: ConversationState[] = []
  const api = new GoblinApi({
    origin: 'https://goblin.test',
    native: false,
    sessions: browserSession,
    fetch: async (input) => {
      if ((input instanceof Request ? input.url : input.toString()).endsWith('/snapshot')) {
        snapshots += 1
        return Response.json(snapshot)
      }
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            sink = controller
            controller.enqueue(frame('snapshot', snapshot))
          },
          cancel() {
            cancelled += 1
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const connection = new MobileConversation(api, '1', (state) => states.push(state))
  return {
    connection,
    states,
    send: (data: object) => sink?.enqueue(frame('batch', data)),
    snapshots: () => snapshots,
    cancelled: () => cancelled,
  }
}

describe('native conversation lifecycle', () => {
  it('reuses Goblin projection for token deltas and deduplicates committed entries', async () => {
    const f = fixture()
    f.connection.reconnect()
    try {
      await expect.poll(() => f.states.at(-1)?.status).toBe('Connected')
      f.send([
        { type: 'entry_appended', entry },
        { type: 'message_end', entry },
        {
          type: 'message_update',
          changes: [
            { type: 'text_start', contentIndex: 0, block: { type: 'text', text: 'Hi' } },
            { type: 'text_delta', contentIndex: 0, delta: ' there' },
          ],
        },
      ])
      await expect.poll(() => f.states.at(-1)?.projection?.partial).toBe('Hi there')
      expect(f.states.at(-1)?.projection?.messages).toEqual([{ id: '1:0', role: 'user', text: 'Hello' }])
    } finally {
      f.connection.pause()
    }
    await expect.poll(f.cancelled).toBe(1)
  })
  it('cancels the previous stream and fetches a fresh snapshot on foreground/resume', async () => {
    const f = fixture()
    f.connection.reconnect()
    try {
      await expect.poll(() => f.states.at(-1)?.status).toBe('Connected')
      f.connection.pause()
      f.connection.reconnect()
      await expect.poll(f.snapshots).toBe(2)
      await expect.poll(f.cancelled).toBe(1)
      await expect.poll(() => f.states.at(-1)?.status).toBe('Connected')
    } finally {
      f.connection.pause()
    }
    await expect.poll(f.cancelled).toBe(2)
  })
})
