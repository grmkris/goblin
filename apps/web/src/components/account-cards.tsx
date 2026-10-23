// The Settings cards about the account: the MCP clients connected to it, each with its grant (ADR 0114), and deleting
// the account.
import { type SubmitEvent, useState } from 'react'
import { type GrantTerms, type InboundClient, type WorkspaceView, presetFor } from '@goblin/contracts'
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
import { AuthRefused, deleteAccountMutation } from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { type GrantHolder, GrantEditor, GrantLine, grantProblem } from './grant-editor.tsx'

/** Changing one client's grant (ADR 0114), from what it holds now: a live token follows the change at once. */
function ChangeGrant(props: {
  readonly client: InboundClient
  readonly workspaces: readonly WorkspaceView[]
  readonly onDone: () => void
}) {
  const { client } = props
  const holder: GrantHolder = { kind: 'client', workspaces: props.workspaces }
  const [terms, setTerms] = useState<GrantTerms>(() => client.terms ?? presetFor(nameOf(client), 'all'))
  const change = useMutation(clientGrantMutation)
  const problem = grantProblem(terms)
  const failure = change.error === null ? '' : messageOf(change.error, 'change what it may do')
  return (
    <div className="flex flex-col gap-4 pb-4">
      <GrantEditor terms={terms} holder={holder} onChange={setTerms} disabled={change.isPending} />
      {(failure || problem) && (
        <Alert variant="destructive">
          <AlertDescription>{failure || problem}</AlertDescription>
        </Alert>
      )}
      <div className="card-actions">
        <Button
          pending={change.isPending}
          disabled={problem !== ''}
          onClick={() => change.mutate({ clientId: client.clientId, terms }, { onSuccess: props.onDone })}
        >
          Save access
        </Button>
        <Button variant="ghost" disabled={change.isPending} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/** A client's name as it registered, else its id. */
const nameOf = (client: InboundClient): string => client.name ?? client.clientId

function Clients() {
  const clients = useSuspenseQuery(clientsQuery).data
  const workspaces = useQuery(workspacesQuery).data ?? []
  const holder: GrantHolder = { kind: 'client', workspaces }
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
              <div className="pick-row flex-wrap">
                <span className="grant-text basis-64">
                  <span className="grant-name">{nameOf(client)}</span>
                  {client.uri && <span className="grant-about">{client.uri}</span>}
                  <span className="text-sm text-pretty text-muted-foreground">
                    {client.terms === undefined ? (
                      'No grant yet: it reaches nothing until you set one.'
                    ) : (
                      <GrantLine name="It" terms={client.terms} holder={holder} />
                    )}
                  </span>
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    disabled={changing === client.clientId}
                    onClick={() => setChanging(client.clientId)}
                  >
                    Change
                  </Button>
                  <Button
                    variant="outline"
                    pending={revoking === client.clientId}
                    disabled={revoking !== '' && revoking !== client.clientId}
                    onClick={() => revoke.mutate(client.clientId)}
                  >
                    Revoke
                  </Button>
                </span>
              </div>
              {changing === client.clientId && (
                <ChangeGrant client={client} workspaces={workspaces} onDone={() => setChanging('')} />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** The MCP clients the person let use goblin, each with its grant in a line, changeable and revocable. */
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
