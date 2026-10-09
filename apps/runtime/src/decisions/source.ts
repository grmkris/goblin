import type { PiHarness } from 'agents/harness/pi'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import { and, eq, isNull, ne } from 'drizzle-orm'
import * as Context from 'effect/Context'
import { appConversations } from '../storage/schema.ts'
import { BACKGROUND, conversationId } from '../pi/context.ts'
import { recentMessages } from '../pi/transcript.ts'
import { digestOf } from '../skills/verify.ts'
import type { ChatDirectory } from '../chats/directory.ts'
import type { TranscriptIndex } from '../retrieval/index.ts'
import { contextCandidates, contextCase } from './context.ts'
import type { Judgment } from './service.ts'
import type { DecisionFence } from './store.ts'
import type { WorkState } from './schema.ts'

/** How long a suggested thread's title may be. */
const TITLE = 60

/**
 * The owner's message as a suggested thread's title: one line, at most 60 characters, a longer one cut after a whole
 * word with an ellipsis.
 */
export function threadTitle(text: string): string {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  if (flat === '') return 'New thread'
  if (flat.length <= TITLE) return flat
  const space = flat.slice(0, TITLE).lastIndexOf(' ')
  // One very long word has no break to cut at, so it is cut inside.
  return `${flat.slice(0, space > TITLE / 2 ? space : TITLE - 1).trimEnd()}…`
}

/**
 * Only registered open owner chats and bounded ordinary prose are candidates; cross-Topic context comes from the
 * transcript index (ADR 0035) under its default Topic policy.
 */
export class DecisionSource {
  readonly #db: DrizzleSqliteDODatabase
  readonly #harness: PiHarness
  readonly #chats: ChatDirectory
  readonly #index: TranscriptIndex
  constructor(db: DrizzleSqliteDODatabase, harness: PiHarness, chats: ChatDirectory, index: TranscriptIndex) {
    this.#db = db
    this.#harness = harness
    this.#chats = chats
    this.#index = index
  }
  #ownerRow(chatId: string) {
    const row = this.#db.select().from(appConversations).where(eq(appConversations.chatId, chatId)).get()
    return row === undefined || row.closedAt !== null || row.kind === 'subagent' || row.routineRunId !== null
      ? undefined
      : row
  }
  #fence(chatId: string): DecisionFence | undefined {
    const row = this.#ownerRow(chatId)
    return row?.piSession === undefined || row.piSession === null
      ? undefined
      : { session: row.piSession, epoch: row.epoch }
  }
  async current(chatId: string, fence: DecisionFence): Promise<boolean> {
    const row = this.#fence(chatId)
    if (row === undefined || row.session !== fence.session || row.epoch !== fence.epoch) return false
    if (fence.evidence === undefined) return true
    const work = await this.#work(chatId, row.session)
    const matches =
      work !== undefined && (await digestOf(new TextEncoder().encode(JSON.stringify(work)))) === fence.evidence
    const after = this.#fence(chatId)
    return matches && after?.session === fence.session && after.epoch === fence.epoch
  }
  async #messages(session: string) {
    const conversation = await (await this.#harness.pi()).conversation(conversationId(session), BACKGROUND)
    return conversation === undefined ? [] : recentMessages(conversation, 8)
  }
  async #work(chatId: string, session: string): Promise<WorkState | undefined> {
    const messages = await this.#messages(session)
    const lastOwner = messages.findLast((message) => message.role === 'user')
    if (lastOwner === undefined || lastOwner.author !== undefined) return undefined
    const row = this.#ownerRow(chatId)
    if (row === undefined) return undefined
    const threads = this.#db
      .select()
      .from(appConversations)
      .where(
        and(
          eq(appConversations.kind, 'thread'),
          isNull(appConversations.closedAt),
          isNull(appConversations.routineRunId),
          ne(appConversations.chatId, chatId),
        ),
      )
      .limit(20)
      .all()
    return {
      currentTopic: 'Current work',
      currentThread: row.title ?? 'Main',
      topics: [],
      threads: threads.map((thread) => ({ id: thread.chatId, name: thread.title ?? 'Untitled thread' })),
      exchange: messages
        .filter((message) => message.role === 'assistant' || message.author === undefined)
        .map((message) => ({
          role: message.role === 'assistant' ? ('assistant' as const) : ('owner' as const),
          text: message.text.slice(0, 1500),
        })),
    }
  }
  /**
   * What the owner's answered exchange is judged for: whether it could be a thread, and which earlier work in the
   * owner's other chats could help with it. Both are fenced on the same exchange, so a newer one makes them stale.
   */
  async ownerYield(session: string): Promise<readonly Judgment[]> {
    const chatId = this.#chats.chatOf(session)
    const fence = chatId === undefined ? undefined : this.#fence(chatId)
    if (chatId === undefined || fence === undefined) return []
    const work = await this.#work(chatId, session)
    if (work === undefined) return []
    const evidence = await digestOf(new TextEncoder().encode(JSON.stringify(work)))
    const frozen = { ...fence, evidence }
    const shared = {
      chatId,
      subject: evidence,
      ordinary: true,
      fence: frozen,
      current: () => this.current(chatId, frozen),
    }
    const thread: Judgment = {
      ...shared,
      id: `dp_thread_${session}_${evidence.slice(7)}`,
      case: { id: 'work', task: 'separate-work', state: work },
      payload: {
        type: 'thread-draft',
        title: threadTitle(work.exchange.findLast((message) => message.role === 'owner')?.text ?? ''),
      },
    }
    const found = await contextCandidates(this.#index, session, chatId)
    if (found === undefined) return [thread]
    const context: Judgment = {
      ...shared,
      id: `dp_context_${session}_${evidence.slice(7)}`,
      case: contextCase(found.input.text, found.sources),
      payload: { type: 'context', inputEntry: found.input.entry, sources: found.sources },
    }
    return [thread, context]
  }
  async report(session: string, relayId: string, text: string, complete: boolean): Promise<Judgment | undefined> {
    const chatId = this.#chats.chatOf(session)
    if (chatId === undefined) return undefined
    const fence = this.#fence(chatId)
    if (fence === undefined) return undefined
    const messages = await this.#messages(session)
    const focus =
      messages.findLast((message) => message.role === 'user' && message.author === undefined)?.text ?? 'Current work'
    return {
      id: `dp_report_${relayId}`,
      chatId,
      subject: relayId,
      fence,
      ordinary: complete && !/\?|approval|permission|ask_user|^It failed:|^It ended without/iu.test(text),
      case: {
        id: 'report',
        task: 'attention-triage',
        state: { focus: focus.slice(0, 2000), result: text.slice(0, 8000), runtimeKind: 'delegate-result' },
      },
      payload: { type: 'highlight', relayId, text: text.slice(0, 8000) },
      current: () => this.current(chatId, fence),
    }
  }
}
export class DecisionCandidates extends Context.Service<DecisionCandidates, DecisionSource>()(
  'goblin/DecisionCandidates',
) {}
