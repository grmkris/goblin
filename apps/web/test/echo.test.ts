import { describe, expect, it } from 'vitest'
import { delivered, startsTurn } from '../src/lib/echo.ts'
import { said, snapshot } from './agui-fixtures.ts'

/** A member's message in a workspace of several people (ADR 0094). */
const saidBy = (entry: number, member: string) => said(entry, 'words', { member: { name: member, userId: member } })

describe('the echo of a sent message', () => {
  it('reads the newest entry, which a message sent now comes after', () => {
    expect(snapshot([]).newestEntry).toBe(0)
    expect(snapshot([said(3, 'a'), said(9, 'b'), said(5, 'c')]).newestEntry).toBe(9)
  })
  it('starts a turn only when nothing runs and nothing waits; otherwise the send queues', () => {
    expect(startsTurn(snapshot([]))).toBe(true)
    expect(startsTurn(snapshot([], { running: true }))).toBe(false)
    expect(startsTurn(snapshot([], { queue: [{ id: 4, mode: 'followUp', text: 'later' }] }))).toBe(false)
  })
  it('is delivered by the owner’s first message after the entry it was sent behind, whatever its words', () => {
    const echo = { id: 'echo:op', text: 'hello', after: 2 }
    const none = snapshot([said(1, 'old'), said(2, 'older')]).messages
    expect(delivered(echo, none)).toBeUndefined()
    const landed = snapshot([said(1, 'old'), said(2, 'older'), said(3, 'hello there')]).messages
    expect(delivered(echo, landed)).toMatchObject({ id: '3:0' })
  })
  it("waits for its sender's own message, never another member's (ADR 0094)", () => {
    const echo = { id: 'echo:op', text: 'hello', after: 0, by: 'u-kris' }
    expect(delivered(echo, snapshot([saidBy(1, 'u-ana')]).messages)).toBeUndefined()
    expect(delivered(echo, snapshot([saidBy(1, 'u-ana'), saidBy(2, 'u-kris')]).messages)).toMatchObject({ id: '2:0' })
  })
  it('is not delivered by a message another author wrote', () => {
    const echo = { id: 'echo:op', text: 'hello', after: 0 }
    expect(delivered(echo, snapshot([said(1, 'note', { author: 'mcp' })]).messages)).toBeUndefined()
  })
})
