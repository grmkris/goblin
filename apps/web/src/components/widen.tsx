import { useState } from 'react'
import { type AccessSummary, GRANT_SPEC, type WorkspaceView } from '@goblin/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Skeleton, WidenApproval, failed, succeeded } from '@goblin/ui'
import { grantTermsQuery, widenGrantMutation, workspacesQuery } from '../account/queries.ts'
import { describeError, messageOf } from '../lib/query/app-error.ts'
import { type WidenSearch, askedWords, wideningOf } from '../lib/widen.ts'
import { AuthShell } from './auth-shell.tsx'
import { GRANT_WORDS, type GrantHolder, GrantLine, reachWords } from './grant-editor.tsx'

/** Whose grant it is: a key's lives in the one workspace it reaches; anything else is a client's. */
const holderOf = (summary: AccessSummary, workspaces: readonly WorkspaceView[]): GrantHolder => {
  const home = workspaces.find((workspace) => workspace.id === summary.reach.each[0]?.workspace)
  return summary.keyId !== undefined && home !== undefined
    ? { kind: 'key', workspace: home }
    : { kind: 'client', workspaces }
}

/** When access ends, in words. */
const endsOf = (expiresAt: string | null): string =>
  expiresAt === null
    ? 'until revoked'
    : new Date(expiresAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })

/** The page's state once decided: what the grant holds now, or that nothing changed. */
function Decided(props: { readonly children: React.ReactNode }) {
  return (
    <div className="auth-body">
      <Alert>
        <AlertDescription>{props.children}</AlertDescription>
      </Alert>
      <p className="m-0 text-sm">
        <Link to="/">Back to goblin</Link>
      </p>
    </div>
  )
}

/** The comparison, once the grant's terms are read: Approve saves exactly the requested terms. */
function Comparison(props: { readonly search: WidenSearch; readonly grantId: string }) {
  const read = useQuery(grantTermsQuery(props.grantId))
  const workspaces = useQuery(workspacesQuery).data
  const save = useMutation(widenGrantMutation)
  const [denied, setDenied] = useState(false)
  if (read.error !== null)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {describeError(read.error).kind === 'not_found' || describeError(read.error).kind === 'forbidden'
            ? 'This access is not yours to change, or it has ended.'
            : messageOf(read.error, 'read this access')}
        </AlertDescription>
      </Alert>
    )
  if (read.data === undefined || workspaces === undefined) return <Skeleton className="h-40" />
  const widening = wideningOf(read.data, props.search)
  if (widening === null)
    return (
      <Alert>
        <AlertDescription>
          This access has nothing you can widen: it has ended, or the link is not for it.
        </AlertDescription>
      </Alert>
    )
  const holder = holderOf(widening.summary, workspaces)
  if (denied) return <Decided>Nothing changed. {widening.current.name} keeps the access it had.</Decided>
  if (save.data !== undefined)
    return (
      <Decided>
        Approved. <GrantLine name={save.data.terms.name} terms={save.data.terms} holder={holder} />.
      </Decided>
    )
  return (
    <WidenApproval
      current={widening.current}
      currentEnds={endsOf(widening.summary.expiresAt)}
      requested={widening.requested}
      spec={GRANT_SPEC}
      words={GRANT_WORDS}
      describeReach={reachWords(holder)}
      asks={askedWords(props.search, widening.current, widening.requested, workspaces)}
      identity={
        <>
          {widening.summary.keyId === undefined ? 'MCP client' : 'API key'}{' '}
          <code className="break-all">{widening.summary.keyId ?? widening.summary.clientId ?? widening.grantId}</code>
        </>
      }
      onApprove={() =>
        save.mutateAsync({ grantId: widening.grantId, terms: widening.requested }).then(
          () => succeeded,
          (error: unknown) => failed(messageOf(error, 'approve this access')),
        )
      }
      onDeny={() => setDenied(true)}
    />
  )
}

/**
 * Widening a grant (ADR 0114): a refusal's link names the grant and what it lacked; the page shows what it holds now
 * and what approving adds, and saves exactly that. Only the person who may approve the grant can read it here.
 */
export function Widen(props: { readonly search: WidenSearch }) {
  return (
    <AuthShell
      size="lg"
      title="More access asked for"
      description="Compare what it has with what it asks for, then decide."
      footer={<p>Change or revoke its access any time in Settings.</p>}
    >
      {props.search.grant === undefined ? (
        <Alert>
          <AlertDescription>
            This link does not name any access. Open it again from where it was given.
          </AlertDescription>
        </Alert>
      ) : (
        <Comparison search={props.search} grantId={props.search.grant} />
      )}
    </AuthShell>
  )
}
