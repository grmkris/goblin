import { describe, expect, it } from 'vitest'
import type { ToolView } from '@goblin/contracts'
import { suggestedApplied } from '../src/components/tool-grants.tsx'

/** A tool as Connections lists it, with what goblin suggests for it. */
const tool = (name: string, suggested: 'run' | 'ask', granted: boolean, askFirst = false): ToolView => ({
  name,
  suggested,
  granted,
  askFirst,
  modelVisible: true,
})

describe('whether suggested access is in place (ADR 0060)', () => {
  it('needs every visible tool allowed and each one suggested to ask asking first', () => {
    expect(suggestedApplied([tool('search', 'run', true), tool('write', 'ask', true, true)])).toBe(true)
    expect(suggestedApplied([tool('search', 'run', false), tool('write', 'ask', true, true)])).toBe(false)
    expect(suggestedApplied([tool('search', 'run', true), tool('write', 'ask', true)])).toBe(false)
  })

  it("counts the owner's own ask-first on a read-only tool as in place, and ignores App-only tools", () => {
    const appOnly = { ...tool('view', 'ask', false), modelVisible: false }
    expect(suggestedApplied([tool('search', 'run', true, true), appOnly])).toBe(true)
  })
})
