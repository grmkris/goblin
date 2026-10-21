import { afterEach, describe, expect, it, vi } from 'vitest'
import { apiPath, inWorkspace, workspaceKey, workspaceOf, workspaceRewrite } from '../src/lib/workspace-path.ts'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The page this test is on, as the browser has it. */
const onPage = (path: string) => vi.stubGlobal('window', { location: new URL(`https://goblin.test${path}`) })

const url = (path: string) => new URL(`https://goblin.test${path}`)
const pathOf = (rewritten: string | URL | undefined) =>
  rewritten === undefined ? undefined : new URL(rewritten).pathname + new URL(rewritten).search

describe("a page's workspace (ADR 0089)", () => {
  it('reads the workspace and the page within it from the address, and puts them back together', () => {
    expect(workspaceOf('/w/kris/c/12')).toEqual({ slug: 'kris', path: '/c/12' })
    expect(workspaceOf('/w/swarmm-dev-zy98')).toEqual({ slug: 'swarmm-dev-zy98', path: '/' })
    expect(workspaceOf('/w/kris/')).toEqual({ slug: 'kris', path: '/' })
    for (const outside of ['/', '/login', '/c/12', '/w/', '/w/Kris/c/1', '/wx/kris'])
      expect(workspaceOf(outside)).toBeUndefined()
    expect(inWorkspace('kris')).toBe('/w/kris/')
    expect(inWorkspace('kris', '/start/welcome')).toBe('/w/kris/start/welcome')
  })

  it('shows the router a page without its prefix and builds every address of that workspace with it', () => {
    const rewrite = workspaceRewrite()
    expect(pathOf(rewrite.input?.({ url: url('/w/kris/c/12?thread=4') }))).toBe('/c/12?thread=4')
    expect(pathOf(rewrite.output?.({ url: url('/c/7') }))).toBe('/w/kris/c/7')
    expect(pathOf(rewrite.output?.({ url: url('/') }))).toBe('/w/kris/')
    // A person's own pages are no workspace's.
    for (const page of ['/login', '/consent', '/consent/workspace', '/terms', '/privacy'])
      expect(rewrite.output?.({ url: url(page) })).toBeUndefined()
    // Outside any workspace nothing is added, and nothing is taken off.
    expect(rewrite.input?.({ url: url('/login') })).toBeUndefined()
    expect(rewrite.output?.({ url: url('/c/7') })).toBeUndefined()
  })

  it("puts a workspace's API calls and stored conveniences under it, and a person's page's under none", () => {
    onPage('/w/kris/settings')
    expect(apiPath('/api/topics')).toBe('/w/kris/api/topics')
    expect(workspaceKey('last-channel')).toBe('goblin:kris:last-channel')
    onPage('/login')
    expect(apiPath('/api/workspaces')).toBe('/api/workspaces')
    expect(workspaceKey('last-channel')).toBe('goblin:last-channel')
  })
})
