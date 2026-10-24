import * as Schema from 'effect/Schema'
import { ReceivedFiles } from './files.ts'
import { ChatId, EntryId, NonEmptyString, OperationId, TopicId } from './ids.ts'
import { Attention } from './threads.ts'
import { PlainSend, RunInput, runInput } from './agui/run-input.ts'

/** Stable primary chat id for URLs and application metadata; its current Pi session is resolved by the runtime. */
export const PRIMARY_CHAT = '1'

/** The chat kinds: the primary `main`, a side `thread` the owner branched or started, a `subagent`. */
export const ConversationKind = Schema.Literals(['main', 'thread', 'subagent'])
export type ConversationKind = typeof ConversationKind.Type

/**
 * An MCP server a server's key declares on one of its threads (ADR 0103): `name` is what its tools are called by in the
 * thread's Persona forks (`<name>__<tool>`, ADR 0101), `url` its Streamable HTTP endpoint on an origin the owner granted
 * the key (ADR 0091), `token` the bearer it is called with, and `tools` the ones of that origin's list it may call (all
 * of them when absent). The token is kept encrypted and never answered back.
 */
export const ThreadServer = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-z](?:[a-z0-9-]|_(?!_)){0,19}$/u)),
  url: NonEmptyString(2048),
  token: NonEmptyString(4096),
  tools: Schema.optional(Schema.Array(NonEmptyString(256)).check(Schema.isMinLength(1), Schema.isMaxLength(50))),
})
export type ThreadServer = typeof ThreadServer.Type

/** A thread's declared server as it is answered: its name, endpoint and tools, never its token. */
export const ThreadServerView = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  tools: Schema.Array(Schema.String),
})
export type ThreadServerView = typeof ThreadServerView.Type

/** At most this many servers on one thread. */
export const MAX_THREAD_SERVERS = 4

/** A thread's declared servers: at most {@link MAX_THREAD_SERVERS}, each name once. */
export const ThreadServers = Schema.Array(ThreadServer).check(
  Schema.isMaxLength(MAX_THREAD_SERVERS),
  Schema.makeFilter((servers) => new Set(servers.map((server) => server.name)).size === servers.length),
)

/**
 * A conversation of the agent the owner can open. `parent` is the conversation it came from: the one a thread branched
 * from (or main for one started empty) and the spawner of a subagent; only main has none. `forkEntry` is the entry of
 * the parent a thread branched at. `replies` are the messages written in it (the owner's and the agent's, not the
 * history it inherited) and `lastReplyAt` when the newest was. A closed conversation (`closedAt`, by the owner or
 * `done` after a subagent's last report) stays readable and reopens; `keepOpen` stops a subagent closing itself.
 * Times are in seconds. Whether it is working right now is not here: the workspace feed carries that.
 */
export const ConversationView = Schema.Struct({
  id: Schema.String,
  primary: Schema.optional(Schema.Boolean),
  kind: ConversationKind,
  title: Schema.optional(Schema.String),
  parent: Schema.optional(Schema.String),
  forkEntry: Schema.optional(Schema.Number),
  createdAt: Schema.Number,
  closedAt: Schema.optional(Schema.Number),
  closedBy: Schema.optional(Schema.Literals(['owner', 'done'])),
  keepOpen: Schema.Boolean,
  replies: Schema.Number,
  lastReplyAt: Schema.optional(Schema.Number),
  /** When the owner last saw the newest reply (seconds): a later `lastReplyAt` is unread. */
  readAt: Schema.optional(Schema.Number),
  /** The Topic it belongs to (Personal when absent, from a server older than Topics). */
  topic: Schema.optional(TopicId),
  /** It is its Topic's one Conversation (a channel), not a Thread. */
  conversation: Schema.optional(Schema.Boolean),
  /** What in it waits for the owner (questions, approvals, grants), for Activity. */
  attention: Schema.optional(Schema.Array(Attention)),
  /** A Thread a running or finished turn was moved into: the chat it left and the move's operation id. */
  movedFrom: Schema.optional(Schema.Struct({ chat: ChatId, operationId: Schema.String })),
  /** The MCP servers a key declared on it (ADR 0103), answered to the thread operation and its change. */
  mcpServers: Schema.optional(Schema.Array(ThreadServerView)),
})
export type ConversationView = typeof ConversationView.Type

/**
 * Rename, close or reopen (with everything under it), or pin a subagent open. A key may also replace its thread's
 * declared MCP servers as a whole (ADR 0103): `set` is every server it has from then on (`[]` removes them all), and
 * the same `operationId` changes them once.
 */
export const UpdateConversation = Schema.Struct({
  title: Schema.optional(NonEmptyString(120)),
  closed: Schema.optional(Schema.Boolean),
  keepOpen: Schema.optional(Schema.Boolean),
  mcpServers: Schema.optional(Schema.Struct({ operationId: OperationId, set: ThreadServers })),
})
export type UpdateConversation = typeof UpdateConversation.Type

/**
 * What a conversation's agent is doing: `working` on a run, `waiting` with only its subagents at work, or `idle`.
 * `since` (milliseconds) is when that began.
 */
export const ConversationActivity = Schema.Struct({
  id: Schema.String,
  state: Schema.Literals(['idle', 'working', 'waiting']),
  since: Schema.Number,
})
export type ConversationActivity = typeof ConversationActivity.Type

/**
 * One question the agent asks the owner with `ask_user`. A choice question (`single`, `multi`) offers 2 to 8 options;
 * `allowOther` adds a free answer. The tool result's details are `{ kind: 'question', questions }`.
 */
export const QuestionOption = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  description: Schema.optional(Schema.String),
})
export const QuestionSpec = Schema.Struct({
  id: Schema.String,
  prompt: Schema.String,
  kind: Schema.Literals(['single', 'multi', 'text']),
  options: Schema.optional(Schema.Array(QuestionOption)),
  allowOther: Schema.optional(Schema.Boolean),
})
export type QuestionSpec = typeof QuestionSpec.Type

/** Questions as numbered plain text: what a model sees, and what a text-only channel can show the owner. */
export function questionText(questions: readonly QuestionSpec[]): string {
  return questions
    .map((question, index) => {
      const lines = [`${index + 1}. ${question.prompt}${question.kind === 'multi' ? ' (choose any)' : ''}`]
      if (question.kind !== 'text')
        for (const option of question.options ?? [])
          lines.push(`   - ${option.label}${option.description === undefined ? '' : ` (${option.description})`}`)
      if (question.allowOther === true && question.kind !== 'text') lines.push('   - or something else')
      return lines.join('\n')
    })
    .join('\n')
}

/**
 * Pi's receipt for the owner's message: the session it went to, its operation id, and whether this call admitted it
 * (`false` when the operation id was already submitted).
 */
export const MessageReceipt = Schema.Struct({
  operationId: Schema.String,
  session: Schema.String,
  accepted: Schema.Boolean,
})
export type MessageReceipt = typeof MessageReceipt.Type

/**
 * `GET …/:id/sends/:operationId` (ADR 0119): how one send of the chat stands now. `queued` waits behind the chat's
 * earlier work; `working` runs, `step` saying what it does in plain words (`thinking`, `calling <tool>`, `waiting for a
 * person`); `answered` settled with its answer's text; `unanswered` settled without one, `reason` in Pi's words
 * (`aborted` and `withdrawn` when stopped). A send the chat never took is `NotFound` `operation`.
 */
export const SendStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal('queued') }),
  Schema.Struct({ status: Schema.Literal('working'), step: Schema.String }),
  Schema.Struct({ status: Schema.Literal('answered'), text: Schema.String }),
  Schema.Struct({ status: Schema.Literal('unanswered'), reason: Schema.String }),
])
export type SendStatus = typeof SendStatus.Type

/** `POST …/stop`: the owner's Stop, optionally naming the one operation to stop. */
export const StopConversation = Schema.Struct({ operationId: Schema.optional(OperationId) })
export type StopConversation = typeof StopConversation.Type

/** A thread operation's anchor at an entry of the chat (Reply). */
const EntryAnchor = Schema.Struct({ entry: EntryId })

/**
 * Where a thread operation starts its Thread in the chat: at an entry (Reply), `empty` ("+"), or `latest` (the
 * composer's Start thread: the chat's newest settled entry, or empty when it has none, with the message posted as the
 * Thread's head in the chat).
 */
export const ThreadAnchor = Schema.Union([EntryAnchor, Schema.Literals(['empty', 'latest'])])
export type ThreadAnchor = typeof ThreadAnchor.Type

/**
 * The thread operation (ADR 0034), `POST /api/conversations/:id/threads`, for Reply, "+" and Start thread: start the
 * Thread at `anchor` of the chat, then send `message` as its first message, answered there. `message` is a send as
 * `…/messages` takes it (`RunInput`, ADR 0111): its `threadId` the chat the path names, its `runId` the operation's id,
 * so the same run id finds the same Thread and a double click or a retry never makes two; the first message's own
 * operation id derives from it. A `title` names the Thread at once (ADR 0090); an `empty` one then announces itself in
 * its Topic's Conversation in the same operation, once.
 */
export const StartThread = Schema.Struct({
  anchor: ThreadAnchor,
  title: Schema.optional(NonEmptyString(120)),
  message: RunInput,
  /**
   * The MCP servers the Thread's Persona forks call natively (ADR 0103), a key's alone. A replay of the operation with
   * new tokens for the same servers keeps the Thread and makes the newest tokens the live ones.
   */
  mcpServers: Schema.optional(ThreadServers),
})
export type StartThread = typeof StartThread.Type

/**
 * A thread operation as plain fields, what the MCP tool `thread_start` takes: its operation id, anchor, title and
 * servers, the first message's words and parts, and the order of the Personas it tags. `threadStart` makes the
 * operation's body of it.
 */
export const PlainThreadStart = Schema.Struct({
  operationId: OperationId,
  anchor: ThreadAnchor,
  title: Schema.optional(NonEmptyString(120)),
  message: Schema.Struct({
    input: PlainSend.fields.input,
    appContext: PlainSend.fields.appContext,
    attachments: PlainSend.fields.attachments,
    selections: PlainSend.fields.selections,
  }),
  personaOrder: PlainSend.fields.personaOrder,
  mcpServers: Schema.optional(ThreadServers),
})
export type PlainThreadStart = typeof PlainThreadStart.Type

/** The body of `start` from chat `chat`: its first message a send (`runInput`) under the operation's id. */
export function threadStart(chat: string, start: PlainThreadStart): StartThread {
  const { operationId, anchor, title, message, personaOrder, mcpServers } = start
  return {
    anchor,
    ...(title === undefined ? {} : { title }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    message: runInput(chat, { ...message, operationId, ...(personaOrder === undefined ? {} : { personaOrder }) }),
  }
}

/** What a thread operation returns: the Thread as it is now and the receipt of the owner's message in it. */
export const StartedThread = Schema.Struct({ thread: ConversationView, receipt: MessageReceipt })
export type StartedThread = typeof StartedThread.Type

/**
 * `POST /api/conversations`: the thread operation without a message. With `from`, the Thread starts at that entry of
 * an open chat (in its Topic); without it, empty under `topic`'s Conversation, else Personal's. With an `operationId`
 * it is that chat's thread operation, so the same id finds the same Thread; without one, each call makes a new Thread.
 */
export const CreateConversation = Schema.Struct({
  operationId: Schema.optional(OperationId),
  topic: Schema.optional(TopicId),
  from: Schema.optional(Schema.Struct({ conversation: ChatId, ...EntryAnchor.fields })),
})
export type CreateConversation = typeof CreateConversation.Type
const AUTHOR_TAG = /^\[from ([^\]\n]{1,80})\]$/u

/**
 * Who wrote a message into a conversation when it was not the owner's own browser (Source, an MCP client, a
 * subagent): its content starts with a text block holding only this tag. The model reads it as written.
 */
export const authorTag = (author: string): string => `[from ${author.replaceAll(/[\]\n]/gu, ' ').slice(0, 80)}]`

/** The author named by a leading tag block, if that is what the block is. */
export const authorOf = (block: string): string | undefined => AUTHOR_TAG.exec(block)?.[1]

/** A chosen name inside an author: no `]` to end the tag, no line break, and no `·`, which joins a member to their ID. */
const plainName = (name: string): string =>
  name
    .replaceAll(/[\]\n·]/gu, ' ')
    .replaceAll(/\s+/gu, ' ')
    .trim()

/** The words that start the authors goblin writes itself; a name someone chose never starts with one. */
const OWN_AUTHORS = /^(?:(?:member|persona|server|subagent|thread)\b[\s:]*)+/iu

/**
 * The author of a member's message in a workspace of several people (ADR 0094): `member <name> · <user id>`, which
 * goblin writes in front of every such message, so the agent knows who speaks and the web whose it is. The name is
 * cut so the whole ID fits in the tag (`authorTag` keeps 80 characters).
 */
export const memberAuthor = (name: string, userId: string): string =>
  `member ${plainName(name).slice(0, Math.max(1, Math.min(50, 70 - userId.length)))} · ${userId}`

/**
 * The author of an OAuth client's message (ADRs 0086, 0094): the name its registrant chose, never one that reads as an
 * author goblin writes (a member's, a Persona's, a server's, a subagent's, a thread's), and in a workspace of several
 * people the member it acts for.
 */
export const clientAuthor = (client: string, member?: string): string => {
  const name = plainName(client).replace(OWN_AUTHORS, '').slice(0, 40) || 'client'
  return member === undefined ? name : `${name} for ${plainName(member).slice(0, 30)}`
}

/**
 * The author of a message a server's API key sent (ADR 0115): `server <key name>`, which goblin writes in front of each,
 * so the agent reads a request from a party the owner connected, never the owner's own words.
 */
export const serverAuthor = (key: string): string => `server ${plainName(key).slice(0, 64) || 'key'}`

const MEMBER_AUTHOR = /^member (.{1,50}) · ([\w-]{1,200})$/u

/** The member an author names, when it is a member's (`memberAuthor`). */
export const memberOf = (author: string): { readonly name: string; readonly userId: string } | undefined => {
  const [, name, userId] = MEMBER_AUTHOR.exec(author) ?? []
  return name === undefined || userId === undefined ? undefined : { name, userId }
}

/**
 * Where the owner's own turn that came from elsewhere came from, as its receipt's origin says: `source`, a Source's
 * message the speaks-for-me rule the owner confirmed matched (ADR 0066).
 */
export const OwnTurnVia = Schema.Literal('source')
export type OwnTurnVia = typeof OwnTurnVia.Type

/**
 * The block goblin writes after the words of the owner's own turn that came from elsewhere,
 * `{"ownTurn":{"via":"source"}}`: the web shows such a message as the owner's turn. The words are one block before it,
 * so nothing they say can add one.
 */
export const OwnTurnMark = Schema.Struct({ ownTurn: Schema.Struct({ via: OwnTurnVia }) })

/**
 * The files a message from elsewhere brought, as goblin kept them in the owner's files (ADR 0065), and a note for each
 * one it could not keep: untrusted data from the connection `origin` names, written by goblin after the words.
 */
export const ReceivedBlock = Schema.Struct({
  origin: Schema.Struct({ connectionId: Schema.String, trust: Schema.Literal('untrusted') }),
  received: ReceivedFiles,
  notReceived: Schema.optional(Schema.Array(Schema.String)),
})
export type ReceivedBlock = typeof ReceivedBlock.Type
