import { Option, Schema } from 'effect'
import { WorkspacePlanId } from '@goblin/contracts'
import type { ToolPart } from '../../lib/parts.ts'
import { record } from '../../lib/values.ts'
import { WorkspacePlanCard } from '../workspace-plan.tsx'
import { GenericToolPart } from './tool-part.tsx'

const decode = Schema.decodeUnknownOption(
  Schema.Struct({ kind: Schema.Literal('workspace-plan'), setupId: WorkspacePlanId }),
)

/** Only Goblin's own proposal result may point at an owner-backed review card. */
export function WorkspacePlanPart({ part }: { readonly part: ToolPart }) {
  const details = record(part.result?.details)
  const receipt = Option.getOrUndefined(decode(details))
  return receipt && details && !('origin' in details) && !part.result?.isError ? (
    <WorkspacePlanCard id={receipt.setupId} />
  ) : (
    <GenericToolPart part={part} />
  )
}
