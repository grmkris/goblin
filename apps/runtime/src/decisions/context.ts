import { CONTEXT_SOURCES, type RetrievalSource } from '@goblin/contracts'
import type { TranscriptIndex } from '../retrieval/index.ts'
import { autoUseId } from '../retrieval/service.ts'
import { sourcesText } from '../retrieval/text.ts'
import type { DecisionCase } from './schema.ts'

/** The owner's newest message in a chat and the earlier work a search found for it in the owner's other chats. */
export type ContextCandidates = {
  readonly input: { readonly entry: number; readonly text: string }
  readonly sources: readonly [RetrievalSource, ...RetrievalSource[]]
}

/** How many search results are weighed before those automatic retrieval already gave are set aside. */
const SEARCHED = 8

/** Whether two sources cover any of the same messages of one chat. */
const overlaps = (a: RetrievalSource, b: RetrievalSource) =>
  a.chat === b.chat && a.entryStart <= b.entryEnd && b.entryStart <= a.entryEnd

/**
 * Cross-Topic context candidates for the owner's newest message in `chat` (ADR 0035's index, its default Topic policy:
 * active Topics that take part in search, never the chat itself): after a bounded catch-up, the top three sources of
 * a search for that message that automatic retrieval did not already give it (`auto:<session>:<entry>`). None for a
 * Persona fork, a chat without an owner message, or nothing left.
 */
export async function contextCandidates(
  index: TranscriptIndex,
  session: string,
  chat: string,
): Promise<ContextCandidates | undefined> {
  if (index.chatFor(session)?.persona !== false) return undefined
  const input = await index.latestInput(session)
  if (input === undefined) return undefined
  await index.catchUpAll()
  const given = index.recorded(autoUseId(session, input.entry))?.sources ?? []
  const fresh = index
    .search(input.text, { exclude: chat, limit: SEARCHED })
    .filter((source) => !given.some((used) => overlaps(source, used)))
  const [first, ...rest] = fresh.slice(0, CONTEXT_SOURCES)
  return first === undefined ? undefined : { input, sources: [first, ...rest] }
}

/**
 * The critic's case: is each candidate directly useful to the request, or none? The default search already leaves out
 * archived and opted-out Topics, and the owner named none, so every candidate is automatic, active and current.
 */
export function contextCase(
  request: string,
  sources: readonly RetrievalSource[],
): Extract<DecisionCase, { readonly task: 'context-relevance' }> {
  return {
    id: 'context',
    task: 'context-relevance',
    state: {
      request: request.slice(0, 2000),
      explicitReferences: [],
      candidates: sources.map((source, index) => ({
        id: `c${index + 1}`,
        topic: source.topicName,
        excerpt: source.excerpt,
        autoEnabled: true,
        archived: false,
        supersededBy: null,
      })),
    },
  }
}

/** The excerpts the owner chose to use, as goblin's note for a request: quoted history, never instructions. */
export const chosenText = (sources: readonly RetrievalSource[]): string =>
  `The owner chose to use these excerpts from their other chats here.\n${sourcesText(sources)}`
