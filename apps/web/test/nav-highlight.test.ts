import { describe, expect, it } from 'vitest'
import type { AppView } from '@goblin/contracts'
import { type NavFacts, highlightOf } from '../src/lib/nav-highlight.ts'

const view = (id: string, server: { readonly connectionId?: string; readonly entrypoint?: boolean } = {}): AppView => ({
  id,
  conversation: '20',
  title: 'Board',
  createdAt: 1,
  source: { kind: 'mcp', callId: `call-${id}`, connectionId: 'plan', tool: 'board', uri: 'ui://plan/board', ...server },
})

const facts = (pins: readonly string[] = [], apps: readonly AppView[] = []): NavFacts => ({
  pins: new Set(pins),
  apps,
  // Chat 1 and 2 are channels; 20 and 21 are threads of channel 1.
  channelOf: (chat) => (chat === '20' || chat === '21' ? '1' : chat),
})

describe('the sidebar’s one highlighted row (ADR 0078)', () => {
  it('marks a channel, or the thread its panel shows, as the page', () => {
    expect(highlightOf({ path: '/c/1' }, facts())).toEqual({ row: 'topic:1', current: 'page' })
    expect(highlightOf({ path: '/c/1', thread: 20 }, facts())).toEqual({ row: 'thread:20', current: 'page' })
    expect(highlightOf({ path: '/c/21' }, facts())).toEqual({ row: 'thread:21', current: 'page' })
  })

  it('marks an App’s page by its pin, else Apps as holding it, and never its Topic', () => {
    expect(highlightOf({ path: '/a/7' }, facts(['view:7']))).toEqual({ row: 'pin:view:7', current: 'page' })
    const own = view('8', { connectionId: 'notes', entrypoint: true })
    expect(highlightOf({ path: '/a/8' }, facts(['server:notes'], [own]))).toEqual({
      row: 'pin:server:notes',
      current: 'page',
    })
    expect(highlightOf({ path: '/a/9' }, facts([], [view('9')]))).toEqual({ row: 'apps', current: 'true' })
    expect(highlightOf({ path: '/connections/notes/app' }, facts(['server:notes']))).toEqual({
      row: 'pin:server:notes',
      current: 'page',
    })
    expect(highlightOf({ path: '/connections/notes/app' }, facts())).toEqual({ row: 'apps', current: 'true' })
  })

  it('marks a place as the page on its own path and as holding the pages under it', () => {
    expect(highlightOf({ path: '/apps' }, facts())).toEqual({ row: 'apps', current: 'page' })
    expect(highlightOf({ path: '/apps/tracker' }, facts())).toEqual({ row: 'apps', current: 'true' })
    expect(highlightOf({ path: '/work' }, facts())).toEqual({ row: 'work', current: 'page' })
    expect(highlightOf({ path: '/threads' }, facts())).toEqual({ row: 'threads', current: 'page' })
    expect(highlightOf({ path: '/personas' }, facts())).toEqual({ row: 'personas', current: 'page' })
    expect(highlightOf({ path: '/p/3' }, facts())).toEqual({ row: 'personas', current: 'true' })
    expect(highlightOf({ path: '/p/new' }, facts())).toEqual({ row: 'personas', current: 'true' })
    expect(highlightOf({ path: '/connections' }, facts())).toEqual({ row: 'connections', current: 'page' })
  })

  it('marks nothing for a page outside the sidebar’s places', () => {
    expect(highlightOf({ path: '/consent' }, facts())).toBeUndefined()
    expect(highlightOf({ path: '/' }, facts())).toBeUndefined()
  })
})
