import { QueryClientProvider } from '@tanstack/react-query'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { type PersonaInvocationView, type PersonaView, NOTHING } from '@goblin/contracts'
import { Answering } from '../src/components/shell/answering.tsx'
import type { LiveChild } from '../src/lib/agui/reducer.ts'
import { workspaceQueries } from '../src/lib/workspace/sync.ts'
import { testQueryClient } from './query/testing.ts'

const persona = (id: number, name: string): PersonaView => ({
  id,
  name,
  avatar: { glyph: name.slice(0, 1), hue: 40 },
  role: '',
  instructions: '',
  setup: NOTHING,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
})

const invocation = (asked: number, state: PersonaInvocationView['state'], order: number): PersonaInvocationView => ({
  operationId: 'op',
  persona: asked,
  revision: 1,
  chat: '1',
  order,
  state,
  createdAt: 1,
})

/** The rows after a chat's transcript, with the workspace feed's invocations and the stream's children. */
function rows(working: readonly LiveChild[], invocations: readonly PersonaInvocationView[]): string {
  const client = testQueryClient()
  client.setQueryData(workspaceQueries.personas.queryKey, [persona(1, 'Ada'), persona(2, 'Bo')])
  client.setQueryData(workspaceQueries.invocations.queryKey, invocations)
  return renderToString(
    <QueryClientProvider client={client}>
      <Answering chat="1" working={working} />
    </QueryClientProvider>,
  )
}

describe('who still works in a chat', () => {
  it('reads who works from the stream and who waits its turn from the feed', () => {
    const markup = rows(
      [
        { id: '9', name: 'Ada', persona: { id: 1, avatar: { glyph: 'A', hue: 40 } }, partial: 'Half an' },
        { id: '12', name: 'scout', partial: '' },
      ],
      [invocation(1, 'running', 0), invocation(2, 'pending', 1)],
    )
    expect(markup.match(/answering-row/gu)).toHaveLength(3)
    expect(markup).toMatch(/<b>Ada<\/b><span data-state="running">answering…/u)
    expect(markup).toMatch(/<b>scout<\/b><span data-state="running">working…/u)
    expect(markup).toMatch(/<b>Bo<\/b><span data-state="pending">waiting…/u)
    // What a child's answer says so far stays out of the row, as the row never showed it.
    expect(markup).not.toContain('Half an')
  })

  it('shows nothing once nobody works or waits', () => {
    expect(rows([], [invocation(1, 'answered', 0)])).toBe('')
  })
})
