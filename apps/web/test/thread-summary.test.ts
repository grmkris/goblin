import type { ConversationView } from '@goblin/contracts'
import { describe, expect, it } from 'vitest'
import { summaryText } from '../src/components/shell/thread-summary.tsx'

const NOW = 10_000
const thread = (extra: Partial<ConversationView> = {}): ConversationView => ({
  id: '7',
  kind: 'thread',
  parent: '1',
  title: 'Job 1',
  keepOpen: false,
  replies: 0,
  createdAt: 1,
  ...extra,
})

describe("a thread's summary (ADR 0090)", () => {
  it("names a channel card's thread always, its last reply and closing beside the name", () => {
    expect(summaryText(thread(), NOW, true)).toEqual({ title: 'Job 1', meta: '' })
    expect(summaryText(thread({ replies: 7, lastReplyAt: NOW - 660 }), NOW, true)).toEqual({
      title: 'Job 1',
      meta: 'Last reply 11 minutes ago',
    })
    expect(summaryText(thread({ replies: 7, lastReplyAt: NOW - 660, closedAt: NOW }), NOW, true)).toEqual({
      title: 'Job 1',
      meta: 'Last reply 11 minutes ago · closed',
    })
  })

  it('keeps a summary under a message as it was: its name only until anyone replied', () => {
    expect(summaryText(thread(), NOW, false)).toEqual({ meta: 'Job 1' })
    expect(summaryText(thread({ replies: 2, lastReplyAt: NOW - 60 }), NOW, false)).toEqual({
      meta: 'Last reply 1 minute ago',
    })
  })
})
