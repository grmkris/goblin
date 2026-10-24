import type { Client } from '@modelcontextprotocol/client'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { UsageError } from './args.ts'

/** The workspaces a sign-in reaches, as `workspace_list` answers them (ADR 0097). */
const Reached = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, slug: Schema.String })),
})

/**
 * The slug of the workspace a chat's stream is under (ADR 0116): the one `named` names, by id or slug, else the
 * sign-in's only one.
 */
export async function slugFor(client: Pick<Client, 'callTool'>, named: string | undefined): Promise<string> {
  const result = await client.callTool({ name: 'workspace_list', arguments: {} })
  const { workspaces } = Schema.decodeUnknownSync(Reached)(result.structuredContent)
  if (named !== undefined) {
    // An id first: a slug is its admins' to choose, so one may look like another workspace's id.
    const chosen =
      workspaces.find((workspace) => workspace.id === named) ?? workspaces.find((workspace) => workspace.slug === named)
    if (chosen === undefined) throw new UsageError(`This sign-in does not reach the workspace ${named}.`)
    return chosen.slug
  }
  const [only, ...others] = workspaces
  if (only === undefined) throw new UsageError('This sign-in reaches no workspace.')
  if (others.length > 0) throw new UsageError('This sign-in reaches several workspaces: name one with --workspace.')
  return only.slug
}

/** Each `data:` frame's JSON of a server-sent event stream, as goblin writes one: one line per event, LF ends. */
export async function* framesOf(body: ReadableStream<Uint8Array>): AsyncGenerator {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of body) {
    pending += decoder.decode(chunk, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) if (line.startsWith('data: ')) yield JSON.parse(line.slice('data: '.length))
  }
}

/** The fields of an AG-UI event the terminal shows; any other is ignored. */
const Event = Schema.Struct({
  type: Schema.String,
  delta: Schema.optional(Schema.String),
  role: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
  toolCallName: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(Schema.Unknown)),
})

/**
 * What an AG-UI event writes to the terminal: a message's words as they come, a line where a run starts or ends or a
 * tool is called, how many messages the opening snapshot holds; nothing for the rest (`--json` shows every event).
 */
export function textOf(frame: unknown): string {
  const event = Option.getOrUndefined(Schema.decodeUnknownOption(Event)(frame))
  if (event === undefined) return ''
  switch (event.type) {
    case 'MESSAGES_SNAPSHOT':
      return `(${event.messages?.length ?? 0} messages so far)\n`
    case 'RUN_STARTED':
      return '▶ working\n'
    case 'RUN_FINISHED':
      return '■ done\n'
    case 'RUN_ERROR':
      return `✗ ${event.message ?? 'the run failed'}\n`
    case 'TEXT_MESSAGE_START':
      return `${event.role ?? 'assistant'}: `
    case 'TEXT_MESSAGE_CONTENT':
      return event.delta ?? ''
    case 'TEXT_MESSAGE_END':
      return '\n'
    case 'TOOL_CALL_START':
      return `→ ${event.toolCallName ?? 'a tool'}\n`
    default:
      return ''
  }
}

/** Where a chat's stream is and who reads it: the CLI's own OAuth token, as a bearer on the workspace's path. */
export type Following = {
  readonly origin: string
  readonly slug: string
  readonly chat: string
  readonly token: string
  readonly json: boolean
}

/**
 * Follow a chat live (ADRs 0110, 0116) until its stream ends or the user stops it: its events as they happen, or each
 * one's JSON on a line with `--json`. Exit 1 when the stream is refused, with goblin's error on stderr.
 */
export async function follow({ origin, slug, chat, token, json }: Following): Promise<number> {
  const response = await fetch(`${origin}/w/${slug}/api/conversations/${encodeURIComponent(chat)}/stream`, {
    headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
  })
  if (!response.ok || response.body === null) {
    console.error(`goblin answered ${response.status}: ${await response.text()}`)
    return 1
  }
  for await (const frame of framesOf(response.body))
    process.stdout.write(json ? `${JSON.stringify(frame)}\n` : textOf(frame))
  return 0
}
