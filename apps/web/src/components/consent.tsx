import { useState } from 'react'
import type { ClientReach } from '@goblin/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Button, Skeleton, Switch } from '@goblin/ui'
import { clientReachMutation, workspacesQuery } from '../account/queries.ts'
import { AuthRefused, consentClientQuery, consentMutation } from '../auth/queries.ts'
import { ReachChooser, initialReach, reachesAny } from './client-reach.tsx'
import { type OptionalScope, STARTS_ON, consentBody, offeredScopes, requestedScopes } from '../lib/consent-scope.ts'
import { messageOf, withRef } from '../lib/query/app-error.ts'
import { AuthShell } from './auth-shell.tsx'

type ClientInfo = { readonly name: string; readonly uri?: string | undefined }
/** The client asking, once looked up, or why it could not be: then the owner is not asked to allow it. */
type ClientLookup =
  | { readonly kind: 'loading' }
  | { readonly kind: 'found'; readonly client: ClientInfo }
  | { readonly kind: 'failed'; readonly reason: string }

const LOOKUP_FAILED = 'Could not look up the app asking for access. Reload the page to try again.'
const UNKNOWN_CLIENT = 'goblin does not know this app. Start connecting from the app again.'

/** What each opt-in scope adds (ADRs 0024, 0086, 0098), its switch's name first. Asking starts on; the rest start off. */
const SCOPE_COPY: Readonly<Record<OptionalScope, { readonly name: string; readonly lines: readonly string[] }>> = {
  'goblin:agent': {
    name: 'Let it ask your agent',
    lines: [
      'ask your agent questions and give it tasks in your main conversation, where its messages show its name;',
      'read the recent messages of your main conversation;',
      "have your agent use the tools you allowed under Connections, while Work while you're away is on.",
    ],
  },
  'goblin:topics': {
    name: 'Also let it manage your Topics',
    lines: [
      'list and read your Topics, including their guidance;',
      "make, rename and archive Topics; changing a Topic's description, guidance or what it works with needs an admin.",
    ],
  },
  'goblin:conversations': {
    name: 'Also let it send in your chats',
    lines: [
      "send messages and start threads in any of your Topics' chats, shown with its name;",
      'read their replies, and stop what a chat is doing.',
    ],
  },
  'goblin:personas': {
    name: 'Also let it manage your Personas',
    lines: [
      'list and read your Personas, and see the models they may use;',
      'make and change Personas, when you are an owner or admin of the workspace.',
    ],
  },
  'goblin:inspect': {
    name: 'Also let it read how your chats ran',
    lines: ['read how each turn ran: model calls, tool calls, retries, errors and timings, never their words.'],
  },
  'goblin:transcripts': {
    name: 'Also let it read your conversations in full',
    lines: ['read every conversation in full, including tool calls and their results, without changing anything.'],
  },
  'goblin:setup': {
    name: 'Also let it read what your setups use',
    lines: [
      'list your MCP servers with their granted tools, your skills and apps, and your Sources with their routes;',
      'it connects nothing and grants nothing.',
    ],
  },
  'goblin:routines': {
    name: 'Also let it read and draft routines',
    lines: [
      'list your routines and their runs;',
      'draft, change, pause and archive them when you are an owner or admin; a draft runs only once confirmed here.',
    ],
  },
}

/** The client's registered name and address: untrusted, shown as the client's own claim. */
function useClient(clientId: string): ClientLookup {
  const read = useQuery(consentClientQuery(clientId))
  if (read.data !== undefined) return { kind: 'found', client: read.data }
  if (read.error === null) return { kind: 'loading' }
  const unknown = read.error instanceof AuthRefused && read.error.status === 404
  return { kind: 'failed', reason: withRef(unknown ? UNKNOWN_CLIENT : LOOKUP_FAILED, read.error) }
}

/** One opt-in scope's switch, with what it adds; off until the owner turns it on. */
function ScopeChoice(props: {
  readonly scope: OptionalScope
  readonly on: boolean
  readonly onChange: (on: boolean) => void
}) {
  const { name, lines } = SCOPE_COPY[props.scope]
  const starts = STARTS_ON.includes(props.scope) ? 'On unless you turn it off.' : 'Off unless you turn it on.'
  return (
    <div className="flex flex-col gap-2">
      <label className="switch-row">
        <span className="switch-name">
          <span>{name}</span>
          <span className="switch-detail">{starts} With it, the app can:</span>
        </span>
        <Switch checked={props.on} onCheckedChange={props.onChange} />
      </label>
      <ul className="plan-points" data-off={props.on ? undefined : true}>
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  )
}

/**
 * Which workspaces the client will reach (ADR 0097): the person's choice among theirs, or all of them. A person with
 * none yet (an invitation waiting) is pointed to it instead.
 */
function Workspaces(props: {
  readonly reach: ClientReach | undefined
  readonly onChange: (reach: ClientReach) => void
}) {
  const workspaces = useQuery(workspacesQuery)
  if (workspaces.data === undefined) return <Skeleton className="h-16" />
  if (workspaces.data.length === 0)
    return (
      <Alert>
        <AlertDescription>
          You are in no workspace yet. <Link to="/">Join the one you were invited to</Link>, or start your own, then
          connect this app again.
        </AlertDescription>
      </Alert>
    )
  return (
    <div className="flex flex-col gap-2">
      <p>It reaches the workspaces you choose:</p>
      <ReachChooser
        workspaces={workspaces.data}
        value={props.reach ?? initialReach(workspaces.data)}
        onChange={props.onChange}
      />
    </div>
  )
}

/**
 * The person's answer: on Allow the reach first (a consent without one reaches nothing, and one without a consent is
 * harmless), then the consent; on Deny the refusal alone. Which button is busy, and why it failed.
 */
function useDecision(clientId: string, requested: readonly string[], on: readonly string[], reach: ClientReach) {
  const reaching = useMutation(clientReachMutation)
  const deciding = useMutation(consentMutation)
  const [choice, setChoice] = useState<'allow' | 'deny'>()
  // A decision that succeeded is leaving for the client, so its button stays busy.
  const pending = reaching.isPending || deciding.isPending || deciding.isSuccess ? choice : undefined
  const error =
    reaching.error !== null
      ? messageOf(reaching.error, 'set the workspaces it reaches')
      : deciding.error === null
        ? ''
        : messageOf(deciding.error, 'complete the authorization')
  function decide(accept: boolean): void {
    setChoice(accept ? 'allow' : 'deny')
    const consent = () =>
      deciding.mutate(consentBody(requested, accept, on), { onSuccess: (next) => window.location.assign(next) })
    if (accept) reaching.mutate({ clientId, ...reach }, { onSuccess: consent })
    else consent()
  }
  return { decide, pending, error }
}

/**
 * Ask the person whether an MCP client may use goblin, saying what the requested scopes grant and which of their
 * workspaces it reaches (ADR 0097). Each `goblin:*` scope it asks for is a separate opt-in (ADR 0086). Client-supplied
 * names and URLs are shown as untrusted.
 */
export function Consent() {
  const query = new URLSearchParams(window.location.search)
  const clientId = query.get('client_id') ?? ''
  const requested = requestedScopes(query.get('scope'))
  const lookup = useClient(clientId)
  const client = lookup.kind === 'found' ? lookup.client : undefined
  const [on, setOn] = useState<readonly string[]>(() =>
    offeredScopes(requested).filter((scope) => STARTS_ON.includes(scope)),
  )
  const workspaces = useQuery(workspacesQuery).data ?? []
  const [chosen, setChosen] = useState<ClientReach | undefined>(undefined)
  const reach = chosen ?? initialReach(workspaces)
  const { decide, pending, error } = useDecision(clientId, requested, on, reach)
  return (
    <AuthShell
      size="lg"
      title={`Allow “${client?.name ?? '…'}” to use goblin?`}
      description={
        <>
          {client?.uri ? `It says it is ${client.uri}. ` : ''}The app supplies its own name and address; they are not
          verified.
        </>
      }
      footer={<p>Revoke it any time in Settings.</p>}
    >
      <div className="auth-body">
        <p>If you allow it, the app can do what you turn on below.</p>
        <Workspaces reach={chosen} onChange={setChosen} />
        {offeredScopes(requested).map((scope) => (
          <ScopeChoice
            key={scope}
            scope={scope}
            on={on.includes(scope)}
            onChange={(turned) => setOn(turned ? [...on, scope] : on.filter((each) => each !== scope))}
          />
        ))}
        {(error || lookup.kind === 'failed') && (
          <Alert variant="destructive">
            <AlertDescription>{error || (lookup.kind === 'failed' && lookup.reason)}</AlertDescription>
          </Alert>
        )}
        <div className="card-actions">
          <Button
            size="lg"
            pending={pending === 'allow'}
            disabled={pending !== undefined || client === undefined || !reachesAny(reach)}
            onClick={() => decide(true)}
          >
            Allow
          </Button>
          <Button
            size="lg"
            variant="outline"
            pending={pending === 'deny'}
            disabled={pending !== undefined}
            onClick={() => decide(false)}
          >
            Deny
          </Button>
        </div>
      </div>
    </AuthShell>
  )
}
