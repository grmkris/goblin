// The Settings cards about the account: the MCP clients connected to it and the workspaces each reaches, and deleting
// the account.
import { type SubmitEvent, useState } from 'react'
import { type InboundClient, presetFor } from '@goblin/contracts'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Field,
  FieldGroup,
  Skeleton,
} from '@goblin/ui'
import { clientGrantMutation, clientsQuery, revokeClientMutation, workspacesQuery } from '../account/queries.ts'
import { type ReachChoice, withWorkspaces } from '../lib/grant-terms.ts'
import { AuthRefused, deleteAccountMutation } from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { ReachChooser, reachesAny } from './client-reach.tsx'

/** What a client reaches, in words: all the person's workspaces, those listed, or none. */
const reachWords = ({ reach }: InboundClient): string =>
  reach.all
    ? 'All your workspaces'
    : reach.workspaces.length === 0
      ? 'No workspace'
      : reach.workspaces.map((workspace) => workspace.name).join(', ')

/** Changing which workspaces one client reaches, from what it reaches now (ADR 0097). */
function ChangeReach(props: { readonly client: InboundClient; readonly onDone: () => void }) {
  const workspaces = useQuery(workspacesQuery).data ?? []
  const { reach } = props.client
  const [value, setValue] = useState<ReachChoice>({
    all: reach.all,
    workspaces: reach.workspaces.map((workspace) => workspace.id),
  })
  const change = useMutation(clientGrantMutation)
  // Its grant's terms with the workspaces chosen here; a client listed without one starts from the preset.
  const terms = withWorkspaces(props.client.terms ?? presetFor(props.client.name ?? 'MCP client', 'all'), value)
  const failure = change.error === null ? '' : messageOf(change.error, 'change the workspaces it reaches')
  return (
    <div className="flex flex-col gap-2">
      <ReachChooser workspaces={workspaces} value={value} onChange={setValue} disabled={change.isPending} />
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <div className="card-actions">
        <Button
          size="sm"
          pending={change.isPending}
          disabled={!reachesAny(value)}
          onClick={() => change.mutate({ clientId: props.client.clientId, terms }, { onSuccess: props.onDone })}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={change.isPending} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

function Clients() {
  const clients = useSuspenseQuery(clientsQuery).data
  const revoke = useMutation(revokeClientMutation)
  const revoking = revoke.isPending ? revoke.variables : ''
  const [changing, setChanging] = useState('')
  const failure = revoke.error === null ? '' : messageOf(revoke.error, 'revoke that client')
  return (
    <>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {clients.length === 0 && <p className="server-note">None yet.</p>}
      {clients.length > 0 && (
        <ul className="pick-list">
          {clients.map((client) => (
            <li className="flex flex-col gap-2" key={client.clientId}>
              <div className="pick-row">
                <span className="grant-text">
                  <span className="grant-name">{client.name ?? client.clientId}</span>
                  <span className="grant-about">{reachWords(client)}</span>
                  {client.uri && <span className="grant-about">{client.uri}</span>}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={changing === client.clientId}
                  onClick={() => setChanging(client.clientId)}
                >
                  Change
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  pending={revoking === client.clientId}
                  disabled={revoking !== '' && revoking !== client.clientId}
                  onClick={() => revoke.mutate(client.clientId)}
                >
                  Revoke
                </Button>
              </div>
              {changing === client.clientId && <ChangeReach client={client} onDone={() => setChanging('')} />}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The MCP clients the person let use goblin, each with the workspaces it reaches, changeable and revocable. */
export function ClientsCard() {
  return (
    <Card>
      <CardContent>
        <QueryBoundary action="list your connected clients" pending={<Skeleton className="h-6 w-full" />}>
          <Clients />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}

/** Permanent: the account, its agent's conversations, MCP connections and grants. A fresh code sign-in confirms it. */
export function DeleteAccountCard() {
  const [open, setOpen] = useState(false)
  const deleting = useMutation(deleteAccountMutation)
  // A deleted account is leaving for the start page, so the button stays busy.
  const pending = deleting.isPending || deleting.isSuccess
  const failure =
    deleting.error === null
      ? ''
      : deleting.error instanceof AuthRefused && (deleting.error.status === 400 || deleting.error.status === 401)
        ? withRef('Sign in again with an emailed code, then delete within 10 minutes.', deleting.error)
        : deleting.error instanceof AuthRefused && deleting.error.status === 409
          ? withRef(
              'You are the last owner of a workspace other people work in: make one of them an owner first.',
              deleting.error,
            )
          : messageOf(deleting.error, 'delete your account')
  function remove(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    deleting.mutate(undefined, { onSuccess: () => window.location.assign('/') })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Deletes your account and every workspace only you own, each agent with its conversations, connections,
          permissions and usage. Cancel your subscription first. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {open ? (
          <form onSubmit={remove}>
            <FieldGroup>
              {failure && (
                <Alert variant="destructive">
                  <AlertDescription>{failure}</AlertDescription>
                </Alert>
              )}
              <p className="text-sm text-muted-foreground">
                Sign in again with an emailed code first. Deleting works for 10 minutes after signing in.
              </p>
              <Field orientation="horizontal">
                <Button type="submit" variant="destructive" pending={pending}>
                  Delete my account
                </Button>
                <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
                  Cancel
                </Button>
              </Field>
            </FieldGroup>
          </form>
        ) : (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Delete account…
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
