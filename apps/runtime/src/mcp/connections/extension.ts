import type { CallToolResult } from '@modelcontextprotocol/client'
import type { ToolExecutionResult } from '@earendil-works/pi-durable'
import {
  type Materialized,
  NOTHING_RECEIVED,
  type Received,
  recordedBlock,
  recordedContent,
} from '../content/materialize.ts'
import { redactSecretFields as redact } from '../oauth/redaction.ts'

type ModelContent = NonNullable<ToolExecutionResult['content']>

/**
 * What the model reads in place of a block goblin kept as a file (ADR 0065): the file's path, name, type and size, with
 * a small copy of an image when it sees images; or the note saying why it was not kept.
 */
const receivedContent = (received: Received): ModelContent => {
  if (received.kind === 'note')
    return [
      {
        type: 'text',
        text: JSON.stringify({
          notReceived: received.note,
          ...(received.link === undefined ? {} : { resourceLink: received.link }),
        }),
      },
    ]
  const { path, name, mimeType, size } = received.file
  return [
    { type: 'text', text: JSON.stringify({ receivedFile: { path, name, mimeType, size } }) },
    ...(received.image === undefined ? [] : [{ type: 'image' as const, ...received.image }]),
  ]
}

/**
 * Pi supports text and image blocks. A block goblin kept as a file is its reference; any other is explicit tagged data,
 * its links without their query and fragment.
 */
const mcpModelContent = (result: CallToolResult, received: Materialized): ModelContent => {
  const blocks: ModelContent = []
  for (const [index, block] of result.content.entries()) {
    const kept = received.get(index)
    if (kept !== undefined) blocks.push(...receivedContent(kept))
    else if (block.type === 'text') blocks.push({ type: 'text', text: block.text })
    else if (block.type === 'image') blocks.push({ type: 'image', data: block.data, mimeType: block.mimeType })
    else blocks.push({ type: 'text', text: JSON.stringify({ unsupportedMcpContent: redact(recordedBlock(block)) }) })
  }
  return blocks
}

/**
 * The details of a model's tool result: the server's own fields, redacted and marked untrusted, with every link
 * without its query and fragment (a signed URL never reaches the transcript) and a kept block without its bytes; and
 * `received`, goblin's own list of the files it kept from the result (ADR 0065).
 */
export const mcpResultDetails = (
  connectionId: string,
  result: {
    readonly structuredContent?: unknown
    readonly _meta?: unknown
    readonly content?: unknown
  },
  received: Materialized = NOTHING_RECEIVED,
) => {
  const files = [...received.values()].flatMap((item) => (item.kind === 'file' ? [item.file] : []))
  return redact({
    origin: { connectionId, trust: 'untrusted' },
    structuredContent: result.structuredContent,
    _meta: result._meta,
    content: recordedContent(result.content, received),
    ...(files.length === 0 ? {} : { received: files }),
  })
}

/**
 * A held call's result as its outcome carries it into the conversation (ADR 0042): redacted, every link without its
 * query and fragment.
 */
export const outcomeResult = (result: CallToolResult) => redact({ ...result, content: recordedContent(result.content) })

/**
 * A redacted model envelope; the manager retains the original rich MCP result for the host. `received` is what
 * `materialize` kept of it, each such block read as its file's reference.
 */
export const mcpModelResult = (
  connectionId: string,
  result: CallToolResult,
  received: Materialized = NOTHING_RECEIVED,
): ToolExecutionResult => ({
  content: [
    { type: 'text', text: JSON.stringify({ origin: { connectionId, trust: 'untrusted' } }) },
    ...mcpModelContent(result, received),
  ],
  isError: result.isError === true,
  details: mcpResultDetails(connectionId, result, received),
})

/**
 * What the model gets for a tool the owner has not granted: words it can relay, and a marker the web turns into an
 * owner-only Allow card. The marker is the top-level `kind`; `mcpModelResult` details never have one, so a remote
 * server's content cannot forge it. The model is told to wait: granting is the owner's act, never the model's.
 */
export const grantRequiredResult = (connectionId: string, name: string, connection: string): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Not granted: ${connection} · ${name}. The owner has been shown an Allow button for this tool. Stop here and wait for their decision; do not retry until they reply.`,
    },
  ],
  isError: true,
  diagnostics: [{ severity: 'info', code: 'GrantDenied', message: 'Owner grant required.' }],
  details: { kind: 'grant-required', connectionId, name },
})

/**
 * What the model gets for a call to a connection the owner has not signed in to (ADR 0063): words it can relay, and a
 * marker the web turns into an owner-only Connect card. The turn ends: signing in is the owner's act, and they say when
 * to continue.
 */
export const connectRequiredResult = (connectionId: string, name: string, connection: string): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Not signed in: ${connection}. The owner has been shown a card to connect it. Stop here and wait until they say to continue.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [
    { severity: 'info', code: 'NeedsAuthorization', message: 'The owner must sign in to this connection.' },
  ],
  details: { kind: 'connect-required', connectionId, name },
})

/**
 * What the model gets for a call beyond what the connection's sign-in granted (ADR 0042): words it can relay, and a
 * marker the web turns into an owner-only card to sign in again with more access. The turn ends: signing in is the
 * owner's act, and they say when to continue.
 */
export const scopeRequiredResult = (
  connectionId: string,
  name: string,
  scope: string,
  connection: string,
): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Needs more access: ${connection} says this call needs ${scope === '' ? 'more access' : `the scope ${scope}`}. The owner has been shown a card to sign in to it again with more access. Stop here and wait until they say to continue.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [{ severity: 'info', code: 'ScopeRequired', message: 'More access required.' }],
  details: { kind: 'scope-required', connectionId, name, scope },
})

/**
 * A model's call the server answered "input required: open this URL" (ADR 0042): goblin's own marker for the owner's
 * card, which reads the link from the kept request. Neither the link nor the server's message is in the result: the
 * transcript is indexed, and approval links can carry one-time tokens. The turn ends; the server's answer comes back
 * once the owner finishes or cancels it.
 */
export const urlRequiredResult = (
  requestId: string,
  connectionId: string,
  name: string,
  connection: string,
): ToolExecutionResult => ({
  content: [
    {
      type: 'text',
      text: `Waiting on the owner: ${connection} · ${name} asks them to finish a step on its site first, and nothing has completed yet. They have a card with the server's link. Once they finish or cancel it, the outcome arrives as a new message from the connection, with the server's answer. Stop and wait; do not call the tool again.`,
    },
  ],
  isError: true,
  control: { terminate: true },
  diagnostics: [
    { severity: 'info', code: 'url_required', message: 'The owner must finish a step on the server first.' },
  ],
  details: { kind: 'url-required', requestId, connectionId, name },
})
