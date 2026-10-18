import { describe, expect, it } from 'vitest'
import { sharedItems } from '../src/lib/channel-shared.ts'
import { sharedPages } from '../src/conversations/shared.ts'

describe('channel shared items', () => {
  it('parses Markdown URLs without unsafe schemes or previews, including balanced parentheses and reference links', () => {
    const items = sharedItems(
      [
        {
          id: '1:0',
          role: 'assistant',
          toolCalls: [],
          text: '[Guide](https://example.com/a_(b)) and [map][m]. ![Photo](https://example.com/photo.jpg) [unsafe](javascript:alert(1)) [credentials](https://user:pass@example.com/)\n\n[m]: https://example.com/map',
        },
      ],
      '30',
    )
    expect(items.map((item) => item.href).toSorted()).toEqual([
      'https://example.com/a_(b)',
      'https://example.com/map',
      'https://example.com/photo.jpg',
    ])
    expect(items.find((item) => item.name === 'Photo')?.kind).toBe('media')
  })
  it('collects owner files, shared app context, and materialized MCP files with stable message origins', () => {
    const file = { path: '/uploads/guide.pdf', name: 'Guide.pdf', mimeType: 'application/pdf', size: 200 }
    const items = sharedItems(
      [
        {
          id: '1:0',
          role: 'user',
          text: 'My guide',
          attachments: [file],
          context: [{ from: 'maps', text: 'https://example.com/map' }],
        },
        {
          id: '2:0',
          role: 'tool',
          text: '',
          toolCallId: 'call',
          toolName: 'mcp_call',
          isError: false,
          details: {
            origin: { connectionId: 'notes', trust: 'untrusted' },
            content: [],
            received: [{ ...file, path: '/agent/received/photo.png', name: 'Photo.png', mimeType: 'image/png' }],
          },
        },
      ],
      '30',
    )
    expect(items.map((item) => item.kind)).toEqual(['file', 'link', 'media'])
    expect(items.every((item) => item.conversation === '30')).toBe(true)
    expect(items[0]?.href).toBe('/api/files/content?path=%2Fuploads%2Fguide.pdf')
  })
  it('applies later omission edits across history pages and retains moved entries in their thread', () => {
    const entry = { id: 10, kind: 'pi.user', model: [{ role: 'user', content: 'https://example.com/guide' }] }
    const moved = sharedPages([
      { chat: '30', entries: [{ id: 20, kind: 'app.thread_head', edits: [{ action: 'omit', target: 10 }] }] },
      { chat: '30', entries: [entry] },
      { chat: '31', entries: [entry] },
    ])
    expect(moved).toHaveLength(1)
    expect(moved[0]?.conversation).toBe('31')
    expect(
      sharedPages([
        { chat: '30', entries: [entry] },
        { chat: '31', entries: [entry] },
      ]),
    ).toHaveLength(1)
  })
})
