import { useMutation, useQuery } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { createWorkspaceMutation, myInvitationsQuery, workspacesQuery } from '../account/queries.ts'
import { sessionPersonQuery } from '../auth/queries.ts'
import { AuthShell } from './auth-shell.tsx'
import { lastWorkspace } from '../lib/last-workspace.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { inWorkspace } from '../lib/workspace-path.ts'

/** A slug for a person's own first workspace, from their address, with a random ending against a taken one. */
const ownSlug = (email: string): string => {
  const base = (email.split('@')[0] ?? '')
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
    .slice(0, 30)
  return `${base.length >= 3 ? base : 'my-ws'}-${crypto.randomUUID().slice(0, 4)}`
}

/**
 * A person with no workspace and invitations waiting (ADR 0093): join one, or start their own instead. The list gives
 * no first workspace while one waits, so joining adds no empty one of theirs.
 */
function Invited() {
  const invitations = useQuery(myInvitationsQuery)
  const me = useQuery(sessionPersonQuery).data
  const create = useMutation(createWorkspaceMutation)
  return (
    <AuthShell title="You have been invited" description="Join a workspace, or start your own.">
      <div className="auth-body flex flex-col gap-2">
        {(invitations.data ?? []).map((invitation) => (
          <Button
            key={invitation.id}
            className="justify-start"
            onClick={() => window.location.assign(`/invite/${invitation.id}`)}
          >
            {invitation.workspace}, from {invitation.invitedBy}
          </Button>
        ))}
        {me !== null && me !== undefined && (
          <Button
            variant="outline"
            className="justify-start"
            pending={create.isPending || create.isSuccess}
            onClick={() =>
              create.mutate(
                {
                  name: `${me.name.trim() === '' ? (me.email.split('@')[0] ?? 'My') : me.name.trim()}'s workspace`,
                  slug: ownSlug(me.email),
                },
                { onSuccess: (made) => window.location.assign(inWorkspace(made.slug, '/start/welcome')) },
              )
            }
          >
            Start my own workspace
          </Button>
        )}
        {create.error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{messageOf(create.error, 'start your workspace')}</AlertDescription>
          </Alert>
        )}
      </div>
    </AuthShell>
  )
}

/**
 * A signed-in person's home (`/`, ADR 0089): it opens the workspace this browser opened last, or their first (a person
 * with none is given one by the list, unless invitations wait for them). `welcome` opens it on Start's first step,
 * for an account just made.
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
  if (listed !== undefined && listed.length === 0) return <Invited />
  return (
    <p role="status" className="gate-status">
      Opening your workspace…
    </p>
  )
}
