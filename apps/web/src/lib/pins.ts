// The owner's pins as the sidebar and Apps show them (ADRs 0053, 0078): every stored pin, in the owner's order, with
// whether it opens now. A pin that does not open keeps its place and offers its way back; nothing here removes one.
// Pure.
import {
  type AppView,
  type ServerView,
  type SidebarOperation,
  type SidebarPin,
  type SidebarPins,
  type SidebarTarget,
  pinKey,
} from '@goblin/contracts'

/**
 * Whether a pin opens now: `ready`; `loading` while its server's state is not read yet; `signed-out` (reconnect, or
 * unpin); `no-app` when its server declares no App now; `closed` when its view was closed (opening it opens it again);
 * `gone` when what it named is not there.
 */
export type PinState = 'ready' | 'loading' | 'signed-out' | 'no-app' | 'closed' | 'gone'

/** A pinned row: a server's own App, or one App view, under its name and with its state. */
export type ShownPin =
  | { readonly kind: 'server'; readonly connectionId: string; readonly title: string; readonly state: PinState }
  | {
      readonly kind: 'view'
      readonly appId: string
      readonly title: string
      readonly app: AppView | undefined
      readonly state: PinState
    }

/** A pin's target: what an unpin or a move names. */
export const targetOf = (pin: ShownPin | SidebarPin): SidebarTarget =>
  pin.kind === 'server' ? { kind: 'server', connectionId: pin.connectionId } : { kind: 'view', appId: pin.appId }

/** A server pin's row: its title once its server is read, and whether its own App opens now. */
function serverRow(connectionId: string, servers: readonly ServerView[] | undefined): ShownPin {
  if (servers === undefined) return { kind: 'server', connectionId, title: connectionId, state: 'loading' }
  const server = servers.find((each) => each.connectionId === connectionId)
  if (server === undefined) return { kind: 'server', connectionId, title: connectionId, state: 'gone' }
  const title = server.title ?? server.label
  const state = server.entrypoint === undefined ? 'no-app' : server.status === 'connected' ? 'ready' : 'signed-out'
  return { kind: 'server', connectionId, title, state }
}

/**
 * Every stored pin in the owner's order, each with its state. `servers` is undefined until the servers are read: a
 * read not made yet, or one that failed, never hides a pin.
 */
export function pinnedRows(
  stored: SidebarPins,
  servers: readonly ServerView[] | undefined,
  apps: readonly AppView[],
): readonly ShownPin[] {
  const kept = new Map(apps.map((app) => [app.id, app]))
  return stored.pins.map((pin): ShownPin => {
    if (pin.kind === 'server') return serverRow(pin.connectionId, servers)
    const app = kept.get(pin.appId)
    const state = app === undefined ? 'gone' : app.closedAt === undefined ? 'ready' : 'closed'
    return { kind: 'view', appId: pin.appId, title: pin.title, app, state }
  })
}

/** The operation that moves `target` one place up (`-1`) or down (`1`) among the pins. Undefined at either end. */
export function moveOperation(stored: SidebarPins, target: SidebarTarget, step: -1 | 1): SidebarOperation | undefined {
  const at = stored.pins.findIndex((pin) => pinKey(pin) === pinKey(target))
  if (at === -1 || stored.pins[at + step] === undefined) return undefined
  return { kind: 'move', target, index: at + step }
}

/** What pinning an App pins: a server's own App pins its server; any other App, that one view under `name`. */
export const appPin = (app: AppView, name: string): SidebarPin =>
  app.source.kind === 'mcp' && app.source.entrypoint === true
    ? { kind: 'server', connectionId: app.source.connectionId }
    : { kind: 'view', appId: app.id, title: name.slice(0, 120) || 'App' }
