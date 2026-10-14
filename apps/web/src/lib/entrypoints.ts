import type { ServerView } from '@goblin/contracts'

/** A connected server with a global entrypoint, as the sidebar lists it: where it opens and what it is called. */
export type Entrypoint = { readonly connectionId: string; readonly title: string }

/**
 * The connections whose App the owner opens on its own, from anywhere: connected, with a tool declared as its global
 * entrypoint. Each is labelled with its title, then its label.
 */
export function entrypoints(servers: readonly ServerView[]): readonly Entrypoint[] {
  return servers
    .filter((server) => server.status === 'connected' && server.entrypoint !== undefined)
    .map((server) => ({
      connectionId: server.connectionId,
      title: server.title ?? server.label,
    }))
}
