import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { JumpToButton, JumpToProvider } from '../src/components/shell/jump-to.tsx'

// The open switcher (focus, the arrow keys, Enter and Escape) is checked in Chromium by test/ui-jump.ts.
describe('Jump to in the shell', () => {
  it('renders the sidebar row closed, leaving the shortcut for the browser to name', () => {
    const markup = renderToString(
      <JumpToProvider>
        <JumpToButton />
      </JumpToProvider>,
    )
    expect(markup).toContain('Jump to…')
    expect(markup).toContain('aria-haspopup="dialog"')
    // The server cannot know ⌘ from Ctrl: the hint and its aria-keyshortcuts come once the page runs, never mismatched.
    expect(markup).not.toContain('<kbd')
    expect(markup).not.toContain('aria-keyshortcuts')
    expect(markup).not.toContain('role="dialog"')
  })

  it('opens only inside its provider', () => {
    expect(() => renderToString(<JumpToButton />)).toThrow('outside JumpToProvider')
  })
})
