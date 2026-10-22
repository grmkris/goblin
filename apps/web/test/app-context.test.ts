import { describe, expect, it } from 'vitest'
import { contextPreview, contextText, safeLink } from '../src/lib/app-context.ts'

describe('what an App shares', () => {
  it('takes the App’s text, else its structured content, bounded to 8 KB', () => {
    expect(
      contextText(
        [
          { type: 'text', text: ' Trip plan ' },
          { type: 'image', data: 'x' },
        ],
        { a: 1 },
      ),
    ).toBe('Trip plan')
    expect(contextText([], { note: 'n1' })).toBe('{"note":"n1"}')
    expect(contextText(undefined, undefined)).toBe('')
    expect(contextText([{ type: 'text', text: 'x'.repeat(9000) }], undefined)).toHaveLength(8192)
  })
  it('offers only https links without credentials', () => {
    expect(safeLink('https://myplan.lol/n/1')?.href).toBe('https://myplan.lol/n/1')
    expect(safeLink('http://myplan.lol')).toBeUndefined()
    expect(safeLink('javascript:alert(1)')).toBeUndefined()
    expect(safeLink('https://user:pass@example.com')).toBeUndefined()
    expect(safeLink('not a url')).toBeUndefined()
  })
  it('previews the first line', () => {
    expect(contextPreview('\n  Trip plan\nmore')).toBe('Trip plan')
    expect(contextPreview('x'.repeat(80))).toHaveLength(60)
  })
})
