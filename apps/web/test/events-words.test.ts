import { describe, expect, it } from 'vitest'
import { eventTitle, eventWords } from '../src/lib/events.ts'

describe("an event's name for the owner (ADR 0068)", () => {
  it("is the server's title when it gives one, else every part of its name in words", () => {
    expect(eventTitle({ name: 'notes.post.created', title: 'New post' })).toBe('New post')
    expect(eventTitle({ name: 'post.created' })).toBe('Post created')
    expect(eventWords('notes.post.created')).toBe('Notes post created')
    expect(eventWords('fileChanged')).toBe('File changed')
    expect(eventWords('...')).toBe('...')
  })
})
