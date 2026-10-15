import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Option, Schema } from 'effect'
import type { SourceView } from '@goblin/contracts'
import { Alert, AlertDescription, Button } from '@goblin/ui'
import { record } from '../../lib/values.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import type { ToolPart } from '../../lib/parts.ts'
import { reviewedSourcesQuery } from '../../sources/queries.ts'
import { SourceReview } from '../source-review.tsx'
import { ToolCard } from './tool-part.tsx'

/** What `source_propose` returns for the card: the Source and the revision it proposed (ADR 0066). */
const Proposed = Schema.Struct({
  kind: Schema.Literal('source-proposal'),
  sourceId: Schema.String,
  revision: Schema.Int,
})
const decodeProposed = Schema.decodeUnknownOption(Proposed)

/** What the review shows: the Source as it is now, and a line when it changed or went since it was proposed. */
export function reviewedSource(sources: readonly SourceView[] | undefined, id: string, revision: number) {
  if (sources === undefined) return { source: undefined, note: '' }
  const source = sources.find((each) => each.id === id)
  if (source === undefined) return { source, note: 'This Source has been removed.' }
  return {
    source,
    note: source.revision === revision ? '' : 'The Source has changed. Review its current revision below.',
  }
}

/**
 * The agent's proposal of a Source in the chat: Review loads the Source as it is now and shows its card, where only the
 * owner confirms the exact revision. The tool's own text never confirms anything.
 */
export function SourceProposalPart({ part }: { readonly part: ToolPart }) {
  const details = record(part.result?.details)
  const proposed = Option.getOrUndefined(decodeProposed(details))
  const [open, setOpen] = useState(false)
  const read = useQuery(reviewedSourcesQuery(open))
  // The review shows the Sources as read after it opened, never a list cached before it.
  const { source, note } = reviewedSource(
    read.isFetchedAfterMount ? read.data?.sources : undefined,
    proposed?.sourceId ?? '',
    proposed?.revision ?? 0,
  )
  const error = read.error === null ? note : messageOf(read.error, 'read the Source')
  return (
    <ToolCard part={part}>
      {proposed && !part.result?.isError && (
        <Button
          size="sm"
          variant="outline"
          pending={open && read.isFetching}
          onClick={() => (open ? void read.refetch() : setOpen(true))}
        >
          Review source proposal
        </Button>
      )}
      {error && (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {source && <SourceReview source={source} />}
    </ToolCard>
  )
}
