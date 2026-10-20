// The Settings card for API keys (ADR 0081): what a server the owner runs uses instead of a browser session.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import type { KeyScope } from '@goblin/contracts'
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
import { createKeyMutation, keysQuery, revokeKeyMutation } from '../account/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { setupCatalogQuery } from '../setup/queries.ts'

const SCOPES: readonly { readonly scope: KeyScope; readonly label: string }[] = [
  { scope: 'topics', label: 'Make and change its own Topics' },
  { scope: 'conversations', label: 'Send to and read its own chats' },
  { scope: 'personas', label: 'Make and change its own Personas' },
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

/** A new key's secret, shown this once, to copy. */
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

/** A new key: its name, scopes, the servers its setups may use and its lifetime; then its secret, once. */
function NewKey() {
  const create = useMutation(createKeyMutation)
  const servers = useQuery(setupCatalogQuery).data?.servers ?? []
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<readonly KeyScope[]>(['topics', 'conversations', 'personas'])
  const [chosen, setChosen] = useState<readonly string[]>([])
  const [days, setDays] = useState('90')
  const failure = create.error === null ? '' : messageOf(create.error, 'make that key')
  function submit(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    create.mutate({ name: name.trim(), scopes: [...scopes], servers: [...chosen], expiresInDays: Number(days) })
  }
  if (create.data !== undefined)
    return <ShownSecret name={create.data.key.name} secret={create.data.secret} onDone={() => create.reset()} />
  return (
    <form onSubmit={submit}>
      <FieldGroup>
        {failure && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
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
          <Button type="submit" pending={create.isPending} disabled={name.trim() === '' || scopes.length === 0}>
            Make key
          </Button>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** The owner's keys, each revocable. */
function Keys() {
  const keys = useSuspenseQuery(keysQuery).data
  const revoke = useMutation(revokeKeyMutation)
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
            <li className="pick-row" key={key.id}>
              <span className="grant-text">
                <span className="grant-name">
                  {key.name} {key.start && <code>{key.start}…</code>}
                </span>
                <span className="grant-about">
                  {key.scopes.join(', ')}
                  {key.servers.length > 0 && ` · ${key.servers.join(', ')}`}
                  {key.expiresAt && ` · expires ${new Date(key.expiresAt).toLocaleDateString()}`}
                  {key.lastUsedAt && ` · used ${new Date(key.lastUsedAt).toLocaleDateString()}`}
                </span>
              </span>
              <Button
                size="sm"
                variant="outline"
                pending={revoking === key.id}
                disabled={revoking !== '' && revoking !== key.id}
                onClick={() => revoke.mutate(key.id)}
              >
                Revoke
              </Button>
            </li>
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
