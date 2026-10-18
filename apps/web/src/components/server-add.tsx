// Adding the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime
// (public https only) and labelled from the server's card; it starts disconnected and is connected like any other. The
// suggestions sit on a shelf in groups (ADR 0052): the owner's own apps through mysi, a service to publish with, then
// servers that need no sign-in by what they are for.
import { type SubmitEvent, useId, useState } from 'react'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import type { ServerGroup, ServerSuggestion, ServerView } from '@goblin/contracts'
import { InvalidInput } from '@goblin/contracts/api'
import { Button, Field, FieldDescription, FieldGroup, FieldLabel, Input } from '@goblin/ui'
import { addServerMutation, suggestedQuery } from '../mcp/queries.ts'
import { useAddAndConnect } from '../mcp/hooks.ts'
import { messageOf } from '../lib/query/app-error.ts'

/** Why the runtime refused an endpoint, in words the owner can act on. */
const REFUSED: Record<string, string> = {
  endpoint_not_https: 'Use an https:// address.',
  endpoint_not_public: 'That address is private or local; only public servers can be added.',
  endpoint_not_a_url: 'That is not a web address.',
  endpoint_invalid: 'Remove any user name, password or #fragment from the address.',
  too_many_servers: 'You have added thirty-two connections; remove one first.',
}
const refusal = (error: unknown): string | undefined =>
  error instanceof InvalidInput ? REFUSED[error.reason] : undefined

/** Add a server by its MCP endpoint, then connect it from its card. */
export function AddByAddress({
  onAdded,
  onMessage,
}: {
  readonly onAdded: (server: ServerView) => void
  readonly onMessage: (message: string) => void
}) {
  const [endpoint, setEndpoint] = useState('')
  const adding = useMutation(addServerMutation)
  function add(event: SubmitEvent<HTMLFormElement>): void {
    event.preventDefault()
    adding.mutate(
      { endpoint },
      {
        onSuccess: (server) => {
          setEndpoint('')
          onAdded(server)
        },
        onError: (error) => onMessage(refusal(error) ?? messageOf(error, 'add that server')),
      },
    )
  }
  return (
    <form onSubmit={add}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="server-address">The server's address</FieldLabel>
          <div className="address-row">
            <Input
              id="server-address"
              type="url"
              inputMode="url"
              placeholder="https://example.com/mcp"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              required
            />
            <Button type="submit" pending={adding.isPending} disabled={endpoint.trim() === ''}>
              Add
            </Button>
          </div>
          <FieldDescription>Any public MCP server. You connect it and choose its tools next.</FieldDescription>
        </Field>
      </FieldGroup>
    </form>
  )
}

/** The shelf keeps its useful groups, with one service from each in the compact preview. */
const GROUPS: readonly { readonly group: ServerGroup; readonly title: string }[] = [
  { group: 'yours', title: 'Your apps' },
  { group: 'publish', title: 'Publish' },
  { group: 'travel', title: 'Travel' },
  { group: 'knowledge', title: 'Knowledge' },
  { group: 'crypto', title: 'Crypto data' },
  { group: 'apps', title: 'Views in the chat' },
  { group: 'code', title: 'Code and docs' },
]

/** The provider's local mark, or an initial; its name is always written beside it. */
function ServerMark({ item, hue }: { readonly item: ServerSuggestion; readonly hue: number }) {
  const [broken, setBroken] = useState(false)
  const icon = broken ? undefined : item.icon
  return (
    <span className="server-mark" {...(icon === undefined && { 'data-hue': hue })} aria-hidden>
      {icon === undefined ? (
        Array.from(item.title)[0]
      ) : (
        <img src={icon} alt="" width={40} height={40} decoding="async" onError={() => setBroken(true)} />
      )}
    </span>
  )
}

/** One service: a mark, its purpose, and an explicit Add action. Rendering a card never grants access. */
function ServiceCard({
  item,
  group,
  hue,
  busy,
  onAdd,
}: {
  readonly item: ServerSuggestion
  readonly group: string
  readonly hue: number
  readonly busy: string
  readonly onAdd: (item: ServerSuggestion) => void
}) {
  return (
    <li className="shelf-service" data-group={item.group} {...(item.added && { 'data-added': true })}>
      <ServerMark item={item} hue={hue} />
      <div className="shelf-service-text">
        <h3>{item.title}</h3>
        <p>{item.description}</p>
      </div>
      <div className="shelf-service-foot">
        <span className="shelf-service-meta">
          {group}
          <span>{item.added ? 'Already added' : item.signIn ? 'Sign-in required' : 'No sign-in'}</span>
        </span>
        <Button
          size="cta"
          variant="ghost"
          disabled={busy !== '' && busy !== item.id}
          pending={busy === item.id}
          aria-label={`${item.added ? 'Add another' : 'Add'} ${item.title}`}
          onClick={() => onAdd(item)}
        >
          {!item.added && <PlusIcon data-icon="inline-start" aria-hidden />}
          {item.added ? 'Add another' : 'Add'}
        </Button>
      </div>
    </li>
  )
}

/**
 * A service shelf shared by Start and Connections. Connections previews one service per group so the owner's
 * existing connections remain within reach. The full catalogue keeps every service, including another account.
 */
export function SuggestedServers({
  onChanged,
  onMessage,
  connectWith,
  preview = false,
  goal,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
  readonly connectWith?: (item: ServerSuggestion) => Promise<string>
  readonly preview?: boolean
  readonly goal?: string
}) {
  const items = useSuspenseQuery(suggestedQuery).data
  const connect = useAddAndConnect()
  const [busy, setBusy] = useState('')
  const [expanded, setExpanded] = useState(false)
  const list = useId()
  async function add(item: ServerSuggestion): Promise<void> {
    setBusy(item.id)
    try {
      onChanged(await (connectWith?.(item) ?? connect(item.endpoint, item.title)))
    } catch (error) {
      onMessage(messageOf(error, `add ${item.title}`))
    } finally {
      setBusy('')
    }
  }
  if (items.length === 0)
    return <p className="server-note">Nothing to suggest right now. Search or add a server by its address.</p>
  const groups = GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.group === group.group) }))
  const suggestedGroups =
    goal === undefined
      ? undefined
      : /trip|travel|booking|holiday|flight|moving/iu.test(goal)
        ? ['travel', 'yours']
        : /research|learn|read|write|study/iu.test(goal)
          ? ['knowledge', 'code', 'yours']
          : ['yours', 'knowledge']
  const initialCount = groups.filter(
    (group) => group.items.length > 0 && (suggestedGroups === undefined || suggestedGroups.includes(group.group)),
  ).length
  return (
    <div className="shelf" data-preview={preview && !expanded}>
      <ul id={list} className="shelf-grid" aria-label="Suggested services" tabIndex={0}>
        {groups.flatMap((section) =>
          (preview && !expanded
            ? suggestedGroups === undefined || suggestedGroups.includes(section.group)
              ? section.items.slice(0, 1)
              : []
            : section.items
          ).map((item) => (
            <ServiceCard
              key={item.id}
              item={item}
              group={section.title}
              hue={items.indexOf(item) % 8}
              busy={busy}
              onAdd={(next) => void add(next)}
            />
          )),
        )}
      </ul>
      {preview && items.length > initialCount && (
        <div className="shelf-more">
          <Button
            size="cta"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={list}
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? 'Show fewer services' : `See all ${items.length} services`}
            <ChevronDownIcon data-icon="inline-end" aria-hidden />
          </Button>
        </div>
      )}
    </div>
  )
}
