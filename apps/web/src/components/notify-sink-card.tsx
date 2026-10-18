// The Settings card "Notify me via" (ADR 0066): one tool of one connection that goblin sends the owner's notices with,
// its arguments a JSON template with "{{text}}" where the words go. A confirmed Source's reply can be copied in, filled
// for one of its conversations (a message to the owner's own chat, say).
import { type SubmitEvent, useState } from 'react'
import { useMutation, useQuery, useSuspenseQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { notifyPlaceholder } from '@goblin/contracts'
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
  FieldDescription,
  FieldGroup,
  FieldLabel,
  JsonView,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
  Textarea,
} from '@goblin/ui'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'
import { keyWords } from '../lib/source-routes.ts'
import { type SinkDraft, sinkArguments, sinkFromSource, sinkPolicy } from '../lib/source-setup.ts'
import { connectedToolsQuery, serversQuery } from '../mcp/queries.ts'
import { notifySinkQuery, setNotifySinkMutation } from '../notify/queries.ts'
import { sourceRoutesQuery, sourcesQuery } from '../sources/queries.ts'

/** What the form holds: a connection, one of its tools, and the arguments as the owner writes them. */
type Draft = { readonly connectionId: string; readonly tool: string; readonly args: string; readonly policy: string }

const EMPTY: Draft = { connectionId: '', tool: '', args: '{\n  "text": "{{text}}"\n}', policy: '{}' }

/** A sink as the form holds it. */
const draftOf = (sink: SinkDraft): Draft => ({
  connectionId: sink.connectionId,
  tool: sink.tool,
  args: JSON.stringify(sink.arguments, null, 2),
  policy: JSON.stringify({ result: sink.result, echo: sink.echo }, null, 2),
})

/**
 * A confirmed Source's reply, copied in: pick the Source, then the conversation the notices go to (its key fills the
 * reply's `{{key.…}}` values); the form takes its connection, tool and arguments.
 */
function CopyFromSource({ onCopy }: { readonly onCopy: (draft: Draft) => void }) {
  const sources = (useQuery(sourcesQuery).data?.sources ?? []).filter(
    (source) => source.state === 'active' && source.setup.reply !== undefined,
  )
  const [sourceId, setSourceId] = useState<string>()
  const source = sources.find((each) => each.id === sourceId)
  const routes = useQuery(sourceRoutesQuery(source?.id)).data?.routes ?? []
  if (sources.length === 0) return null
  return (
    <Field>
      <FieldLabel htmlFor="notify-copy">Copy a Source’s answers</FieldLabel>
      <span className="notify-copy">
        <NativeSelect
          id="notify-copy"
          size="sm"
          value={sourceId ?? ''}
          onChange={(event) => setSourceId(event.target.value === '' ? undefined : event.target.value)}
        >
          <NativeSelectOption value="">Choose a Source</NativeSelectOption>
          {sources.map((each) => (
            <NativeSelectOption key={each.id} value={each.id}>
              {each.title}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {source !== undefined && (
          <NativeSelect
            size="sm"
            aria-label="Which conversation notices go to"
            value=""
            onChange={(event) => {
              const values = routes.find((route) => route.key === event.target.value)?.values
              const sink = values === undefined ? undefined : sinkFromSource(source, values)
              if (sink !== undefined) onCopy(draftOf(sink))
            }}
          >
            <NativeSelectOption value="" disabled>
              {routes.length === 0 ? 'No conversation yet' : 'Send to the conversation…'}
            </NativeSelectOption>
            {routes.map((route) => (
              <NativeSelectOption key={route.key} value={route.key}>
                {keyWords(route.values)}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        )}
      </span>
      <FieldDescription>
        Fills the form with the tool that Source answers with, sent to that conversation.
      </FieldDescription>
    </Field>
  )
}

/** Which connected connection, and which of its tools; a tool the draft names is offered before its tools are read. */
function ToolFields({ draft, onChange }: { readonly draft: Draft; readonly onChange: (draft: Draft) => void }) {
  const connected = (useQuery(serversQuery).data ?? []).filter((server) => server.status === 'connected')
  const isConnected = connected.some((server) => server.connectionId === draft.connectionId)
  const tools = useQuery(connectedToolsQuery(draft.connectionId, isConnected)).data ?? []
  const names = [...new Set([...(draft.tool === '' ? [] : [draft.tool]), ...tools.map((tool) => tool.name)])]
  return (
    <>
      <Field>
        <FieldLabel htmlFor="notify-connection">Connection</FieldLabel>
        <NativeSelect
          id="notify-connection"
          value={draft.connectionId}
          onChange={(event) => onChange({ ...draft, connectionId: event.target.value, tool: '' })}
        >
          <NativeSelectOption value="" disabled>
            Choose a connection
          </NativeSelectOption>
          {connected.map((server) => (
            <NativeSelectOption key={server.connectionId} value={server.connectionId}>
              {server.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor="notify-tool">Tool</FieldLabel>
        <NativeSelect
          id="notify-tool"
          value={draft.tool}
          onChange={(event) => onChange({ ...draft, tool: event.target.value })}
        >
          <NativeSelectOption value="" disabled>
            Choose a tool
          </NativeSelectOption>
          {names.map((name) => (
            <NativeSelectOption key={name} value={name}>
              {name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
    </>
  )
}

/** The form: a connected connection, one of its tools, and the arguments; Save grants that tool and sets it. */
function SinkForm({ initial, onSaved }: { readonly initial: Draft; readonly onSaved: () => void }) {
  const [draft, setDraft] = useState(initial)
  const saving = useMutation(setNotifySinkMutation)
  const parsed = sinkArguments(draft.args, notifyPlaceholder)
  const policy = sinkPolicy(draft.policy)
  const problem = 'problem' in parsed ? parsed.problem : undefined
  const ready = draft.connectionId !== '' && draft.tool !== '' && problem === undefined && policy !== undefined
  function save(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    if (!('template' in parsed) || !ready || policy === undefined) return
    saving.mutate(
      { connectionId: draft.connectionId, tool: draft.tool, arguments: parsed.template, ...policy },
      { onSuccess: onSaved },
    )
  }
  return (
    <form onSubmit={save}>
      <FieldGroup>
        <CopyFromSource onCopy={setDraft} />
        <ToolFields draft={draft} onChange={setDraft} />
        <Field>
          <FieldLabel htmlFor="notify-arguments">Arguments</FieldLabel>
          <Textarea
            id="notify-arguments"
            spellCheck={false}
            value={draft.args}
            onChange={(event) => setDraft({ ...draft, args: event.target.value })}
          />
          <FieldDescription>
            {problem ??
              'JSON. Each notice’s words go where "{{text}}" is; "{{operationId}}" gives each one its own id. Nothing is put inside other text.'}
          </FieldDescription>
        </Field>
        <Field data-invalid={policy === undefined}>
          <FieldLabel htmlFor="notify-policy">Delivery and echo rules</FieldLabel>
          <Textarea
            id="notify-policy"
            spellCheck={false}
            aria-invalid={policy === undefined}
            value={draft.policy}
            onChange={(event) => setDraft({ ...draft, policy: event.target.value })}
          />
          <FieldDescription>
            {policy === undefined
              ? 'Use a JSON object with result rules and, optionally, an echo event and its arguments.'
              : 'Result rules compare a structured result pointer with a value: accepted, retryable, or rejected. Unmatched results stay unknown and are not retried. Echo names the exact event and arguments to keep from copying back.'}
          </FieldDescription>
        </Field>
        {saving.error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{messageOf(saving.error, 'set where notices go')}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" pending={saving.isPending} disabled={!ready}>
            Save
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

/** Where notices go now, with Change and Clear, or the form while none is set. */
function NotifySink() {
  const view = useSuspenseQuery(notifySinkQuery).data
  const clearing = useMutation(setNotifySinkMutation)
  const [editing, setEditing] = useState(false)
  if (view === null)
    return (
      <div className="card-body">
        <p className="text-sm text-muted-foreground">Not set: your notices stay in Activity.</p>
        <SinkForm initial={EMPTY} onSaved={() => setEditing(false)} />
      </div>
    )
  return (
    <div className="card-body">
      <p className="text-sm text-muted-foreground">
        Notices go to <strong>{view.label}</strong> with <code>{view.tool}</code>:
      </p>
      <JsonView value={{ arguments: view.arguments, result: view.result, echo: view.echo }} />
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
          {editing ? 'Keep it' : 'Change'}
        </Button>
        <Button variant="outline" size="sm" pending={clearing.isPending} onClick={() => clearing.mutate(null)}>
          Clear
        </Button>
      </div>
      {clearing.error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{messageOf(clearing.error, 'clear where notices go')}</AlertDescription>
        </Alert>
      )}
      {editing && <SinkForm initial={draftOf(view)} onSaved={() => setEditing(false)} />}
    </div>
  )
}

/** "Notify me via": the tool goblin sends the owner's notices with, through one of their connections. */
export function NotifySinkCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notify me via</CardTitle>
        <CardDescription>
          Choose how goblin sends notices to you, such as a message to your own chat. Routines marked “Also send” and
          apps use this destination. To choose which incoming events goblin listens for, open{' '}
          <Link to="/connections" className="underline underline-offset-2">
            Connections
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="read where notices go" pending={<Skeleton className="h-10 w-full" />}>
          <NotifySink />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
