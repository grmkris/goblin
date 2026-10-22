import { Button } from '@goblin/ui'
import { AuthShell } from './auth-shell.tsx'

/**
 * Where a browser lands whose person is not a member of the workspace an outbound sign-in belongs to (ADR 0096): the
 * edge refused the sign-in, so its code reached no agent, and this page says how to finish it without naming the
 * workspace.
 */
export function SignInElsewhere() {
  return (
    <AuthShell
      title="This sign-in belongs to another workspace"
      description="This sign-in belongs to a workspace your account isn't in. Finish it signed in as an admin of that workspace."
    >
      <div className="auth-body">
        <Button onClick={() => window.location.assign('/')}>Open your workspace</Button>
      </div>
    </AuthShell>
  )
}
