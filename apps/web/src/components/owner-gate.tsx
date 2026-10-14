import type { ReactNode } from 'react'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { useSession } from '../auth/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { Authentication } from './authentication.tsx'

/** The session could not be checked: say so, with the reference to quote, and offer to check again. */
function SessionUnavailable({ error, onRetry }: { readonly error: unknown; readonly onRetry: () => void }) {
  return (
    <div className="gate-status">
      <Alert variant="destructive">
        <AlertDescription>{messageOf(error, 'check whether you are signed in')}</AlertDescription>
      </Alert>
      <div className="card-actions">
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  )
}

/**
 * Renders `children` for the signed-in owner, the sign-in form otherwise. `pending` is what shows while the session is
 * checked (first-run Start shows goblin's splash there).
 */
export function OwnerGate({ children, pending }: { readonly children: ReactNode; readonly pending?: ReactNode }) {
  const session = useSession()
  const { state } = session
  if (state === 'checking')
    return (
      pending ?? (
        <p role="status" className="gate-status">
          Opening your workspace…
        </p>
      )
    )
  if (state === 'unavailable') return <SessionUnavailable error={session.error} onRetry={session.recheck} />
  if (state === 'signed-out') return <Authentication onAuthenticated={session.signedIn} />
  return children
}
