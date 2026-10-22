// The Settings card for API keys (ADR 0081): what a server the owner runs uses instead of a browser session.
import { Fragment, type SubmitEvent, useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { type ApiKeyView, type KeyOrigin, type KeyScope, keyOriginsOf } from '@goblin/contracts'
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
  FieldLabel,
  Input,
  Skeleton,
  Switch,
} from '@goblin/ui'
import {
  createKeyMutation,
  keysQuery,
  revokeKeyMutation,
  rotateKeyMutation,
  updateKeyMutation,
} from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { setupCatalogQuery } from '../setup/queries.ts'

const SCOPES: readonly { readonly scope: KeyScope; readonly label: string }[] = [
  { scope: 'topics', label: 'Make and change its own Topics' },
  { scope: 'conversations', label: 'Send to and read its own chats' },
  { scope: 'personas', label: 'Make and change its own Personas' },
  { scope: 'inspect', label: 'See how its own chats ran, without their words' },
]

/** One switch of a set, as a labelled row. */
function Toggle(props: {
  readonly id: string
  readonly label: string
  readonly on: boolean
  readonly onChange: (on: boolean) => void
}) {
  return (
    <Field orientation="horizontal">
      <Switch id={props.id} checked={props.on} onCheckedChange={props.onChange} />
      <FieldLabel htmlFor={props.id}>{props.label}</FieldLabel>
    </Field>
  )
}

const toggled = <A,>(items: readonly A[], item: A, on: boolean): readonly A[] =>
  on ? [...new Set([...items, item])] : items.filter((each) => each !== item)

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

/** One origin being edited: its address and its tools as typed, comma-separated. */
type OriginRow = { readonly origin: string; readonly tools: string }

const rowsOf = (origins: readonly KeyOrigin[]): readonly OriginRow[] =>
  origins.map(({ origin, tools }) => ({ origin, tools: tools.join(', ') }))
const originsOf = (rows: readonly OriginRow[]): readonly KeyOrigin[] =>
  rows
    .filter((row) => row.origin.trim() !== '' || row.tools.trim() !== '')
    .map((row) => ({
      origin: row.origin.trim(),
      tools: row.tools
        .split(',')
        .map((tool) => tool.trim())
        .filter((tool) => tool !== ''),
    }))

/** What is wrong with `rows` as a key's origins, in words, before anything is sent (`keyOriginsOf`). */
const ORIGIN_PROBLEMS = {
  key_origin: 'Each server needs its own https address of a public host, like https://mcp.example.com, at most 8.',
  key_origin_tools: 'Each server needs 1 to 50 tool names, separated by commas.',
} as const
const originProblem = (rows: readonly OriginRow[]): string => {
  const checked = keyOriginsOf(originsOf(rows))
  return 'problem' in checked ? ORIGIN_PROBLEMS[checked.problem] : ''
}

/**
 * The MCP servers a key's threads may connect to (ADR 0091): each an https origin with exactly the tools they may call
 * there, as rows to edit.
 */
function OriginFields(props: {
  readonly id: string
  readonly rows: readonly OriginRow[]
  readonly onChange: (rows: readonly OriginRow[]) => void
}) {
  const set = (index: number, row: OriginRow) =>
    props.onChange(props.rows.map((each, at) => (at === index ? row : each)))
  return (
    <>
      <p className="text-sm text-muted-foreground">
        MCP servers its threads may connect to, and the tools they may call
      </p>
      {props.rows.map((row, index) => (
        // The rows have no ids of their own; their order is their identity while editing.
        <Field key={index} orientation="horizontal">
          <Input
            aria-label="Server address"
            placeholder="https://mcp.example.com"
            value={row.origin}
            onChange={(event) => set(index, { ...row, origin: event.target.value })}
          />
          <Input
            aria-label="Tools"
            placeholder="job_submit, job_status"
            value={row.tools}
            onChange={(event) => set(index, { ...row, tools: event.target.value })}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => props.onChange(props.rows.filter((_, at) => at !== index))}
          >
            Remove
          </Button>
        </Field>
      ))}
      <Field orientation="horizontal">
        <Button
          type="button"
          size="sm"
          variant="outline"
          id={`${props.id}-add-origin`}
          onClick={() => props.onChange([...props.rows, { origin: '', tools: '' }])}
        >
          Add a server
        </Button>
      </Field>
    </>
  )
}

/** One key's MCP servers, changed in place (ADR 0091): the same key, which keeps what it made. */
function KeyServers(props: {
  readonly keyId: string
  readonly origins: readonly KeyOrigin[]
  readonly onDone: () => void
}) {
  const update = useMutation(updateKeyMutation)
  const [rows, setRows] = useState(rowsOf(props.origins))
  const problem = originProblem(rows)
  const failure = update.error === null ? '' : messageOf(update.error, 'change that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    update.mutate({ keyId: props.keyId, origins: [...originsOf(rows)] }, { onSuccess: props.onDone })
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {(failure || problem) && (
          <Alert variant="destructive">
            <AlertDescription>{failure || problem}</AlertDescription>
          </Alert>
        )}
        <OriginFields id={`key-${props.keyId}`} rows={rows} onChange={setRows} />
        <Field orientation="horizontal">
          <Button type="submit" size="sm" pending={update.isPending} disabled={problem !== ''}>
            Save servers
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={props.onDone}>
            Cancel
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/**
 * A new key: its name, scopes, the servers its setups may use and the MCP servers its threads may connect to (ADR 0091)
 * and its lifetime; then its secret, once. */
function NewKey() {
  const create = useMutation(createKeyMutation)
  const servers = useQuery(setupCatalogQuery).data?.servers ?? []
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<readonly KeyScope[]>(['topics', 'conversations', 'personas'])
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [origins, setOrigins] = useState<readonly OriginRow[]>([])
  const [days, setDays] = useState('90')
  const problem = originProblem(origins)
  const failure = create.error === null ? '' : messageOf(create.error, 'make that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate({
      name: name.trim(),
      scopes: [...scopes],
      servers: [...chosen],
      origins: [...originsOf(origins)],
      expiresInDays: Number(days),
    })
  }
  if (create.data !== undefined)
    return <ShownSecret name={create.data.key.name} secret={create.data.secret} onDone={() => create.reset()} />
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {(failure || problem) && (
          <Alert variant="destructive">
            <AlertDescription>{failure || problem}</AlertDescription>
          </Alert>
        )}
        <Field>
          <FieldLabel htmlFor="key-name">Name</FieldLabel>
          <Input id="key-name" value={name} maxLength={64} required onChange={(event) => setName(event.target.value)} />
        </Field>
        {SCOPES.map(({ scope, label }) => (
          <Toggle
            key={scope}
            id={`key-scope-${scope}`}
            label={label}
            on={scopes.includes(scope)}
            onChange={(on) => setScopes(toggled(scopes, scope, on))}
          />
        ))}
        {servers.length > 0 && <p className="text-sm text-muted-foreground">Servers its Topics and Personas may use</p>}
        {servers.map((server) => (
          <Toggle
            key={server.connectionId}
            id={`key-server-${server.connectionId}`}
            label={server.label}
            on={chosen.includes(server.connectionId)}
            onChange={(on) => setChosen(toggled(chosen, server.connectionId, on))}
          />
        ))}
        <OriginFields id="key-new" rows={origins} onChange={setOrigins} />
        <Field>
          <FieldLabel htmlFor="key-days">Expires after (days)</FieldLabel>
          <Input
            id="key-days"
            type="number"
            min={1}
            max={365}
            value={days}
            onChange={(event) => setDays(event.target.value)}
          />
        </Field>
        <Field orientation="horizontal">
          <Button
            type="submit"
            pending={create.isPending}
            disabled={name.trim() === '' || scopes.length === 0 || problem !== ''}
          >
            Make key
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** One key's scopes, changed in place (ADR 0084): it stays the same key, and keeps what it made. */
function KeyScopes(props: {
  readonly keyId: string
  readonly scopes: readonly KeyScope[]
  readonly onDone: () => void
}) {
  const update = useMutation(updateKeyMutation)
  const [scopes, setScopes] = useState(props.scopes)
  const failure = update.error === null ? '' : messageOf(update.error, 'change that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    update.mutate({ keyId: props.keyId, scopes: [...scopes] }, { onSuccess: props.onDone })
  }
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        {SCOPES.map(({ scope, label }) => (
          <Toggle
            key={scope}
            id={`key-${props.keyId}-scope-${scope}`}
            label={label}
            on={scopes.includes(scope)}
            onChange={(on) => setScopes(toggled(scopes, scope, on))}
          />
        ))}
        <Field orientation="horizontal">
          <Button type="submit" size="sm" pending={update.isPending} disabled={scopes.length === 0}>
            Save scopes
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={props.onDone}>
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
          its scopes, servers and what it made.
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

/** What is open under one key: its scopes, its MCP servers or a new secret. */
type Editing = { readonly id: string; readonly what: 'scopes' | 'servers' | 'secret' }

/** The part open under one key, which closes with `onDone`. */
function KeyEditor(props: {
  readonly apiKey: ApiKeyView
  readonly what: Editing['what']
  readonly onDone: () => void
}) {
  const { apiKey, onDone } = props
  if (props.what === 'scopes') return <KeyScopes keyId={apiKey.id} scopes={apiKey.scopes} onDone={onDone} />
  if (props.what === 'servers') return <KeyServers keyId={apiKey.id} origins={apiKey.origins} onDone={onDone} />
  return <RotateSecret keyId={apiKey.id} name={apiKey.name} onDone={onDone} />
}

/** The owner's keys, each revocable, each one's secret rotatable, and its scopes and MCP servers changeable. */
function Keys() {
  const keys = useSuspenseQuery(keysQuery).data
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
              <li className="pick-row">
                <span className="grant-text">
                  <span className="grant-name">
                    {key.name} {key.start && <code>{key.start}…</code>}
                  </span>
                  <span className="grant-about">
                    {key.scopes.join(', ')}
                    {key.servers.length > 0 && ` · ${key.servers.join(', ')}`}
                    {key.origins.length > 0 && ` · ${key.origins.map(({ origin }) => new URL(origin).host).join(', ')}`}
                    {key.expiresAt && ` · expires ${new Date(key.expiresAt).toLocaleDateString()}`}
                    {key.lastUsedAt && ` · used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                  </span>
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rotating !== undefined || (editing?.id === key.id && editing.what === 'scopes')}
                  onClick={() => setEditing({ id: key.id, what: 'scopes' })}
                >
                  Change scopes
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rotating !== undefined || (editing?.id === key.id && editing.what === 'servers')}
                  onClick={() => setEditing({ id: key.id, what: 'servers' })}
                >
                  Change servers
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={rotating !== undefined}
                  onClick={() => setEditing({ id: key.id, what: 'secret' })}
                >
                  Rotate secret
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  pending={revoking === key.id}
                  disabled={(revoking !== '' && revoking !== key.id) || rotating === key.id}
                  onClick={() => revoke.mutate(key.id)}
                >
                  Revoke
                </Button>
              </li>
              {editing?.id === key.id && (
                <li>
                  <KeyEditor apiKey={key} what={editing.what} onDone={() => setEditing(undefined)} />
                </li>
              )}
            </Fragment>
          ))}
        </ul>
      )}
    </>
  )
}

/** Keys for servers the owner runs: a new one, and the list. */
export function ApiKeysCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>New key</CardTitle>
        <CardDescription>
          A key reaches only the Topics, chats and Personas it makes itself, never yours, and does not keep your agent
          active. Messages it sends run as yours in its Topics.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <NewKey />
        <QueryBoundary action="list your API keys" pending={<Skeleton className="h-6 w-full" />}>
          <Keys />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
