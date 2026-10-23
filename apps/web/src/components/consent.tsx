import { useState } from 'react'
import { GRANT_SPEC, type GrantTerms, type WorkspaceView } from '@goblin/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Button, Card, CardContent, ConsentSummary, Skeleton } from '@goblin/ui'
import { clientGrantMutation, clientTermsQuery, workspacesQuery } from '../account/queries.ts'
import { AuthRefused, consentClientQuery, consentMutation, sessionPersonQuery } from '../auth/queries.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { AuthShell } from './auth-shell.tsx'
import { GRANT_WORDS, type GrantHolder, GrantEditor, grantFailure, grantProblem, reachWords } from './grant-editor.tsx'

type ClientInfo = { readonly name: string; readonly uri?: string | undefined }
/** The client asking, once looked up, or why it could not be: then the owner is not asked to allow it. */
type ClientLookup =
  | { readonly kind: 'loading' }
  | { readonly kind: 'found'; readonly client: ClientInfo }
  | { readonly kind: 'failed'; readonly reason: string }

const LOOKUP_FAILED = 'Could not look up the app asking for access. Reload the page to try again.'
const UNKNOWN_CLIENT = 'goblin does not know this app. Start connecting from the app again.'

/** The client's registered name and address: untrusted, shown as the client's own claim. */
function useClient(clientId: string): ClientLookup {
  const read = useQuery(consentClientQuery(clientId))
  if (read.data !== undefined) return { kind: 'found', client: read.data }
  if (read.error === null) return { kind: 'loading' }
  const unknown = read.error instanceof AuthRefused && read.error.status === 404
  return { kind: 'failed', reason: withRef(unknown ? UNKNOWN_CLIENT : LOOKUP_FAILED, read.error) }
}

/**
 * Who asks: the name and address the client registered (its own claim, not verified), its exact id, and the account
 * it would act for.
 */
function ClientIdentity(props: { readonly clientId: string; readonly client: ClientInfo | undefined }) {
  const person = useQuery(sessionPersonQuery).data
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex flex-col gap-2 text-sm">
          {props.client === undefined ? (
            <Skeleton className="h-5 w-40" />
          ) : (
            <p className="m-0 font-medium text-balance">{props.client.name}</p>
          )}
          {props.client?.uri && (
            <p className="m-0 text-pretty text-muted-foreground">
              Says it is <span className="break-all">{props.client.uri}</span>
            </p>
          )}
          <p className="m-0 text-xs text-muted-foreground">
            Client ID <code className="break-all text-foreground">{props.clientId}</code>
          </p>
          {person && <p className="m-0 text-xs text-muted-foreground">For {person.email}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

/** A person in no workspace yet (an invitation waiting) is pointed to it: a grant would reach nothing. */
function NoWorkspace() {
  return (
    <Alert>
      <AlertDescription>
        You are in no workspace yet. <Link to="/">Join the one you were invited to</Link>, or start your own, then
        connect this app again.
      </AlertDescription>
    </Alert>
  )
}

/**
 * The client's grant as the consent page offers it: its current terms when it has a grant, else the default chain's
 * (ADR 0114), until the person changes them.
 */
function useOffer(clientId: string) {
  const offered = useQuery(clientTermsQuery(clientId))
  const [chosen, setChosen] = useState<GrantTerms>()
  const terms = chosen ?? offered.data?.current ?? offered.data?.defaults
  return {
    terms,
    setTerms: setChosen,
    failure: offered.error === null ? '' : messageOf(offered.error, 'read what it may do'),
  }
}

/**
 * The person's answer: on Approve the grant first (a consent without one reaches nothing, and a grant without a consent
 * is harmless), then Better Auth's consent; on Deny the refusal alone. Which button is busy, and why it failed.
 */
function useDecision(clientId: string) {
  const granting = useMutation(clientGrantMutation)
  const deciding = useMutation(consentMutation)
  const [choice, setChoice] = useState<'approve' | 'deny'>()
  // A decision that succeeded is leaving for the client, so its button stays busy.
  const pending = granting.isPending || deciding.isPending || deciding.isSuccess ? choice : undefined
  const error =
    granting.error !== null
      ? grantFailure(granting.error, 'save what it may do')
      : deciding.error === null
        ? ''
        : messageOf(deciding.error, 'complete the authorization')
  const consent = (accept: boolean) =>
    deciding.mutate({ accept }, { onSuccess: (next) => window.location.assign(next) })
  function approve(terms: GrantTerms): void {
    setChoice('approve')
    granting.mutate({ clientId, terms }, { onSuccess: () => consent(true) })
  }
  function deny(): void {
    setChoice('deny')
    consent(false)
  }
  return { approve, deny, pending, error }
}

/** What the client may do, in a line, and Change to edit it before approving. */
function Offer(props: {
  readonly name: string
  readonly terms: GrantTerms
  readonly workspaces: readonly WorkspaceView[]
  readonly onChange: (terms: GrantTerms) => void
  readonly disabled: boolean
}) {
  const holder: GrantHolder = { kind: 'client', workspaces: props.workspaces }
  return (
    <ConsentSummary
      clientName={props.name}
      terms={props.terms}
      spec={GRANT_SPEC}
      words={GRANT_WORDS}
      describeReach={reachWords(holder)}
      disabled={props.disabled}
    >
      <GrantEditor terms={props.terms} holder={holder} onChange={props.onChange} disabled={props.disabled} />
    </ConsentSummary>
  )
}

/**
 * Ask the person whether an MCP client may use goblin, and with what grant (ADR 0114): one line says what it may do,
 * Change opens the editor, Approve saves the grant and then consents. Client-supplied names and URLs are shown as
 * untrusted.
 */
export function Consent() {
  const clientId = new URLSearchParams(window.location.search).get('client_id') ?? ''
  const lookup = useClient(clientId)
  const client = lookup.kind === 'found' ? lookup.client : undefined
  const workspaces = useQuery(workspacesQuery).data
  const offer = useOffer(clientId)
  const { approve, deny, pending, error } = useDecision(clientId)
  const problem = offer.terms === undefined ? '' : grantProblem(offer.terms)
  const failure = error || (lookup.kind === 'failed' ? lookup.reason : '') || offer.failure
  return (
    <AuthShell
      size="lg"
      title={`Allow “${client?.name ?? '…'}” to use goblin?`}
      description="The app supplies its own name and address; they are not verified."
      footer={<p>Change or revoke it any time in Settings.</p>}
    >
      <div className="auth-body">
        <ClientIdentity clientId={clientId} client={client} />
        {workspaces?.length === 0 ? (
          <NoWorkspace />
        ) : offer.terms === undefined || workspaces === undefined || client === undefined ? (
          offer.failure === '' && lookup.kind !== 'failed' && <Skeleton className="h-16" />
        ) : (
          <Offer
            name={client.name}
            terms={offer.terms}
            workspaces={workspaces}
            onChange={offer.setTerms}
            disabled={pending !== undefined}
          />
        )}
        {(failure || problem) && (
          <Alert variant="destructive">
            <AlertDescription>{failure || problem}</AlertDescription>
          </Alert>
        )}
        <div className="flex flex-col gap-2 sm:flex-row-reverse sm:justify-start">
          <Button
            size="lg"
            pending={pending === 'approve'}
            disabled={pending !== undefined || client === undefined || offer.terms === undefined || problem !== ''}
            onClick={() => offer.terms !== undefined && approve(offer.terms)}
          >
            Approve
          </Button>
          <Button
            size="lg"
            variant="outline"
            pending={pending === 'deny'}
            disabled={pending !== undefined}
            onClick={deny}
          >
            Deny
          </Button>
        </div>
      </div>
    </AuthShell>
  )
}
