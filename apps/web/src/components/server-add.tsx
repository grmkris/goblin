// Adding the owner's own MCP servers, by URL or from the servers we suggest. A pasted URL is checked by the runtime
// (public https only) and labelled from the server's card; it starts disconnected and is connected like any other. The
// suggestions sit on a shelf in groups (ADR 0052): the owner's own apps through mysi, a service to publish with, then
// servers that need no sign-in by what they are for.
import { type SubmitEvent, useId, useState } from 'react'
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

/**
 * The shelf's groups in the order it shows them, each under its name. `wide`: from how many columns the tile spans two
 * (styles.css): with three, the owner's own apps lead beside Publish; from two, the long code list sets its servers side
 * by side under the rest.
 */
const GROUPS: readonly { readonly group: ServerGroup; readonly title: string; readonly wide?: 'two' | 'three' }[] = [
  { group: 'yours', title: 'Your apps', wide: 'three' },
  { group: 'publish', title: 'Publish' },
  { group: 'travel', title: 'Travel' },
  { group: 'knowledge', title: 'Knowledge' },
  { group: 'crypto', title: 'Crypto data' },
  { group: 'apps', title: 'Views in the chat' },
  { group: 'code', title: 'Code and docs', wide: 'two' },
]

/** How many plate hues an initial may take (`.server-mark[data-hue]` in styles.css), the first goblin's moss. */
const HUES = 8
/** Initials take the hues in shelf order, so neighbours in a tile never share one. */
function huesOf(items: readonly ServerSuggestion[]): ReadonlyMap<string, number> {
  return new Map(items.filter((item) => item.icon === undefined).map((item, index) => [item.id, index % HUES]))
}

/**
 * The provider's mark, from the deployment's own files, or the server's initial on a plate of its own hue. Decorative:
 * its name always shows beside it.
 */
function ServerMark({
  item,
  hue,
  size,
}: {
  readonly item: ServerSuggestion
  readonly hue: number
  readonly size: 'row' | 'feature'
}) {
  const [broken, setBroken] = useState(false)
  const icon = broken ? undefined : item.icon
  return (
    <span className="server-mark" data-size={size} {...(icon === undefined && { 'data-hue': hue })} aria-hidden>
      {icon === undefined ? (
        Array.from(item.title)[0]
      ) : (
        <img src={icon} alt="" width={40} height={40} decoding="async" onError={() => setBroken(true)} />
      )}
    </span>
  )
}

/** Add, or Add another once the owner has it (another account, ADR 0041). */
function AddButton({
  item,
  busy,
  strong,
  onAdd,
}: {
  readonly item: ServerSuggestion
  /** Which suggestion is being added, if one is. */
  readonly busy: string
  /** The tile's one action: the filled button, while the owner does not have it yet. */
  readonly strong: boolean
  readonly onAdd: (item: ServerSuggestion) => void
}) {
  return (
    <Button
      size="sm"
      variant={strong && !item.added ? 'default' : 'outline'}
      disabled={busy !== '' && busy !== item.id}
      pending={busy === item.id}
      aria-label={`${item.added ? 'Add another' : 'Add'} ${item.title}`}
      onClick={() => onAdd(item)}
    >
      {item.added ? 'Add another' : 'Add'}
    </Button>
  )
}

/** Whether it needs a sign-in, said where its tile does not already say it for all of them. */
const signInNote = (item: ServerSuggestion) => (item.signIn ? 'Needs sign-in' : 'No sign-in')

/** One suggestion in a tile of several: its mark, what it is in our words, and Add. */
function SuggestionRow({
  item,
  hue,
  note,
  busy,
  onAdd,
}: {
  readonly item: ServerSuggestion
  readonly hue: number
  readonly note: boolean
  readonly busy: string
  readonly onAdd: (item: ServerSuggestion) => void
}) {
  return (
    <li className="shelf-row" {...(item.added && { 'data-added': true })}>
      <ServerMark item={item} hue={hue} size="row" />
      <span className="grant-name">{item.title}</span>
      <AddButton item={item} busy={busy} strong={false} onAdd={onAdd} />
      <span className="shelf-row-about">
        <span className="grant-about">{item.description}</span>
        {note && <span className="pick-meta">{signInNote(item)}</span>}
      </span>
    </li>
  )
}

/**
 * Servers we suggest, checked to work from here, as a bento of their groups: a group of one is a feature tile (the
 * owner's own apps lead, wide), the others list their servers. One tap adds and connects. A tile whose servers all need
 * no sign-in says so once. One the owner already has can be connected again, as another account (ADR 0041). The grid
 * follows its own width (container queries), so it fits Start's page and the Connections picker alike. It suspends
 * until the suggestions are read.
 */
export function SuggestedServers({
  onChanged,
  onMessage,
  connectWith,
}: {
  readonly onChanged: (message: string) => void
  readonly onMessage: (message: string) => void
  /** How to add and sign in to a suggestion, when a page brings the owner back somewhere of its own (Start). */
  readonly connectWith?: (item: ServerSuggestion) => Promise<string>
}) {
  const items = useSuspenseQuery(suggestedQuery).data
  const connect = useAddAndConnect()
  const [busy, setBusy] = useState('')
  const heading = useId()
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
  if (items.length === 0) return <p className="server-note">Nothing to suggest right now.</p>
  const shelf = GROUPS.map((group) => ({ ...group, items: items.filter((item) => item.group === group.group) })).filter(
    (section) => section.items.length > 0,
  )
  const onAdd = (item: ServerSuggestion) => void add(item)
  const hues = huesOf(items)
  return (
    <div className="shelf">
      <div className="shelf-grid">
        {shelf.map((section) => (
          <ShelfTile
            key={section.group}
            section={section}
            id={`${heading}-${section.group}`}
            hues={hues}
            busy={busy}
            onAdd={onAdd}
          />
        ))}
      </div>
    </div>
  )
}

/** One group's tile: a group of one as a feature (its server large, its one action under it), else a list of rows. */
function ShelfTile({
  section,
  id,
  hues,
  busy,
  onAdd,
}: {
  readonly section: (typeof GROUPS)[number] & { readonly items: readonly ServerSuggestion[] }
  /** Its heading's id, which names the tile. */
  readonly id: string
  readonly hues: ReadonlyMap<string, number>
  readonly busy: string
  readonly onAdd: (item: ServerSuggestion) => void
}) {
  const open = section.items.every((item) => !item.signIn)
  const [only] = section.items
  const feature = section.items.length === 1 && only !== undefined
  return (
    <section
      className="shelf-tile"
      data-group={section.group}
      {...(section.wide !== undefined && { 'data-wide': section.wide })}
      aria-labelledby={id}
    >
      <div className="shelf-head">
        <h3 id={id} className="shelf-title">
          {section.title}
        </h3>
        {(open || feature) && <span className="pick-meta">{feature ? signInNote(only) : 'No sign-in'}</span>}
      </div>
      {feature ? (
        <div className="shelf-feature" {...(only.added && { 'data-added': true })}>
          <ServerMark item={only} hue={hues.get(only.id) ?? 0} size="feature" />
          <span className="grant-text">
            <span className="shelf-feature-name">{only.title}</span>
            <span className="grant-about">{only.description}</span>
          </span>
          <AddButton item={only} busy={busy} strong={section.group === 'yours'} onAdd={onAdd} />
        </div>
      ) : (
        <ul className="shelf-rows">
          {section.items.map((item) => (
            <SuggestionRow
              key={item.id}
              item={item}
              hue={hues.get(item.id) ?? 0}
              note={!open}
              busy={busy}
              onAdd={onAdd}
            />
          ))}
        </ul>
      )}
    </section>
  )
}
