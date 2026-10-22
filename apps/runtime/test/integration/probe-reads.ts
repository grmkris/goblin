import {
  type ConversationView,
  type CreateConversation,
  PRIMARY_CHAT,
  type SendMessage,
  type UpdateConversation,
} from '@goblin/contracts'
import { AppError } from '@goblin/contracts/api'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { isAppError } from '../../src/http/errors.ts'
import type { RpcResult } from '../../src/http/rpc.ts'
import { type AgentFetch, type OwnerClient, asOwner, ownerApi, workspaceSnapshot } from '../owner-client.ts'
import type { ProbeStub } from './probe.ts'
import { until } from './until.ts'

/**
 * One owner API call against `agent`, its refusals as data: `{ ok: true, value }`, or `{ ok: false, error }` with the
 * encoded `AppError` (carrying the reference the API stamps on it), for a probe to answer and its case to decode. A
 * failure the API did not answer (transport, or a body that does not decode) rejects.
 */
export const ownerResult = <A, E>(
  agent: AgentFetch,
  call: (api: OwnerClient) => Effect.Effect<A, E>,
): Promise<RpcResult<A>> =>
  Effect.runPromise(
    Effect.flatMap(ownerApi(agent), call).pipe(
      Effect.map((value): RpcResult<A> => ({ ok: true, value })),
      // expected: the API answered this failure; the checks read it as the RPC method's refusal.
      Effect.catchIf(isAppError, (error) =>
        Effect.succeed<RpcResult<A>>({ ok: false, error: Schema.encodeSync(AppError)(error) }),
      ),
    ),
  )

/** The owner API's answer to `call` as one word: `ok`, or the tag of the failure it refused with. */
export const answerOf = async <A, E>(agent: AgentFetch, call: (api: OwnerClient) => Effect.Effect<A, E>) => {
  const result = await ownerResult(agent, call)
  return result.ok ? 'ok' : result.error._tag
}

/** The owner's message into a chat: `POST /api/conversations/:id/messages`. */
export const ownerSend = (
  agent: AgentFetch,
  chat: string,
  input: string,
  operationId: string,
  extra: Omit<SendMessage, 'input' | 'operationId'> = {},
) =>
  ownerResult(agent, (api) =>
    api.conversations.submit({ params: { id: chat }, payload: { input, operationId, ...extra } }),
  )

/** Every registered chat, closed ones included, as the workspace feed's snapshot lists them. */
export const workspaceConversations = async (agent: AgentFetch): Promise<readonly ConversationView[]> =>
  (await workspaceSnapshot(await agent.fetch(new Request('https://agent/api/workspace/events', asOwner()))))
    .conversations

/** A Thread, empty or branched from an entry: `POST /api/conversations`. */
export const ownerCreate = (agent: AgentFetch, input: CreateConversation) =>
  ownerResult(agent, (api) => api.conversations.create({ payload: input }))

/** A thread branched from main at `entry`; with no entry, a request the agent refuses. */
export const branchMain = (agent: AgentFetch, entry: number | undefined) =>
  ownerCreate(agent, { from: { conversation: PRIMARY_CHAT, entry: entry ?? 0 } })

/** Rename, close or reopen, or pin a subagent open: `PATCH /api/conversations/:id`. */
export const ownerUpdate = (agent: AgentFetch, chat: string, change: UpdateConversation) =>
  ownerResult(agent, (api) => api.conversations.update({ params: { id: chat }, payload: change }))

/** The owner has seen a chat's newest reply: `PUT /api/conversations/:id/read`. */
export const ownerMarkRead = (agent: AgentFetch, chat: string) =>
  ownerResult(agent, (api) => api.conversations.markRead({ params: { id: chat } }))

/** A Pi entry as these probes read it. */
const EntrySchema = Schema.Struct({
  id: Schema.Finite,
  kind: Schema.String,
  head: Schema.optional(Schema.Finite),
  data: Schema.optional(Schema.Unknown),
  model: Schema.optional(
    Schema.Array(Schema.Struct({ content: Schema.optional(Schema.Unknown), details: Schema.optional(Schema.Unknown) })),
  ),
})
export type Entry = typeof EntrySchema.Type
const decodeEntries = Schema.decodeUnknownSync(
  Schema.Struct({ entries: Schema.optionalKey(Schema.Array(EntrySchema)) }),
)

/**
 * A lever's answer for `chat` (`snapshot-lever.ts`). A chat not registered yet answers 404: it is registered as any
 * owner read of it does (main is made on its first), and read again.
 */
async function lever(agent: AgentFetch, path: string, chat: string): Promise<Response> {
  const first = await agent.fetch(new Request(`https://agent${path}`))
  if (first.status !== 404) return first
  await Effect.runPromise(
    Effect.flatMap(ownerApi(agent), (api) => api.conversations.history({ params: { id: chat }, query: { before: 1 } })),
  )
  return agent.fetch(new Request(`https://agent${path}`))
}

/** A conversation's Pi snapshot, as JSON, from the test agent's own lever (`snapshot-lever.ts`). */
export const ownerSnapshot = async (agent: AgentFetch, chat: string): Promise<unknown> => {
  const answer = await lever(agent, `/test/snapshot/${chat}`, chat)
  if (!answer.ok) throw new Error(`no snapshot of chat ${chat}: ${answer.status}`)
  return answer.json()
}

/** A conversation's snapshot, as far as its entries. */
export const snapshotOf = async (
  agent: AgentFetch,
  session: string,
): Promise<{ readonly entries?: readonly Entry[] }> => decodeEntries(await ownerSnapshot(agent, session))

/** Entries as `kind: content`, one line per model message. */
export const linesOf = (records: readonly Entry[]) =>
  records.flatMap((entry) => (entry.model ?? []).map((message) => `${entry.kind}: ${JSON.stringify(message.content)}`))

/** A conversation's raw Pi history before entry `before`, from the test agent's own lever (`snapshot-lever.ts`). */
export const historyOf = async (
  agent: AgentFetch,
  session: string,
  before = 2 ** 31,
): Promise<{ readonly entries?: readonly Entry[] }> => {
  const answer = await lever(agent, `/test/history/${session}?before=${before}`, session)
  if (!answer.ok) throw new Error(`no history of chat ${session}: ${answer.status}`)
  return decodeEntries(await answer.json())
}

/** A conversation's newest entries as people read them, in order, whatever the model's context starts with now. */
export const transcript = async (agent: AgentFetch, session: string): Promise<string[]> =>
  linesOf((await historyOf(agent, session)).entries ?? [])

/** The agent's conversations, once `done` holds for them. */
export const threadsUntil = (agent: AgentFetch, done: (views: readonly ConversationView[]) => boolean, ms?: number) =>
  until(() => workspaceConversations(agent), done, ms)

/** One owner message into a conversation, settled. */
export async function exchange(agent: ProbeStub, session: string, text: string, id: string) {
  await ownerSend(agent, session, text, id)
  return agent.settle(session, id)
}
