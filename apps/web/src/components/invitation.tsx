import { useMutation, useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { NotFound } from '@goblin/contracts/api'
import type { InvitationPreview } from '@goblin/contracts'
import { acceptInvitationMutation, declineInvitationMutation, invitationQuery } from '../account/queries.ts'
import { useSession } from '../auth/hooks.ts'
import { sessionPersonQuery, signOutMutation } from '../auth/queries.ts'
import { ROLE_PHRASE } from '../lib/labels.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { inWorkspace } from '../lib/workspace-path.ts'
import { AuthShell } from './auth-shell.tsx'
import { Authentication } from './authentication.tsx'
import { invitationRefusal } from './invitation-refusal.ts'

const ENDED: Readonly<Record<Exclude<InvitationPreview['state'], 'pending'>, string>> = {
  accepted: 'This invitation was already taken.',
  declined: 'This invitation was turned down.',
  canceled: 'This invitation was withdrawn.',
  expired: 'This invitation has expired. Ask for a new one.',
}

/** What to do with a waiting invitation once signed in: join or turn it down, as the address it is for. */
function Decide({ invitation }: { readonly invitation: InvitationPreview }) {
  const me = useQuery(sessionPersonQuery).data
  const accept = useMutation(acceptInvitationMutation)
  const decline = useMutation(declineInvitationMutation)
  const signOut = useMutation(signOutMutation)
  const failure = accept.error ?? decline.error
  if (me === undefined) return <Skeleton className="h-10" />
  if (me !== null && me.email.toLowerCase() !== invitation.email.toLowerCase())
    return (
      <div className="flex flex-col gap-3">
        <Alert>
          <AlertDescription>
            This invitation is for {invitation.email}, and you are signed in as {me.email}. Sign out, then sign in as{' '}
            {invitation.email} to join.
          </AlertDescription>
        </Alert>
        <div>
          <Button
            variant="outline"
            pending={signOut.isPending}
            onClick={() => signOut.mutate(undefined, { onSettled: () => window.location.reload() })}
          >
            Sign out
          </Button>
        </div>
      </div>
    )
  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <Button
          pending={accept.isPending || accept.isSuccess}
          disabled={decline.isPending}
          onClick={() =>
            accept.mutate(invitation.id, { onSuccess: (joined) => window.location.assign(inWorkspace(joined.slug)) })
          }
        >
          Join {invitation.workspace}
        </Button>
        <Button
          variant="ghost"
          pending={decline.isPending}
          disabled={accept.isPending}
          onClick={() => decline.mutate(invitation.id, { onSuccess: () => window.location.assign('/') })}
        >
          No thanks
        </Button>
      </div>
      {failure !== null && (
        <Alert variant="destructive">
          <AlertDescription>{invitationRefusal(failure, invitation)}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}

/**
 * An invitation's link (`/invite/<id>`, ADR 0093): who invited whom to which workspace, then signing in as that
 * address (an invitation lets it sign up whatever the sign-up mode) and joining or turning it down.
 */
export function Invitation({ id }: { readonly id: string }) {
  const preview = useQuery(invitationQuery(id))
  const session = useSession()
  const invitation = preview.data
  if (preview.isError)
    return (
      <AuthShell title="This invitation is not valid" description="Its link may be incomplete or mistyped.">
        <div className="auth-body">
          <Alert variant="destructive">
            <AlertDescription>
              {preview.error instanceof NotFound
                ? 'There is no invitation at this address.'
                : messageOf(preview.error, 'read the invitation')}
            </AlertDescription>
          </Alert>
        </div>
      </AuthShell>
    )
  if (invitation === undefined) return <Skeleton className="m-8 h-40" />
  const role = ROLE_PHRASE[invitation.role]
  return (
    <AuthShell
      title={`${invitation.invitedBy} invited you to ${invitation.workspace}`}
      description={`As ${role}, for ${invitation.email}. Everyone in a workspace works with the same agent, its channels and its connections.`}
    >
      <div className="auth-body">
        {invitation.state !== 'pending' ? (
          <Alert>
            <AlertDescription>{ENDED[invitation.state]}</AlertDescription>
          </Alert>
        ) : session.state === 'signed-in' ? (
          <Decide invitation={invitation} />
        ) : session.state === 'signed-out' ? (
          <div className="flex flex-col gap-3">
            <p>Sign in with {invitation.email} to join.</p>
            <Authentication onAuthenticated={session.signedIn} />
          </div>
        ) : (
          <Skeleton className="h-10" />
        )}
      </div>
    </AuthShell>
  )
}
