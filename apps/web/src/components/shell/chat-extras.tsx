import { type ReactNode, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RetrievalSource, SourceUse } from '@goblin/contracts'
import { sourcesQuery } from '../../conversations/queries.ts'
import type { LiveChild } from '../../lib/agui/reducer.ts'
import type { Part } from '../../lib/parts.ts'
import { sourcePlaces } from '../../lib/sources.ts'
import { SourcesStrip } from '../parts/sources-strip.tsx'
import { Answering } from './answering.tsx'

const NONE: readonly SourceUse[] = []
const NOBODY: readonly LiveChild[] = []

/**
 * What retrieval gave a chat's answers (`GET …/sources`, ADR 0035): read when the chat opens and again each time a run
 * there ends, which the workspace feed says (`lib/workspace/invalidations.ts`). Sources are a note under answers: a
 * read that fails keeps what was shown, and the next run's end reads again.
 */
const useSourceUses = (chat: string): readonly SourceUse[] => useQuery(sourcesQuery(chat)).data ?? NONE

const flat = (uses: readonly SourceUse[]): RetrievalSource[] => uses.flatMap((use) => use.sources)

/**
 * What a chat's transcript shows beside its own messages: under an answer the sources automatic retrieval gave it,
 * and after everything the Personas and subagents still working there (`working`, from the chat's stream).
 */
export function useChatExtras(chat: string, parts: readonly Part[], working: readonly LiveChild[] = NOBODY) {
  const uses = useSourceUses(chat)
  const strips = useMemo(() => sourcePlaces(parts, uses), [parts, uses])
  const after = (part: Part): ReactNode => {
    const used = strips.get(part.id)
    return used === undefined ? null : <SourcesStrip sources={flat(used)} />
  }
  const trail = <Answering chat={chat} working={working} />
  return { after, trail }
}
