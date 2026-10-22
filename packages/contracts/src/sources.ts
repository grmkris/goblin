// Sources (ADR 0066): any MCP server that sends events can carry the owner's own messages into goblin, and goblin's
// answers back. A Source is the owner's confirmed setup of five facts on one connection (what wakes it, how a
// conversation is keyed, which messages are the owner speaking, how the content is read, how an answer goes back) and a
// route for each conversation key. Nothing here names a server: the facts are JSON pointers and argument templates.
import * as Schema from 'effect/Schema'
import { NonEmptyString, OperationId, PersonaId, TopicId } from './ids.ts'

/**
 * An RFC 6901 JSON pointer into an event's data or a tool's result: empty (the whole value) or `/`-separated tokens,
 * `~0` for `~` and `~1` for `/`; at most 256 characters.
 */
export const JsonPointer = Schema.String.check(Schema.isMaxLength(256), Schema.isPattern(/^(?:\/(?:[^~/]|~[01])*)*$/u))
export type JsonPointer = typeof JsonPointer.Type

/** The name of one part of a conversation key: a lowercase letter, then lowercase letters, digits or `_`. */
export const SourceKeyName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,31}$/u))

/** A tool's or an event's name on the server. */
const RemoteName = NonEmptyString(256)

/** A plain value a pointer's value is compared with, or a key part holds. */
export const SourceScalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])
export type SourceScalar = typeof SourceScalar.Type

/** How a template names what goes into it: `{{text}}`, `{{operationId}}`, `{{cursor}}` or `{{key.<name>}}`. */
const PLACEHOLDER = /^\{\{(text|operationId|cursor|key\.[a-z][a-z0-9_]{0,31})\}\}$/u

/** How deep a template may nest and how long it may be as JSON. */
const TEMPLATE_DEPTH = 8
const TEMPLATE_LENGTH = 4096

/**
 * The placeholders a template's string leaves name, in order (`text`, `key.chat`, …); a string that holds `{{` and is
 * not one whole placeholder is `invalid` (goblin never fills text inside a string).
 */
export function placeholdersOf(template: unknown, depth = 0): readonly string[] | 'invalid' {
  if (depth > TEMPLATE_DEPTH) return 'invalid'
  if (typeof template === 'string') {
    if (!template.includes('{{')) return []
    const match = PLACEHOLDER.exec(template)
    return match?.[1] === undefined ? 'invalid' : [match[1]]
  }
  const children = Array.isArray(template)
    ? template
    : typeof template === 'object' && template !== null
      ? Object.values(template)
      : []
  const found: string[] = []
  for (const child of children) {
    const named = placeholdersOf(child, depth + 1)
    if (named === 'invalid') return 'invalid'
    found.push(...named)
  }
  return found
}

/**
 * A template with each whole-leaf placeholder `values` names replaced by its value; an entry whose value is `undefined`
 * is left out of its object. A placeholder `values` does not name stays as it is.
 */
export function fillTemplate(template: unknown, values: Readonly<Record<string, unknown>>): unknown {
  if (typeof template === 'string') {
    const name = PLACEHOLDER.exec(template)?.[1]
    return name !== undefined && name in values ? values[name] : template
  }
  if (Array.isArray(template)) return template.map((item) => fillTemplate(item, values))
  if (typeof template !== 'object' || template === null) return template
  const filled: Record<string, unknown> = {}
  for (const [field, value] of Object.entries(template)) {
    const next = fillTemplate(value, values)
    if (next !== undefined) filled[field] = next
  }
  return filled
}

/**
 * Why a template's placeholders are not what its use allows (`allowed`), or none. Every placeholder is a whole string
 * leaf; `required` ones must appear.
 */
export function templateProblem(
  template: Readonly<Record<string, unknown>>,
  allowed: (placeholder: string) => boolean,
  required: readonly string[] = [],
): string | undefined {
  if (JSON.stringify(template).length > TEMPLATE_LENGTH) return 'The arguments are too long.'
  const named = placeholdersOf(template)
  if (named === 'invalid') return 'A placeholder must be a whole string value, like "{{text}}".'
  const unknown = named.find((name) => !allowed(name))
  if (unknown !== undefined) return `{{${unknown}}} cannot be used here.`
  const missing = required.find((name) => !named.includes(name))
  return missing === undefined ? undefined : `The arguments must use {{${missing}}}.`
}

/** A tool's arguments with whole-leaf placeholders; checked for each use by `templateProblem`. */
export const ArgumentsTemplate = Schema.Record(Schema.String, Schema.Json)
export type ArgumentsTemplate = typeof ArgumentsTemplate.Type

/** A pointer's value compared with a plain value: the item matches when they are equal. */
export const SourceMatch = Schema.Struct({ pointer: JsonPointer, equals: SourceScalar })
export type SourceMatch = typeof SourceMatch.Type

/** 1. What wakes a Source: one event of the connection, with the arguments it is subscribed with. */
export const SourceWake = Schema.Struct({ event: RemoteName, arguments: Schema.Record(Schema.String, Schema.Json) })
export type SourceWake = typeof SourceWake.Type

/** One part of a conversation key: its name and where its value is in a message (`chat: /chat`). */
export const SourceKeyPart = Schema.Struct({ name: SourceKeyName, pointer: JsonPointer })
export type SourceKeyPart = typeof SourceKeyPart.Type

/** 2. How a conversation is keyed: one to four named parts, each a pointer into a message. */
export const SourceKey = Schema.Array(SourceKeyPart).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4),
  Schema.makeFilter(
    (parts) => new Set(parts.map(({ name }) => name)).size === parts.length || 'Each key part needs its own name.',
  ),
)

/** 3. Which messages are the owner speaking: all of them, or those whose value at `pointer` equals `equals`. */
export const SpeaksForMe = Schema.Union([Schema.Struct({ all: Schema.Literal(true) }), SourceMatch])
export type SpeaksForMe = typeof SpeaksForMe.Type

/** What becomes of a message that is not the owner's: an untrusted notice to the owner, or nothing. */
export const SourceOthers = Schema.Literals(['notice', 'drop'])
export type SourceOthers = typeof SourceOthers.Type

/**
 * Where a message's parts are: its id (for a message read again), its words, its conversation's name, what it brought
 * and what marks it incoming.
 */
const MessagePointers = {
  /** The message's own id; without it, an event's message is known by the event's id. */
  id: Schema.optionalKey(JsonPointer),
  /** The message's words. */
  text: JsonPointer,
  /**
   * Its conversation's name as the server gives it (a chat's title): shown on the conversation's route and given to a
   * Topic made for it. The newest one a message carries wins.
   */
  title: Schema.optionalKey(JsonPointer),
  /**
   * What the message brought: a list of MCP content blocks (`resource_link`, `image`, `resource`, `audio`), shaped as a
   * tool result's content is. goblin keeps each one in the owner's files (ADR 0065) and the turn names the files.
   */
  attachments: Schema.optionalKey(JsonPointer),
  /** Only messages whose value here equals this are read (an inbox that lists sent messages too). */
  direction: Schema.optionalKey(SourceMatch),
}

/**
 * 4. How the content is read: from the event's data (`items` points at a list of messages, else the data is one), or
 * by calling a tool that reads from a cursor (`arguments` places `{{cursor}}`; `items` points at the messages of its
 * result, `cursor` at the cursor to read from next, and each message needs its `id`).
 */
export const SourceRead = Schema.Union([
  Schema.Struct({ from: Schema.Literal('payload'), items: Schema.optionalKey(JsonPointer), ...MessagePointers }),
  Schema.Struct({
    from: Schema.Literal('tool'),
    tool: RemoteName,
    arguments: ArgumentsTemplate,
    items: JsonPointer,
    cursor: JsonPointer,
    ...MessagePointers,
    id: JsonPointer,
  }),
])
export type SourceRead = typeof SourceRead.Type

/** The owner-reviewed meanings of a tool's structured result. Unmatched or conflicting rules mean unknown. */
export const SinkResultRules = Schema.Struct({
  accepted: SourceMatch,
  retryable: Schema.optionalKey(SourceMatch),
  rejected: Schema.optionalKey(SourceMatch),
  /** An epoch-millisecond lower bound on the next attempt, only read after a retryable match. */
  retryAt: Schema.optionalKey(JsonPointer),
})
export type SinkResultRules = typeof SinkResultRules.Type

/** The longest piece of an answer a reply may be cut to, and the shortest. */
const MAX_CHARS = { minimum: 100, maximum: 20_000 }

/**
 * 5. How an answer goes back: a tool called once a piece (`{{text}}`), each piece at most `maxChars` long, with its own
 * `{{operationId}}`, to the conversation the message came from (`{{key.<name>}}`).
 */
export const SourceReply = Schema.Struct({
  tool: RemoteName,
  arguments: ArgumentsTemplate,
  maxChars: Schema.Int.check(Schema.isBetween(MAX_CHARS)),
  /** Owner-reviewed meanings of the reply tool's structured result; unmatched results are unknown. */
  result: Schema.optionalKey(SinkResultRules),
})
export type SourceReply = typeof SourceReply.Type

const ToTopic = Schema.Struct({ to: Schema.Literal('topic'), topic: TopicId })
const ToPersona = Schema.Struct({ to: Schema.Literal('persona'), persona: PersonaId, topic: TopicId })
const ToListen = Schema.Struct({ to: Schema.Literal('listen'), topic: TopicId })
const ToIgnore = Schema.Struct({ to: Schema.Literal('ignore') })
const ToHeld = Schema.Struct({ to: Schema.Literal('held') })

/**
 * Where one conversation's owner messages go: turns in a Topic answered by goblin (`topic`) or by a Persona there
 * (`persona`), passive notes in a Topic with no turn (`listen`), nothing (`ignore`), or kept until the owner routes it
 * (`held`).
 */
export const SourceRoute = Schema.Union([ToTopic, ToPersona, ToListen, ToIgnore, ToHeld])
export type SourceRoute = typeof SourceRoute.Type

/**
 * What becomes of a conversation seen for the first time: a route, or a new Topic of its own answered by goblin
 * (`topic-per-key`), named after the conversation's title, else its key's values.
 */
export const SourceNewKeys = Schema.Union([
  ToTopic,
  ToPersona,
  ToListen,
  ToIgnore,
  ToHeld,
  Schema.Struct({ to: Schema.Literal('topic-per-key') }),
])
export type SourceNewKeys = typeof SourceNewKeys.Type

/** The placeholders a read's tool arguments may use. */
export const readPlaceholder = (name: string) => name === 'cursor'

/** The placeholders a reply's arguments may use, with `parts` the key's part names. */
export const replyPlaceholder = (parts: readonly { readonly name: string }[]) => (name: string) =>
  name === 'text' || name === 'operationId' || parts.some((part) => name === `key.${part.name}`)

/** Why a setup's templates do not hold, or none. */
const setupProblem = (setup: {
  readonly key: readonly SourceKeyPart[]
  readonly read: SourceRead
  readonly reply?: SourceReply | undefined
}): string | undefined =>
  (setup.read.from === 'tool' ? templateProblem(setup.read.arguments, readPlaceholder, ['cursor']) : undefined) ??
  (setup.reply === undefined
    ? undefined
    : templateProblem(setup.reply.arguments, replyPlaceholder(setup.key), ['text']))

/**
 * A Source's setup (ADR 0066): the five facts (`wake`, `key`, `speaksForMe` with `others`, `read`, `reply`) and what
 * becomes of a conversation key seen for the first time (`newKeys`). Templates use whole-leaf placeholders only.
 */
export const SourceSetup = Schema.Struct({
  wake: SourceWake,
  key: SourceKey,
  speaksForMe: SpeaksForMe,
  others: SourceOthers,
  read: SourceRead,
  reply: Schema.optionalKey(SourceReply),
  newKeys: SourceNewKeys,
}).check(Schema.makeFilter((setup) => setupProblem(setup) ?? true))
export type SourceSetup = typeof SourceSetup.Type

/** A Source's id: `src_` and 16 to 32 lowercase hex digits. */
export const SourceId = Schema.String.check(Schema.isPattern(/^src_[0-9a-f]{16,32}$/u))
export type SourceId = typeof SourceId.Type

/** A Source's name for the owner: what the proposal called it. */
export const SourceTitle = NonEmptyString(80)

/**
 * A conversation key as goblin keeps it: the JSON of its parts' values in the setup's order (`["dm"]`), at most 512
 * characters.
 */
export const SourceKeyId = Schema.String.check(Schema.isMinLength(2), Schema.isMaxLength(512))
export type SourceKeyId = typeof SourceKeyId.Type

/** A conversation key's values by part name. */
export const SourceKeyValues = Schema.Record(Schema.String, SourceScalar)
export type SourceKeyValues = typeof SourceKeyValues.Type

/**
 * What the owner confirmed a Source against: the connection's endpoint and a digest of the grants of its read and reply
 * tools. A change of either pauses the Source for the owner to review.
 */
export const SourceBound = Schema.Struct({ endpoint: Schema.String, grantVersion: Schema.String })
export type SourceBound = typeof SourceBound.Type

/**
 * Where a Source stands: `proposed` until the owner confirms its exact revision (or `refused`), `active` once its
 * event is subscribed, `paused` by the owner or for their review (its endpoint or grants changed, or its subscription
 * ended and could not be made again).
 */
export const SourceState = Schema.Literals(['proposed', 'active', 'paused', 'refused'])
export type SourceState = typeof SourceState.Type

/** A conversation waiting for the owner's route: its key, its values, its title and how many messages it holds. */
export const SourceWaiting = Schema.Struct({
  key: SourceKeyId,
  values: SourceKeyValues,
  title: Schema.optional(Schema.String),
  held: Schema.Int,
})
export type SourceWaiting = typeof SourceWaiting.Type

/**
 * One Source as the owner sees it: its connection (by the owner's label), its name, its setup at `revision`, where it
 * stands and why (`paused`, `health`), what it was confirmed against, and the conversations waiting for a route (at most
 * twenty). Times are epoch seconds.
 */
export const SourceView = Schema.Struct({
  id: SourceId,
  connectionId: Schema.String,
  label: Schema.String,
  title: Schema.String,
  setup: SourceSetup,
  revision: Schema.Int,
  state: SourceState,
  paused: Schema.optional(Schema.Literals(['owner', 'review'])),
  health: Schema.optional(Schema.String),
  bound: Schema.optional(SourceBound),
  waiting: Schema.Array(SourceWaiting),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
  confirmedAt: Schema.optional(Schema.Number),
})
export type SourceView = typeof SourceView.Type

/** `GET /api/sources`: every Source, newest first. */
export const SourcePage = Schema.Struct({ sources: Schema.Array(SourceView) })
export type SourcePage = typeof SourcePage.Type

/**
 * One conversation of a Source and where it goes: its key and values, its title (the server's name for it, by the
 * setup's `read.title`), its route, how many messages it holds, and who set the route last (`default` for the setup's
 * `newKeys`). `revision` counts route changes, so Undo can tell whether anything touched it.
 */
export const SourceRouteView = Schema.Struct({
  key: SourceKeyId,
  values: SourceKeyValues,
  title: Schema.optional(Schema.String),
  route: SourceRoute,
  held: Schema.Int,
  revision: Schema.Int,
  updatedBy: Schema.optional(Schema.Literals(['owner', 'agent', 'default'])),
  createdAt: Schema.Number,
  updatedAt: Schema.Number,
})
export type SourceRouteView = typeof SourceRouteView.Type

/** `GET /api/sources/:id/routes`: a Source and its conversations, the newest first. */
export const SourceRoutes = Schema.Struct({ source: SourceView, routes: Schema.Array(SourceRouteView) })
export type SourceRoutes = typeof SourceRoutes.Type

/**
 * A proposal of a Source on `connectionId`, as the agent's `source_propose` makes it (ADR 0068: no server suggests
 * one); the same operation finds the same proposal. Nothing runs until the owner confirms its revision.
 */
export const SourceProposal = Schema.Struct({
  connectionId: NonEmptyString(200),
  title: SourceTitle,
  setup: SourceSetup,
  operationId: OperationId,
})
export type SourceProposal = typeof SourceProposal.Type

/** The exact revision of a Source the owner confirms or refuses. */
export const SourceRevision = Schema.Struct({ revision: Schema.Int })
export type SourceRevision = typeof SourceRevision.Type

/** Editing reply-result rules creates a new proposal for the owner to confirm; null clears the rules. */
export const SourceReplyResultChange = Schema.Struct({ revision: Schema.Int, result: Schema.NullOr(SinkResultRules) })
export type SourceReplyResultChange = typeof SourceReplyResultChange.Type

/** The placeholders a notice copy's arguments may use. */
export const notifyPlaceholder = (name: string) => name === 'text' || name === 'operationId'

/** Optional settings for interpreting delivery and suppressing an exact stream's echoes on this connection. */
export const NotifySinkPolicy = Schema.Struct({
  result: Schema.optionalKey(SinkResultRules),
  echo: Schema.optionalKey(SourceWake),
})
export type NotifySinkPolicy = typeof NotifySinkPolicy.Type

const NotifySinkFields = {
  connectionId: NonEmptyString(200),
  tool: RemoteName,
  arguments: ArgumentsTemplate,
  ...NotifySinkPolicy.fields,
}

/**
 * "Notify me via" (ADR 0066): one tool of one connection that copies goblin's notices to the owner elsewhere (their own
 * chat on a messaging server), its arguments with `{{text}}` (required) and `{{operationId}}` as whole string values.
 */
export const NotifySink = Schema.Struct(NotifySinkFields).check(
  Schema.makeFilter((sink) => templateProblem(sink.arguments, notifyPlaceholder, ['text']) ?? true),
)
export type NotifySink = typeof NotifySink.Type

/** `GET /api/notify-sink`: the setting with its connection's label and when it was set (epoch seconds), or null. */
export const NotifySinkView = Schema.NullOr(
  Schema.Struct({ ...NotifySinkFields, label: Schema.String, updatedAt: Schema.Number }),
)
export type NotifySinkView = typeof NotifySinkView.Type

/** `PUT /api/sources/:id/routes`: where one conversation goes now. */
export const SourceRoutePick = Schema.Struct({ key: SourceKeyId, route: SourceRoute })
export type SourceRoutePick = typeof SourceRoutePick.Type
