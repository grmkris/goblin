import { useState } from 'react'
import { type AccessSummary, GRANT_SPEC, type WorkspaceView } from '@goblin/contracts'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { Alert, AlertDescription, Skeleton, WidenApproval, failed, succeeded } from '@goblin/ui'
import { grantTermsQuery, reachItemsQuery, widenGrantMutation, workspacesQuery } from '../account/queries.ts'
import { FIELD_OF } from '../lib/grant-reach.ts'
import { describeError, messageOf } from '../lib/query/app-error.ts'
import { type AskedNames, type WidenSearch, addsNothing, askedWords, reachItemOf, wideningOf } from '../lib/widen.ts'
import { AuthShell } from './auth-shell.tsx'
import { GRANT_WORDS, type GrantHolder, GrantLine, grantFailure, reachWords } from './grant-editor.tsx'

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

/**
 * The names of the workspace and the Topic, Persona or connection a link asks for, read as the editor's pickers read
 * them (that workspace's own lists, under the person's session), and whether they are still being read. One that cannot
 * be read (gone, archived, or a workspace they left) stays unnamed, and the page says its id.
 */
function useAskedNames(
  reachId: string | undefined,
  workspaces: readonly WorkspaceView[] | undefined,
): { readonly names: AskedNames; readonly reading: boolean } {
  const item = reachId === undefined ? undefined : reachItemOf(reachId)
  const workspace = workspaces?.find((each) => each.id === item?.workspace)
  const kind = item?.kind
  const picking = workspace !== undefined && kind !== undefined
  const items = useQuery(
    reachItemsQuery(workspace?.slug ?? '', kind === undefined ? 'topics' : FIELD_OF[kind], picking),
  )
  const named = item?.kind === undefined ? undefined : items.data?.find((each) => each.id === item.id)?.label
  return { names: { workspace: workspace?.name, item: named }, reading: picking && items.isLoading }
}

/** Who asks, by the name its grant carries: an API key's, or the MCP client's as it registered. */
const identityOf = (summary: AccessSummary, name: string) => (
  <>
    {summary.keyId === undefined ? 'The MCP client' : 'The API key'} <strong className="break-all">{name}</strong>
  </>
)

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
  const asked = useAskedNames(props.search.reach, workspaces)
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
  if (read.data === undefined || workspaces === undefined || asked.reading) return <Skeleton className="h-40" />
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
  // An Approve that would save the same terms only looks like a change: say so, and where its access is changed.
  if (addsNothing(widening.current, widening.requested))
    return (
      <Decided>
        This link asks for nothing {widening.current.name} does not have already. To give it more, such as another
        workspace, change its access in <Link to="/settings">Settings</Link>.
      </Decided>
    )
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
      asks={askedWords(props.search, widening.current, widening.requested, asked.names)}
      identity={identityOf(widening.summary, widening.current.name)}
      onApprove={() =>
        save.mutateAsync({ grantId: widening.grantId, terms: widening.requested }).then(
          () => succeeded,
          (error: unknown) => failed(grantFailure(error, 'approve this access')),
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
