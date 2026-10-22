import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailsContent } from '../src/components/shell/message-details.tsx'
import type { DetailsView } from '../src/lib/details.ts'

const view: DetailsView = {
  outcome: { before: 'Answered in', ms: 4_000 },
  steps: [
    {
      key: 'a',
      state: 'done',
      lead: 'Thought',
      model: 'deepseek-v4.1-flash',
      ms: 2_000,
      offsetMs: 0,
      bar: { left: 0, width: 50 },
    },
    {
      key: 'b',
      state: 'error',
      lead: 'Used',
      server: 'mycut',
      tool: 'job_submit',
      ms: 400,
      offsetMs: 2_000,
      bar: { left: 50, width: 10 },
      problem: 'Remote MCP request failed (timeout).',
    },
  ],
  related: [{ operation: 'op-2', label: 'Started a thread', chat: '9' }],
  footer: '28.1K tokens on goblin’s model, thinking low, build 393c895.',
}

// The open drawer itself (its Base UI dialog, focus and the phone layout) is checked in Chromium by test/ui-channel.ts.
describe('the Details drawer body', () => {
  it("reads each step like the chat's tool rows, names a connection by its label, and has no status badges", () => {
    const markup = renderToString(<DetailsContent view={view} named={(id) => `${id} label`} onOpen={() => undefined} />)
    expect(markup).toContain('Thought')
    expect(markup).toContain('deepseek-v4.1-flash')
    expect(markup).toContain('mycut label')
    expect(markup).toContain(' · job_submit')
    expect(markup).toContain('Remote MCP request failed (timeout).')
    expect(markup).toContain('started 2.0 s in')
    expect(markup).toContain('Started a thread')
    expect(markup).toContain('>Open<')
    expect(markup).toContain('build 393c895')
    expect(markup).not.toContain('data-slot="badge"')
    expect(markup).not.toMatch(/>ok</u)
  })
})
