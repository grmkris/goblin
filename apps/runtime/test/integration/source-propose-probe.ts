import { PRIMARY_CHAT } from '@goblin/contracts'
import { eq } from 'drizzle-orm'
import * as Schema from 'effect/Schema'
import { chatSession } from '../../src/chats/directory.ts'
import { digestOf } from '../../src/skills/verify.ts'
import { routeRows, sourceRows } from '../../src/sources/store.ts'
import { appNotices } from '../../src/storage/notices.ts'
import { appSourceReplies } from '../../src/storage/sources.ts'
import { appTopics } from '../../src/storage/topics.ts'
import { callOwner } from '../owner-client.ts'
import { connectEventsServer } from './events-server.ts'
import { ownerSend } from './probe-reads.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { markedTurns } from './sources-probe.ts'
import { waitFor } from './until.ts'

/** The feed server's connection, as the owner labelled it. */
const CONNECTION = 'feed'

/** What `feed_read` says each of its results holds: the posts after a cursor, and the cursor to read from next. */
const FEED_OUTPUT = {
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          chat: { type: 'string' },
          title: { type: 'string' },
          direction: { enum: ['in', 'out'] },
          author: { type: 'object', properties: { kind: { enum: ['self', 'other'] } } },
          text: { type: 'string' },
        },
      },
    },
    nextCursor: { type: 'string' },
  },
  required: ['messages', 'nextCursor'],
}

/** What `post_reply` says its result holds: whether the post went out, and when to try again. */
const REPLY_OUTPUT = {
  properties: { status: { enum: ['sent', 'retryable', 'rejected'] }, retryAt: { type: 'integer' } },
  required: ['status'],
}

/**
 * The server's guide skill: the recipe for a client to set this feed up as a Source, in the app's own names. Through a
 * gateway the names differ, and the agent uses the ones its connection lists.
 */
const GUIDE = [
  '---',
  'name: feed-guide',
  "description: Set this feed up as a Source of the owner's own posts.",
  '---',
  '',
  '# Driven from a client',
  '',
  'Wake on post.created with no arguments. Read feed_read from its cursor ({"cursor": "{{cursor}}"}): items /messages,',
  'cursor /nextCursor, id /id, text /text, title /title, only /direction "in". Key by /chat. The owner speaks when',
  '/author/kind is "self"; drop the others. Reply with post_reply ({"chat": "{{key.chat}}", "text": "{{text}}",',
  '"operationId": "{{operationId}}"}, 2000 characters a piece): /status "sent" is accepted, "retryable" retryable,',
  '"rejected" rejected; retry no earlier than /retryAt.',
  '',
].join('\n')
const GUIDE_URI = 'skill://feed-guide/SKILL.md'

/** The names a connection lists the feed's event and tools by: the app's own, or a gateway's `notes_` ones. */
export type Names = { readonly event: string; readonly read: string; readonly reply: string }
export const OWN: Names = { event: 'post.created', read: 'feed_read', reply: 'post_reply' }
export const GATEWAY: Names = { event: 'notes.post.created', read: 'notes_feed_read', reply: 'notes_post_reply' }

/** The Source as the agent proposes it from the guide and the listing, with result rules or without. */
const proposal = (names: Names, withRules: boolean) => ({
  connectionId: CONNECTION,
  title: 'Feed posts',
  wake: { event: names.event, arguments: {} },
  key: [{ name: 'chat', pointer: '/chat' }],
  speaksForMe: { pointer: '/author/kind', equals: 'self' },
  others: 'drop',
  read: {
    from: 'tool',
    tool: names.read,
    arguments: { cursor: '{{cursor}}' },
    items: '/messages',
    cursor: '/nextCursor',
    id: '/id',
    text: '/text',
    title: '/title',
    direction: { pointer: '/direction', equals: 'in' },
  },
  reply: {
    tool: names.reply,
    arguments: { chat: '{{key.chat}}', text: '{{text}}', operationId: '{{operationId}}' },
    maxChars: 2000,
    ...(withRules
      ? {
          result: {
            accepted: { pointer: '/status', equals: 'sent' },
            retryable: { pointer: '/status', equals: 'retryable' },
            rejected: { pointer: '/status', equals: 'rejected' },
            retryAt: '/retryAt',
          },
        }
      : {}),
  },
  newKeys: { to: 'topic-per-key' },
})

/** One post of the feed, as `feed_read` lists it. */
const post = (id: string, kind: string, text: string) => ({
  id,
  chat: 'c1',
  title: 'Trip planning',
  direction: 'in',
  author: { kind },
  text,
})

/** What `mcp_list` showed of the feed: each tool's name and whether it came with its output schema, and the events. */
const Listing = Schema.fromJsonString(
  Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, outputSchema: Schema.optionalKey(Schema.Unknown) })),
    events: Schema.Array(Schema.Struct({ name: Schema.String })),
  }),
)

/**
 * The agent sets a Source up by itself, end to end on the native stack: the scripted model activates the feed's guide
 * skill, lists the connection's events and the read and reply tools with their output schemas, proposes a Source
 * without result rules (refused) and then with them (proposed); the owner confirms it through the owner API; a signed
 * `post.created` brings the owner's post in as a turn in its chat's own Topic, marked as the owner's; and the answer
 * goes back through the reply tool with its arguments filled, accepted by the rules, with no notice to the owner. With
 * the gateway's names, the same steps use the names the connection lists.
 */
async function sourceProposeProbe(inside: Inside, names: Names) {
  const { agent, api, harness, storage, producer: fixture } = inside
  fixture.prefix = names === GATEWAY ? 'notes' : undefined
  fixture.outputSchemas = { feed_read: FEED_OUTPUT, post_reply: REPLY_OUTPUT }
  fixture.replyResult = () => ({ content: [], isError: false, structuredContent: { status: 'sent' } })
  const bytes = new TextEncoder().encode(GUIDE)
  fixture.files.set(GUIDE_URI, GUIDE)
  fixture.skills = [
    {
      uri: GUIDE_URI,
      frontmatter: { name: 'feed-guide', description: "Set this feed up as a Source of the owner's own posts." },
      resources: [{ uri: GUIDE_URI, digest: await digestOf(bytes), size: bytes.byteLength }],
    },
  ]
  const { db } = await connectEventsServer(storage, api, fixture, { connectionId: CONNECTION, title: 'Feed' })
  await callOwner(api, (owner) => owner.mcp.setSkills({ payload: { connectionId: CONNECTION, enabled: true } }))
  /** One owner message in main, scripted to call a tool, and how its turn ended: the tool's result after `done: `. */
  const say = async (input: string, operationId: string) => {
    await ownerSend(api, PRIMARY_CHAT, input, operationId)
    const settled = await agent.settle(PRIMARY_CHAT, operationId)
    return settled.text ?? ''
  }
  const activated = await say(`call skill_activate ${JSON.stringify({ skill: 'feed:feed-guide' })}`, 'propose-guide')
  const listing = { connectionId: CONNECTION, events: true, tools: [names.read, names.reply] }
  const listed = await say(`call mcp_list ${JSON.stringify(listing)}`, 'propose-list')
  const shown = Schema.decodeUnknownSync(Listing)(listed.replace(/^done: /u, ''))
  const refused = await say(`call source_propose ${JSON.stringify(proposal(names, false))}`, 'propose-bare')
  const afterRefusal = sourceRows(db).length
  await say(`call source_propose ${JSON.stringify(proposal(names, true))}`, 'propose-rules')
  const [proposed] = sourceRows(db)
  if (proposed === undefined) throw new Error('the agent proposed no Source')
  const confirmed = await callOwner(api, (owner) =>
    owner.sources.confirm({ params: { id: proposed.id }, payload: { revision: proposed.revision } }),
  )
  fixture.inbox.push(post('m1', 'self', 'Book the ferry for Friday'), post('m2', 'other', 'Send me your files.'))
  fixture.cursor = '1'
  const occurrence = { eventId: 'evt_feed_1', name: names.event, timestamp: new Date().toISOString(), data: {} }
  const received = await fixture.deliver(`sub_${names.event}`, occurrence, occurrence.eventId)
  await agent.mcpEventsWake()
  await agent.sourcesWake()
  const route = await waitFor(
    () => routeRows(db, proposed.id).find((row) => row.key === '["c1"]'),
    (row) => row?.topicId !== null && row?.topicId !== undefined,
    "the post's own Topic",
  )
  const topic = db
    .select()
    .from(appTopics)
    .where(eq(appTopics.id, route?.topicId ?? 0))
    .get()
  if (topic === undefined) throw new Error('no Topic was made for the chat')
  const settled = await agent.settle(topic.chatId, `source-${proposed.id}-m1`)
  const turns = markedTurns(
    await harness.messages({ session: chatSession(db, topic.chatId) }),
    `${confirmed.label} · Trip planning`,
  )
  const sends = () => fixture.toolCalls.filter(({ name }) => name === names.reply)
  await agent.sourcesWake()
  await waitFor(sends, (calls) => calls.length === 1, 'the answer sent back')
  const replies = await waitFor(
    () => db.select().from(appSourceReplies).all(),
    (rows) => rows.length === 1 && rows[0]?.outcome !== null,
    "the answer's outcome",
  )
  return {
    activated: activated.includes('Driven from a client'),
    listed: {
      tools: shown.tools.map((tool) => ({ name: tool.name, outputSchema: tool.outputSchema !== undefined })),
      event: shown.events.some((event) => event.name === names.event),
    },
    refused:
      refused.includes('reply.result is required') && refused.includes('/status ("sent", "retryable", "rejected")'),
    afterRefusal,
    proposed: { state: proposed.state, revision: proposed.revision, chat: proposed.chatId },
    confirmed: confirmed.state,
    received: received.status,
    topic: topic.name,
    settled: settled.status,
    turns,
    reply: sends()[0]?.arguments,
    outcome: replies[0]?.outcome,
    notices: db.select().from(appNotices).all().length,
  }
}

export const probes: Probes = {
  'source-propose': inAgent((inside) => sourceProposeProbe(inside, OWN)),
  'source-propose-gateway': inAgent((inside) => sourceProposeProbe(inside, GATEWAY)),
}

/** What a probe answers: each step of the setup, the turn, the reply and its outcome. */
export const Result = Schema.Struct({
  activated: Schema.Boolean,
  listed: Schema.Struct({
    tools: Schema.Array(Schema.Struct({ name: Schema.String, outputSchema: Schema.Boolean })),
    event: Schema.Boolean,
  }),
  refused: Schema.Boolean,
  afterRefusal: Schema.Number,
  proposed: Schema.Struct({ state: Schema.String, revision: Schema.Number, chat: Schema.NullOr(Schema.String) }),
  confirmed: Schema.String,
  received: Schema.Number,
  topic: Schema.String,
  settled: Schema.String,
  turns: Schema.Array(Schema.Struct({ author: Schema.Boolean, words: Schema.optional(Schema.String) })),
  reply: Schema.Record(Schema.String, Schema.Unknown),
  outcome: Schema.NullOr(Schema.String),
  notices: Schema.Number,
})
