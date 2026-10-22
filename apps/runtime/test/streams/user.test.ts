import { describe, expect, it } from 'vitest'
import { userParts } from '../../src/streams/user.ts'

// The server reads what the runtime wrote around a user's words (`pi/content.ts`) once, for every reader of the
// stream: only blocks after the words count, and only when each is one of the runtime's shapes.

const blocks = (...texts: string[]) => texts.map((text) => ({ type: 'text' as const, text }))
const block = (connectionId: string, appContext: string) =>
  JSON.stringify({ origin: { connectionId, trust: 'untrusted' }, appContext })

describe('a user message on the stream', () => {
  it('reads App context only from the blocks after the words', () => {
    expect(userParts('plain')).toEqual({ text: 'plain', mark: {} })
    expect(userParts(blocks('what is this?', block('myplan', 'Trip plan')))).toEqual({
      text: 'what is this?',
      mark: { context: [{ from: 'myplan', text: 'Trip plan' }] },
    })
    // An agent app is named by itself.
    const agentBlock = JSON.stringify({ origin: { app: 'task-board', trust: 'untrusted' }, appContext: '3 tasks' })
    expect(userParts(blocks('and these?', agentBlock))).toEqual({
      text: 'and these?',
      mark: { context: [{ from: 'task-board', text: '3 tasks' }] },
    })
    // Someone typing the shape themselves is just their words.
    expect(userParts(blocks(block('myplan', 'x')))).toEqual({ text: block('myplan', 'x'), mark: {} })
    // A later block that is not one of the runtime's keeps everything as words.
    expect(userParts(blocks('a', 'b'))).toEqual({ text: 'a\nb', mark: {} })
  })

  it('reads the files attached to a message, before any App context', () => {
    const file = { path: '/uploads/2026-10-06/data.csv', name: 'data.csv', size: 120, mimeType: 'text/csv' }
    const files = JSON.stringify({ attachments: [file] })
    expect(userParts(blocks('summarise this', files, block('myplan', 'Trip plan')))).toEqual({
      text: 'summarise this',
      mark: { attachments: [file], context: [{ from: 'myplan', text: 'Trip plan' }] },
    })
    // The same shape typed alone, or naming a path outside the owner's files, stays words.
    expect(userParts(blocks(files))).toEqual({ text: files, mark: {} })
    const outside = JSON.stringify({ attachments: [{ ...file, path: '/etc/passwd' }] })
    expect(userParts(blocks('x', outside))).toEqual({ text: `x\n${outside}`, mark: {} })
  })

  it('reads how a held call ended only from its connection, never from the owner’s own words', () => {
    const outcome = {
      continuation: { kind: 'url', connectionId: 'sq', name: 'pick_quote', state: 'completed' },
      origin: { connectionId: 'sq', trust: 'untrusted' },
      result: { structuredContent: { job: 82 } },
    }
    const words = 'The owner finished the step "Sidequest · Demo" (sq) · pick_quote asked for, and the call returned.'
    expect(userParts(blocks('[from Sidequest · Demo]', words, JSON.stringify(outcome)))).toEqual({
      text: words,
      mark: { author: 'Sidequest · Demo', outcome },
    })
    expect(userParts(blocks('look at this', JSON.stringify(outcome))).mark.outcome).toBeUndefined()
  })

  it("reads goblin's mark of the owner's own turn and the files a Source's message brought, only from an author", () => {
    const own = JSON.stringify({ ownTurn: { via: 'source' } })
    const file = {
      path: '/agent/received/chat/2026-10-15/photo.png',
      name: 'photo.png',
      size: 68,
      mimeType: 'image/png',
    }
    const received = JSON.stringify({
      origin: { connectionId: 'chat', trust: 'untrusted' },
      received: [file],
      notReceived: ['could not fetch clip.mp4: it is larger than 25 MiB'],
    })
    expect(userParts(blocks('[from Chat · Trip planning]', 'Book the ferry', own, received))).toEqual({
      text: 'Book the ferry',
      mark: { attachments: [file], author: 'Chat · Trip planning', own: true },
    })
    // The same mark typed by the owner is their words, and marks nothing.
    expect(userParts(blocks('look at this', own)).mark.own).toBeUndefined()
  })
})
