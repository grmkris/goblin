import { useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { workspacesQuery } from '../account/queries.ts'
import { lastWorkspace } from '../lib/last-workspace.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { inWorkspace } from '../lib/workspace-path.ts'

/**
 * A signed-in person's home (`/`, ADR 0089): it opens the workspace this browser opened last, or their first (a person
 * with none is given one by the list). `welcome` opens it on Start's first step, for an account just made.
 */
export function OpenWorkspace({ welcome }: { readonly welcome: boolean }) {
  const workspaces = useQuery(workspacesQuery)
  const listed = workspaces.data
  useEffect(() => {
    if (listed === undefined) return
    const last = lastWorkspace()
    const target = listed.find((workspace) => workspace.slug === last) ?? listed[0]
    if (target !== undefined) window.location.replace(inWorkspace(target.slug, welcome ? '/start/welcome' : '/'))
  }, [listed, welcome])
  if (workspaces.isError)
    return (
      <div className="gate-status">
        <Alert variant="destructive">
          <AlertDescription>{messageOf(workspaces.error, 'open your workspace')}</AlertDescription>
        </Alert>
        <div className="card-actions">
          <Button variant="outline" onClick={() => void workspaces.refetch()}>
            Try again
          </Button>
        </div>
      </div>
    )
  return (
    <p role="status" className="gate-status">
      Opening your workspace…
    </p>
  )
}
