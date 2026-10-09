import { DecisionProposal, type DecisionLabel, type EphemeralMessage } from '@goblin/contracts'
import { Schema } from 'effect'
import { ApiFailure, request } from './boundary.ts'

/** The two actions of a proposal's row: their ids are the labels the runtime keeps (ADR 0031). */
const DISMISS = { id: 'dismiss', label: 'Dismiss', tone: 'neutral' } as const
const CONFIRM: Readonly<Record<DecisionProposal['payload']['type'], string>> = {
  'thread-draft': 'New thread',
  highlight: 'Useful',
  context: 'Use',
}

/** How much of a Delegate's report, or of an earlier chat, the row quotes. */
const EXCERPT = 280

/** `text` on one line, at most `limit` characters: a longer one is cut after a whole word, with an ellipsis. */
const excerpt = (text: string, limit: number): string => {
  const flat = text.replaceAll(/\s+/gu, ' ').trim()
  if (flat.length <= limit) return flat
  const space = flat.slice(0, limit).lastIndexOf(' ')
  // One very long word has no break to cut at, so it is cut inside.
  return `${flat.slice(0, space > limit / 2 ? space : limit - 1).trimEnd()}…`
}

type Payload = DecisionProposal['payload']

/** Where earlier work comes from, and how many more places the proposal offers. */
function contextWords({ sources: [first, ...rest] }: Extract<Payload, { readonly type: 'context' }>) {
  const where = first.chatTitle === undefined ? first.topicName : `${first.topicName} · ${first.chatTitle}`
  const more = rest.length === 0 ? '' : ` And ${rest.length} more ${rest.length === 1 ? 'place' : 'places'}.`
  return {
    title: 'Earlier work may help here',
    body: `From ${where}: “${excerpt(first.excerpt, EXCERPT)}”${more} Use gives goblin these excerpts with your next messages in this chat.`,
  }
}

/** What a row says: the judgment as a title, and the evidence it was made on. */
function words(payload: Payload): Pick<EphemeralMessage, 'title' | 'body'> {
  if (payload.type === 'context') return contextWords(payload)
  if (payload.type === 'thread-draft')
    return {
      title: 'This could be a thread',
      body: `“${excerpt(payload.title, 60)}” looks like separate work. A new thread keeps it apart; nothing here moves.`,
    }
  return { title: 'A report worth your attention', body: excerpt(payload.text, EXCERPT) }
}

/** Proposals about one exchange of a chat: a newer exchange makes an older one stale, so only the newest shows. */
const PER_EXCHANGE: ReadonlySet<Payload['type']> = new Set(['thread-draft', 'context'])
const exchangeKey = (proposal: DecisionProposal) =>
  PER_EXCHANGE.has(proposal.payload.type) ? `${proposal.chatId}:${proposal.payload.type}` : undefined

/** One open proposal as the owner-only row of its chat. */
const message = (proposal: DecisionProposal): EphemeralMessage => ({
  id: proposal.id,
  chat: proposal.chatId,
  ...words(proposal.payload),
  actions: [{ id: 'confirm', label: CONFIRM[proposal.payload.type], tone: 'primary' }, DISMISS],
  createdAt: proposal.createdAt,
})

/**
 * The owner-only rows the open decision proposals make, oldest first: every open report highlight, and of a chat's
 * thread and context suggestions only the newest of each (an older one judged an exchange that has moved on, and the
 * runtime would refuse it as stale). Confirmed, dismissed and stale proposals show nothing.
 */
export function proposalMessages(proposals: readonly DecisionProposal[]): readonly EphemeralMessage[] {
  const open = proposals.filter((proposal) => proposal.state === 'open')
  const newest = new Map<string, DecisionProposal>()
  for (const proposal of open) {
    const key = exchangeKey(proposal)
    const shown = key === undefined ? undefined : newest.get(key)
    if (key !== undefined && (shown === undefined || shown.createdAt <= proposal.createdAt)) newest.set(key, proposal)
  }
  return open
    .filter((proposal) => {
      const key = exchangeKey(proposal)
      return key === undefined || newest.get(key) === proposal
    })
    .toSorted((a, b) => a.createdAt - b.createdAt)
    .map(message)
}

/** The label an action of a proposal's row stands for, or none for an action it does not have. */
export const labelOf = (action: string): DecisionLabel['label'] | undefined =>
  action === 'confirm' || action === 'dismiss' ? action : undefined

/** Whether the owner's label opens a new thread's draft: a confirmed "this could be a thread". */
export const opensThread = (proposal: DecisionProposal): boolean =>
  proposal.state === 'confirmed' && proposal.payload.type === 'thread-draft'

const decodeProposal = Schema.decodeUnknownSync(DecisionProposal)

/**
 * Keeps the owner's label of proposal `id` (`POST /api/decisions/:id`, through `send`) and gives the proposal as it is
 * now. A proposal that is gone, already settled the other way or stale gives nothing: it is not the owner's to act on
 * any more, and the feed shows what became of it. Any other failure throws.
 */
export async function sendLabel(
  id: string,
  label: DecisionLabel['label'],
  send: typeof request = request,
): Promise<DecisionProposal | undefined> {
  try {
    return decodeProposal(await send(`/api/decisions/${encodeURIComponent(id)}`, { body: { label } }))
  } catch (failure) {
    if (failure instanceof ApiFailure && (failure.status === 404 || failure.status === 409)) return undefined
    throw failure
  }
}
