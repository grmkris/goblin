import { InvalidInput, NotFound } from '../http/errors.ts'
import type { ReachedWorkspace } from '../auth/workspaces.ts'
import type { CallerReach } from './mcp-server.ts'

/** The workspace a client's call is for: the one it names, by id or slug, or its only one when it names none. */
export const workspaceFor = <W extends ReachedWorkspace>(reach: CallerReach<W>, named: string | undefined): W => {
  const [only] = reach.workspaces
  if (named === undefined) {
    if (reach.named || only === undefined) throw new InvalidInput({ reason: 'workspace' })
    return only
  }
  // An id first: a slug is its admins' to choose, so one may look like another workspace's id.
  const chosen =
    reach.workspaces.find((workspace) => workspace.id === named) ??
    reach.workspaces.find((workspace) => workspace.slug === named)
  if (chosen === undefined) throw new NotFound({ what: 'workspace' })
  return chosen
}
