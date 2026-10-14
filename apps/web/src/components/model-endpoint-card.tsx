// The Settings card for where the agent's model calls go (ADR 0059): the deployment's models, or the owner's own
// OpenAI-compatible endpoint and key. The key is written once and never read back; the card shows its last characters.
import { type SubmitEvent, useState } from 'react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { ModelEndpointView } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
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
  Input,
  Skeleton,
} from '@goblin/ui'
import { changeModelEndpointMutation, modelEndpointQuery } from '../agent/queries.ts'
import { messageOf } from '../lib/query/app-error.ts'
import { QueryBoundary } from '../lib/query/query-boundary.tsx'

/** Why the runtime refused an endpoint, in words the owner can act on. */
const REFUSED: Record<string, string> = {
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local; only public endpoints can be used.',
  endpoint_not_a_url: 'That is not a web address.',
  endpoint_invalid: 'Remove any user name, password or #fragment from the address.',
  model_endpoint_unreachable: 'That endpoint could not be reached.',
  model_key_refused: 'The endpoint refused that key.',
  model_endpoint_refused: 'The endpoint would not list its models. Check the address ends where its /models is.',
  model_list_unreadable: "The endpoint's answer was not a list of models.",
  model_list_too_large: "The endpoint's list of models is too large.",
  model_list_empty: 'The endpoint lists no models for that key.',
}
const refusal = (error: unknown): string | undefined =>
  error instanceof InvalidInput ? REFUSED[error.reason] : undefined

/** The owner's own endpoint and key; saving it lists its models first, so a wrong address or key is refused here. */
function EndpointForm({ onSaved }: { readonly onSaved: () => void }) {
  const [baseUrl, setBaseUrl] = useState('')
  const [key, setKey] = useState('')
  const saving = useMutation(changeModelEndpointMutation)
  function save(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    saving.mutate(
      { baseUrl: baseUrl.trim(), key: key.trim() },
      {
        onSuccess: () => {
          setKey('')
          onSaved()
        },
      },
    )
  }
  const failure =
    saving.error === null ? '' : (refusal(saving.error) ?? messageOf(saving.error, 'use that model endpoint'))
  return (
    <form onSubmit={save}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="model-endpoint">Endpoint</FieldLabel>
          <Input
            id="model-endpoint"
            type="url"
            inputMode="url"
            placeholder="https://api.example.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            required
          />
          <FieldDescription>Any OpenAI-compatible API: LiteLLM, OpenRouter, OpenAI and the like.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="model-key">Key</FieldLabel>
          <Input
            id="model-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            required
          />
          <FieldDescription>Kept sealed in your agent and never shown again.</FieldDescription>
        </Field>
        {failure !== '' && (
          <Alert variant="destructive">
            <AlertDescription>{failure}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button type="submit" pending={saving.isPending} disabled={baseUrl.trim() === '' || key.trim() === ''}>
            Use this endpoint
          </Button>
        </div>
      </FieldGroup>
    </form>
  )
}

/** How many models the endpoint serves, in words. */
const served = (view: ModelEndpointView): string =>
  view.models.length === 1 ? '1 model' : `${String(view.models.length)} models`

function Endpoint() {
  const view = useSuspenseQuery(modelEndpointQuery).data
  const remove = useMutation(changeModelEndpointMutation)
  const [editing, setEditing] = useState(false)
  if (view.source === 'deployment')
    return (
      <div className="card-body">
        <p className="text-sm text-muted-foreground">Your agent uses this deployment's {served(view)}.</p>
        <EndpointForm onSaved={() => setEditing(false)} />
      </div>
    )
  const failure = remove.error === null ? '' : messageOf(remove.error, "go back to this deployment's models")
  return (
    <div className="card-body">
      <p className="text-sm text-muted-foreground">
        Your agent uses <code>{view.baseUrl}</code> with the key ending <code>{view.keyHint}</code>: {served(view)}.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => setEditing(!editing)}>
          {editing ? 'Keep this endpoint' : 'Change'}
        </Button>
        <Button variant="outline" size="sm" pending={remove.isPending} onClick={() => remove.mutate(null)}>
          Use this deployment's models
        </Button>
      </div>
      {failure !== '' && (
        <Alert variant="destructive">
          <AlertDescription>{failure}</AlertDescription>
        </Alert>
      )}
      {editing && <EndpointForm onSaved={() => setEditing(false)} />}
    </div>
  )
}

/** Where the agent's model calls go: the deployment's models, or the owner's own endpoint and key. */
export function ModelEndpointCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Model</CardTitle>
        <CardDescription>
          Bring your own model: your agent sends every model call to your endpoint with your key, and the models it
          lists are the ones you pick from. Without one, it uses the models this deployment offers.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <QueryBoundary action="read where your model calls go" pending={<Skeleton className="h-10 w-full" />}>
          <Endpoint />
        </QueryBoundary>
      </CardContent>
    </Card>
  )
}
