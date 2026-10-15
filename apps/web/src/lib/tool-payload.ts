import { Option, Schema } from 'effect'
import { type Attachment, type JsonValue, ReceivedFiles } from '@goblin/contracts'
import type { ToolPayloadView } from '@goblin/ui'
import { isString, record, records } from './values.ts'
import { looksLikeMarkdown } from './markdown.ts'

/** One part of a tool's output: a JSON value, Markdown to format, or text shown as it is. */
export type PayloadBlock =
  | { readonly kind: 'json'; readonly value: JsonValue }
  | { readonly kind: 'markdown' | 'text'; readonly text: string }

const isJson = Schema.is(Schema.MutableJson)

/** Parse a complete text block only; mixed prose and model-envelope metadata stay intact in Raw. */
function textBlock(text: string): PayloadBlock {
  try {
    const value: unknown = JSON.parse(text)
    if (isJson(value)) return { kind: 'json', value }
  } catch {
    // expected: tool results may be ordinary text, errors or incomplete JSON; all remain readable as text
  }
  return { kind: looksLikeMarkdown(text) ? 'markdown' : 'text', text }
}

function isMcpEnvelope(details: Record<string, unknown> | undefined): details is Record<string, unknown> {
  const origin = record(details?.['origin'])
  return origin?.['trust'] === 'untrusted' && isString(origin['connectionId']) && Array.isArray(details?.['content'])
}

function structuredBlock(
  details: Record<string, unknown>,
): Extract<PayloadBlock, { readonly kind: 'json' }> | undefined {
  const value = details['structuredContent']
  return value !== '[unsupported]' && isJson(value) ? { kind: 'json', value } : undefined
}

function contentBlocks(details: Record<string, unknown>): readonly PayloadBlock[] {
  const blocks: PayloadBlock[] = []
  for (const content of records(details['content'])) {
    const text = content['text']
    const block =
      content['type'] === 'text' && isString(text)
        ? textBlock(text)
        : isJson(content)
          ? { kind: 'json' as const, value: content }
          : undefined
    if (block === undefined) continue
    blocks.push(block)
  }
  return blocks
}

/** The MCP envelope already contains redacted structured output and original content blocks. */
export function outputBlocks(result: { readonly text: string; readonly details: unknown }): readonly PayloadBlock[] {
  const details = record(result.details)
  if (!isMcpEnvelope(details)) return [textBlock(result.text)]
  const structured = structuredBlock(details)
  const encoded = structured === undefined ? undefined : JSON.stringify(structured.value)
  const content = contentBlocks(details).filter(
    (block) => block.kind !== 'json' || encoded === undefined || JSON.stringify(block.value) !== encoded,
  )
  if (structured === undefined && content.length === 0) return [textBlock(result.text)]
  return [...(structured === undefined ? [] : [structured]), ...content]
}

const decodeReceived = Schema.decodeUnknownOption(ReceivedFiles)

/**
 * The files goblin kept in the owner's files from an MCP result (ADR 0065): its envelope's own `received`, each a path
 * in the owner's files, never one a server's content names. None when there are none, or the list does not decode.
 */
export function receivedFiles(details: unknown): readonly Attachment[] {
  const envelope = record(details)
  return isMcpEnvelope(envelope) ? Option.getOrElse(decodeReceived(envelope['received']), () => []) : []
}

/** The view an output opens on: formatted when any part is Markdown, a tree when any is JSON, else plain text. */
export function payloadView(blocks: readonly PayloadBlock[]): ToolPayloadView {
  if (blocks.some((block) => block.kind === 'markdown')) return 'formatted'
  return blocks.some((block) => block.kind === 'json') ? 'tree' : 'plain'
}
