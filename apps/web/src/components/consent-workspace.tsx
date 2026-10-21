import { useMutation, useQuery } from '@tanstack/react-query'
import { useRouterState } from '@tanstack/react-router'
import { Alert, AlertDescription, Button, Skeleton } from '@goblin/ui'
import { selectWorkspaceMutation, workspacesQuery } from '../account/queries.ts'
import { AuthRefused, authCall, consentClientQuery } from '../auth/queries.ts'
import { authClient, redirectOf } from '../lib/auth-client.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { AuthShell } from './auth-shell.tsx'

/** Carries the sign-in on once its workspace is chosen: where Better Auth sends the browser next (the consent page). */
const continueSignIn = async (): Promise<string> => {
  const { data, ref } = await authCall((fetchOptions) =>
    authClient.$fetch('/oauth2/continue', { method: 'POST', body: { postLogin: true }, ...fetchOptions }),
  )
  const next = redirectOf(data)
  if (next === undefined) throw new AuthRefused({ status: 502, ref })
  return next
}

/**
 * An MCP client's sign-in, for a person in several workspaces (ADR 0089): which workspace the client is for. Its
 * consent and its tokens are that workspace's alone; connecting it to another means signing it in again.
 */
export function ConsentWorkspace() {
  const query = new URLSearchParams(useRouterState({ select: (state) => state.location.searchStr }))
  const client = useQuery(consentClientQuery(query.get('client_id') ?? ''))
  const workspaces = useQuery(workspacesQuery)
  const select = useMutation(selectWorkspaceMutation)
  const going = useMutation({ mutationFn: continueSignIn })
  const pending = select.isPending || going.isPending || going.isSuccess
  const failure =
    select.error !== null
      ? messageOf(select.error, 'choose that workspace')
      : going.error !== null
        ? messageOf(going.error, 'continue the sign-in')
        : ''
  function choose(workspaceId: string): void {
    select.mutate(workspaceId, {
      onSuccess: () => going.mutate(undefined, { onSuccess: (next) => window.location.assign(next) }),
    })
  }
  return (
    <AuthShell
      title={`Which workspace should “${client.data?.name ?? '…'}” use?`}
      description="It will reach only the workspace you choose. To use it with another, sign it in again."
    >
      <div className="auth-body">
        {workspaces.data === undefined ? (
          <Skeleton className="h-24" />
        ) : (
          <div className="flex flex-col gap-2">
            {workspaces.data.map((workspace) => (
              <Button
                key={workspace.id}
                variant="outline"
                className="justify-start"
                disabled={pending}
                onClick={() => choose(workspace.id)}
              >
                {workspace.name}
              </Button>
            ))}
          </div>
        )}
        {(failure !== '' || workspaces.isError) && (
          <Alert variant="destructive">
            <AlertDescription>{failure || messageOf(workspaces.error, 'list your workspaces')}</AlertDescription>
          </Alert>
        )}
      </div>
    </AuthShell>
  )
}
