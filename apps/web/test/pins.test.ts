import { describe, expect, it } from 'vitest'
import type { AppView, ServerView, SidebarPins } from '@goblin/contracts'
import { type ShownPin, appPin, moveOperation, pinnedRows } from '../src/lib/pins.ts'

const server = (connectionId: string, overrides: Partial<ServerView> = {}): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status: 'connected',
  live: true,
  source: 'config',
  entrypoint: 'open',
  ...overrides,
})

const app = (id: string, overrides: Partial<AppView> = {}): AppView => ({
  id,
  conversation: '1',
  title: 'Board',
  createdAt: Number(id),
  source: { kind: 'mcp', callId: `call-${id}`, connectionId: 'plan', tool: 'board', uri: 'ui://plan/board' },
  ...overrides,
})

const pins = (overrides: Partial<SidebarPins> = {}): SidebarPins => ({ revision: 3, pins: [], ...overrides })
const states = (rows: readonly ShownPin[]) =>
  rows.map((pin) => `${pin.kind === 'server' ? pin.connectionId : pin.appId}:${pin.state}`)

describe('the owner’s pins (ADRs 0053, 0078)', () => {
  it('shows every stored pin in the owner’s order and pins no server on its own', () => {
    const stored = pins({
      pins: [
        { kind: 'view', appId: '7', title: 'Trip board' },
        { kind: 'server', connectionId: 'notes' },
      ],
    })
    const rows = pinnedRows(stored, [server('notes', { title: 'Notes' }), server('tasks')], [app('7')])
    expect(states(rows)).toEqual(['7:ready', 'notes:ready'])
    expect(rows.map((pin) => pin.title)).toEqual(['Trip board', 'Notes'])
  })

  it('keeps a pin that does not open in its place, with why: signed out, no App, closed or gone', () => {
    const stored = pins({
      pins: [
        { kind: 'server', connectionId: 'notes' },
        { kind: 'server', connectionId: 'tools' },
        { kind: 'server', connectionId: 'removed' },
        { kind: 'view', appId: '8', title: 'Closed' },
        { kind: 'view', appId: '9', title: 'Gone' },
      ],
    })
    const servers = [server('notes', { status: 'needs_auth' }), server('tools', { entrypoint: undefined })]
    const rows = pinnedRows(stored, servers, [app('8', { closedAt: 5 })])
    expect(states(rows)).toEqual(['notes:signed-out', 'tools:no-app', 'removed:gone', '8:closed', '9:gone'])
  })

  it('shows a server pin by its id while the servers are not read, never hiding it', () => {
    const rows = pinnedRows(pins({ pins: [{ kind: 'server', connectionId: 'notes' }] }), undefined, [])
    expect(rows).toEqual([{ kind: 'server', connectionId: 'notes', title: 'notes', state: 'loading' }])
  })

  it('moves a pin one place among the stored pins, and not past either end', () => {
    const stored = pins({
      pins: [
        { kind: 'server', connectionId: 'a' },
        { kind: 'server', connectionId: 'b' },
      ],
    })
    expect(moveOperation(stored, { kind: 'server', connectionId: 'b' }, -1)).toEqual({
      kind: 'move',
      target: { kind: 'server', connectionId: 'b' },
      index: 0,
    })
    expect(moveOperation(stored, { kind: 'server', connectionId: 'a' }, -1)).toBeUndefined()
    expect(moveOperation(stored, { kind: 'server', connectionId: 'b' }, 1)).toBeUndefined()
  })

  it('pins a server’s own App as its server, any other App as its view', () => {
    const own = app('4', {
      source: { kind: 'mcp', callId: 'x', connectionId: 'notes', tool: 'open', uri: 'ui://w', entrypoint: true },
    })
    expect(appPin(own, 'Notes')).toEqual({ kind: 'server', connectionId: 'notes' })
    expect(appPin(app('5'), 'Board (2)')).toEqual({ kind: 'view', appId: '5', title: 'Board (2)' })
  })
})
