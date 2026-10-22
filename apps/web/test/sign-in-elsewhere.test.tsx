import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SignInElsewhere } from '../src/components/sign-in-elsewhere.tsx'
import { workspaceRewrite } from '../src/lib/workspace-path.ts'

describe('a sign-in that belongs to another workspace (ADR 0096)', () => {
  it('says how to finish it without naming the workspace, on a page outside any workspace', () => {
    const markup = renderToString(<SignInElsewhere />)
    expect(markup).toContain('This sign-in belongs to a workspace your account isn&#x27;t in.')
    expect(markup).toContain('Finish it signed in as an admin of that workspace.')
    expect(markup).not.toMatch(/\/w\//u)
    const rewrite = workspaceRewrite()
    rewrite.input?.({ url: new URL('https://goblin.test/w/kris/c/1') })
    expect(rewrite.output?.({ url: new URL('https://goblin.test/connect-elsewhere') })).toBeUndefined()
  })
})
