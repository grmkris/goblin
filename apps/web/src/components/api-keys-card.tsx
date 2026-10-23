// The Settings card for API keys (ADRs 0081, 0114): what a server the workspace runs uses instead of a browser session,
// each with its grant.
import { Fragment, type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { type ApiKeyView, GRANT_SPEC, type GrantTerms, type WorkspaceView, presetFor } from '@goblin/contracts'
import {
  Alert,
  AlertDescription,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConsentSummary,
  Field,
  FieldGroup,
  FieldLabel,
  Input,
  Skeleton,
} from '@goblin/ui'
import {
  createKeyMutation,
  keysQuery,
  revokeKeyMutation,
  rotateKeyMutation,
  updateKeyMutation,
} from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary, WidenLink } from '../lib/query/query-boundary.tsx'
import { GRANT_WORDS, type GrantHolder, GrantEditor, GrantLine, grantProblem, reachWords } from './grant-editor.tsx'

/** A new key's secret, or a rotated key's new one (ADR 0105), shown this once, to copy. */
function ShownSecret(props: { readonly name: string; readonly secret: string; readonly onDone: () => void }) {
  return (
    <FieldGroup>
      <Alert>
        <AlertDescription>
          Copy the key for <strong>{props.name}</strong> now. It is not shown again.
        </AlertDescription>
      </Alert>
      <Input readOnly value={props.secret} onFocus={(event) => event.currentTarget.select()} />
      <Field orientation="horizontal">
        <Button type="button" onClick={() => void navigator.clipboard.writeText(props.secret)}>
          Copy
        </Button>
        <Button type="button" variant="ghost" onClick={props.onDone}>
          Done
        </Button>
      </Field>
    </FieldGroup>
  )
}

/**
 * A failure beside the control that failed (with its widening link, when it is one), or what is wrong before anything
 * is sent.
 */
function Problem(props: { readonly text: string; readonly error?: unknown }) {
  if (props.text === '') return null
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {props.text} <WidenLink error={props.error} />
      </AlertDescription>
    </Alert>
  )
}

/**
 * A new key: its name and its grant (ADR 0114), which starts as the preset (write, every Topic, Persona and
 * connection, no extras, until revoked); then its secret, once.
 */
function NewKey(props: { readonly workspace: WorkspaceView }) {
  const create = useMutation(createKeyMutation)
  const holder: GrantHolder = { kind: 'key', workspace: props.workspace }
  const [name, setName] = useState('')
  const [terms, setTerms] = useState<GrantTerms>(() => presetFor('key', [props.workspace.id]))
  const problem = grantProblem(terms)
  const failure = create.error === null ? '' : messageOf(create.error, 'make that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate({ name: name.trim(), terms: { ...terms, name: name.trim() } })
  }
  if (create.data !== undefined)
    return (
      <ShownSecret
        name={create.data.key.name}
        secret={create.data.secret}
        onDone={() => {
          create.reset()
          setName('')
          setTerms(presetFor('key', [props.workspace.id]))
        }}
      />
    )
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        <Problem text={failure} error={create.error} />
        <Field>
          <FieldLabel htmlFor="key-name">Name</FieldLabel>
          <Input id="key-name" value={name} maxLength={64} required onChange={(event) => setName(event.target.value)} />
        </Field>
        <ConsentSummary
          clientName={name.trim() || 'The key'}
          terms={terms}
          spec={GRANT_SPEC}
          words={GRANT_WORDS}
          describeReach={reachWords(holder)}
        >
          <GrantEditor terms={terms} holder={holder} onChange={setTerms} disabled={create.isPending} />
        </ConsentSummary>
        <Problem text={problem} />
        <Field orientation="horizontal">
          <Button type="submit" pending={create.isPending} disabled={name.trim() === '' || problem !== ''}>
            Make key
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** One key's grant, changed in place (ADR 0114): it stays the same key, with its id and secret. */
function KeyGrant(props: { readonly apiKey: ApiKeyView; readonly holder: GrantHolder; readonly onDone: () => void }) {
  const update = useMutation(updateKeyMutation)
  const { apiKey } = props
  const [terms, setTerms] = useState<GrantTerms>(
    () => apiKey.terms ?? presetFor(apiKey.name, [props.holder.kind === 'key' ? props.holder.workspace.id : '']),
  )
  const problem = grantProblem(terms)
  const failure = update.error === null ? '' : messageOf(update.error, 'change that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    update.mutate({ keyId: apiKey.id, terms }, { onSuccess: props.onDone })
  }
  return (
    <form onSubmit={submit} className="pb-4">
      <FieldGroup>
        <Problem text={failure} error={update.error} />
        <GrantEditor terms={terms} holder={props.holder} onChange={setTerms} disabled={update.isPending} />
        <Problem text={problem} />
        <Field orientation="horizontal">
          <Button type="submit" pending={update.isPending} disabled={problem !== ''}>
            Save access
          </Button>
          <Button type="button" variant="ghost" disabled={update.isPending} onClick={props.onDone}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/**
 * A new secret for one key (ADR 0105), once the owner confirms that the old one stops working at once; then the new one,
 * once. It stays the same key, and keeps what it made.
 */
function RotateSecret(props: { readonly keyId: string; readonly name: string; readonly onDone: () => void }) {
  const rotate = useMutation(rotateKeyMutation)
  const failure = rotate.error === null ? '' : messageOf(rotate.error, 'rotate that key')
  if (rotate.data !== undefined)
    return <ShownSecret name={rotate.data.key.name} secret={rotate.data.secret} onDone={props.onDone} />
  return (
    <FieldGroup>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      <div className="inline-confirm" role="alertdialog" aria-label={`Rotate the secret of ${props.name}?`}>
        <span>
          Rotate its secret? The old one stops working at once, so anything using it needs the new one. The key keeps
          its access.
        </span>
        <Button size="sm" variant="destructive" pending={rotate.isPending} onClick={() => rotate.mutate(props.keyId)}>
          Rotate secret
        </Button>
        <Button size="sm" variant="ghost" disabled={rotate.isPending} onClick={props.onDone}>
          Cancel
        </Button>
      </div>
    </FieldGroup>
  )
}

/** What is open under one key: its grant, or a new secret. */
type Editing = { readonly id: string; readonly what: 'access' | 'secret' }

/** The part open under one key, which closes with `onDone`. */
function KeyEditor(props: {
  readonly apiKey: ApiKeyView
  readonly holder: GrantHolder
  readonly what: Editing['what']
  readonly onDone: () => void
}) {
  const { apiKey, onDone } = props
  if (props.what === 'access') return <KeyGrant apiKey={apiKey} holder={props.holder} onDone={onDone} />
  return <RotateSecret keyId={apiKey.id} name={apiKey.name} onDone={onDone} />
}

/** When a key was last used and when it ends, as dates. */
const datesOf = (key: ApiKeyView): string =>
  [
    key.expiresAt === undefined ? undefined : `ends ${new Date(key.expiresAt).toLocaleDateString()}`,
    key.lastUsedAt === undefined ? undefined : `used ${new Date(key.lastUsedAt).toLocaleDateString()}`,
  ]
    .filter((part) => part !== undefined)
    .join(' · ')

/** The owner's keys, each with its grant in a line, changeable, its secret rotatable, and revocable. */
function Keys(props: { readonly workspace: WorkspaceView }) {
  const keys = useSuspenseQuery(keysQuery).data
  const holder: GrantHolder = { kind: 'key', workspace: props.workspace }
  const revoke = useMutation(revokeKeyMutation)
  const [editing, setEditing] = useState<Editing>()
  // While a key's new secret is open, nothing else may close it: the old one already stopped working (ADR 0105).
  const rotating = editing?.what === 'secret' ? editing.id : undefined
  const revoking = revoke.isPending ? revoke.variables : ''
  const failure = revoke.error === null ? '' : messageOf(revoke.error, 'revoke that key')
  return (
    <>
      {failure && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {keys.length === 0 && <p className="server-note">None yet.</p>}
      {keys.length > 0 && (
        <ul className="pick-list">
          {keys.map((key) => (
            <Fragment key={key.id}>
              <li className="pick-row flex-wrap">
                <span className="grant-text basis-64">
                  <span className="grant-name">
                    {key.name} {key.start && <code>{key.start}…</code>}
                  </span>
                  <span className="text-sm text-pretty text-muted-foreground">
                    {key.terms === undefined ? (
                      'No grant yet.'
                    ) : (
                      <GrantLine name="It" terms={key.terms} holder={holder} />
                    )}
                  </span>
                  {datesOf(key) !== '' && (
                    <span className="text-xs text-muted-foreground tabular-nums">{datesOf(key)}</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    disabled={rotating !== undefined || (editing?.id === key.id && editing.what === 'access')}
                    onClick={() => setEditing({ id: key.id, what: 'access' })}
                  >
                    Change access
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={rotating !== undefined}
                    onClick={() => setEditing({ id: key.id, what: 'secret' })}
                  >
                    Rotate secret
                  </Button>
                  <Button
                    variant="outline"
                    pending={revoking === key.id}
                    disabled={(revoking !== '' && revoking !== key.id) || rotating === key.id}
                    onClick={() => revoke.mutate(key.id)}
                  >
                    Revoke
                  </Button>
                </span>
              </li>
              {editing?.id === key.id && (
                <li>
                  <KeyEditor apiKey={key} holder={holder} what={editing.what} onDone={() => setEditing(undefined)} />
                </li>
              )}
            </Fragment>
          ))}
        </ul>
      )}
    </>
  )
}

/** Keys for servers the workspace runs: a new one, and the list. */
export function ApiKeysCard(props: { readonly workspace: WorkspaceView }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New key</CardTitle>
        <CardDescription>
          A key reaches what its access allows in this workspace, and anything it makes is added to what it reaches. It
          does not keep your agent active.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-6">
          <NewKey workspace={props.workspace} />
          <QueryBoundary action="list your API keys" pending={<Skeleton className="h-6 w-full" />}>
            <Keys workspace={props.workspace} />
          </QueryBoundary>
        </div>
      </CardContent>
    </Card>
  )
}
