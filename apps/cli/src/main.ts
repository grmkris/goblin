#!/usr/bin/env bun
import { InspectEntries, OtlpTraceData } from '@goblin/contracts/inspect'
import type { Client } from '@modelcontextprotocol/client'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { type Args, UsageError, flagText, parseArgs } from './args.ts'
import { type ToolInfo, argumentsFor, commandOf, usage } from './commands.ts'
import { type Settings, settingsOf } from './config.ts'
import { accessToken, connect, logout } from './connect.ts'
import { follow, slugFor } from './follow.ts'
import { type ReadEntries, traceIdOf, withContent } from './otlp.ts'
import { failureText, render } from './render.ts'
import { appCredentials, appToken } from './token.ts'

const HELP = `goblin: your goblin agent from the terminal, as an MCP client of /mcp (ADR 0024)

  goblin login                 sign in and approve (once per machine and origin)
  goblin tools                 the commands this server offers
  goblin problems [--since …]  what failed, was blocked or cut short
  goblin turns                 recent turns, one line each
  goblin turn <operation id>   one turn end to end
  goblin turn <id> --otlp      the same as an OpenTelemetry trace with its words, for a trace viewer
  goblin conversation <id>     a conversation's entries, in full
  goblin flows [--chat 12]     how conversations moved: sends, replies, threads, moves, Personas, Delegates
  goblin details --operation <id>   what happened behind one message
  goblin follow <chat>         a chat live, as it happens (--json: each of its AG-UI events)
  goblin token                 an installed app's access token, from GOBLIN_CLIENT_ID and GOBLIN_CLIENT_SECRET (ADR 0118)
  goblin logout

  --origin URL   your goblin's address (or GOBLIN_ORIGIN); required
  --json         print the tool's structured result
  --open         open the sign-in page in a browser
  --port N       the sign-in callback's loopback port (default 18979)`

type CallResult = { readonly isError?: unknown; readonly structuredContent?: unknown; readonly content?: unknown }

const errorText = (result: CallResult): string =>
  Array.isArray(result.content)
    ? result.content
        .map((block: unknown) =>
          typeof block === 'object' && block !== null && 'text' in block ? String(block.text) : '',
        )
        .join('\n')
    : 'the tool failed'

async function listTools(client: Client): Promise<readonly ToolInfo[]> {
  return (await client.listTools()).tools
}

/** One tool, as its command: arguments from its own schema, a rendered result, exit 1 on a tool error. */
async function runTool(client: Client, args: Args, settings: Settings): Promise<number> {
  const tools = await listTools(client)
  const tool = tools.find((candidate) => commandOf(candidate.name) === args.command)
  if (tool === undefined)
    throw new UsageError(
      `No command ${args.command}. Commands: ${tools.map((each) => commandOf(each.name)).join(', ')}`,
    )
  if (args.flags.get('help') === true) {
    console.log(usage(tool))
    return 0
  }
  const result: CallResult = await client.callTool({ name: tool.name, arguments: argumentsFor(tool, args, Date.now()) })
  if (result.isError === true) {
    console.error(failureText(errorText(result)))
    return 1
  }
  if (tool.name === 'inspect_turn' && args.flags.get('otlp') === true)
    return printTrace(client, tools, result.structuredContent, settings)
  console.log(
    settings.json
      ? JSON.stringify(result.structuredContent ?? null, null, 2)
      : render(args.command ?? '', result.structuredContent),
  )
  return 0
}

/**
 * A turn's trace as OTLP/JSON on stdout, with its words read on this machine when the sign-in may read conversations
 * (ADR 0107), and where to see it on stderr: post it to any OTLP receiver's `/v1/traces`.
 */
async function printTrace(
  client: Client,
  tools: readonly ToolInfo[],
  structured: unknown,
  settings: Settings,
): Promise<number> {
  const trace = Schema.decodeUnknownSync(OtlpTraceData)(structured)
  const { workspace } = settings
  const read: ReadEntries = async (conversation, before) => {
    const result: CallResult = await client.callTool({
      name: 'inspect_conversation',
      arguments: {
        conversation,
        ...(before === undefined ? {} : { before }),
        ...(workspace === undefined ? {} : { workspace }),
      },
    })
    return result.isError === true
      ? undefined
      : Option.getOrUndefined(Schema.decodeUnknownOption(InspectEntries)(result.structuredContent))
  }
  const words = tools.some((each) => each.name === 'inspect_conversation')
  console.log(JSON.stringify(words ? await withContent(trace, read) : trace))
  if (!words) console.error('No words: this sign-in cannot read conversations in full.')
  const id = traceIdOf(trace)
  if (id !== undefined)
    console.error(
      `trace ${id}: post it to an OTLP receiver's /v1/traces (local Jaeger: http://127.0.0.1:16686/trace/${id})`,
    )
  return 0
}

async function withClient(settings: Settings, args: Args, work: (client: Client) => Promise<number>): Promise<number> {
  const client = await connect(settings, args.flags.get('open') === true)
  try {
    return await work(client)
  } finally {
    await client.close()
  }
}

/** Inspection is opt-in on the consent page (ADR 0024); without it the commands have nothing to read. */
const NO_INSPECTION =
  'This sign-in cannot inspect your agent. Run goblin logout, then goblin login, and turn on "Also let it read how your chats ran" and "Also let it read your conversations in full" on the consent page.'

async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv)
  if (args.command === undefined || args.command === 'help') {
    console.log(HELP)
    return 0
  }
  const settings = await settingsOf(args)
  switch (args.command) {
    case 'login':
      return withClient(settings, args, async (client) => {
        console.error(`Signed in to ${settings.endpoint.href}.`)
        if (!(await listTools(client)).some((tool) => tool.name.startsWith('inspect_'))) console.error(NO_INSPECTION)
        return 0
      })
    case 'logout':
      await logout(settings)
      console.error(`Signed out of ${settings.endpoint.href} on this machine. Revoke the client in Settings to end it.`)
      return 0
    case 'tools':
      return withClient(settings, args, async (client) => {
        for (const tool of await listTools(client))
          console.log(`${commandOf(tool.name).padEnd(14)} ${tool.description ?? ''}`)
        return 0
      })
    case 'follow':
      return withClient(settings, args, async (client) => {
        const [chat] = args.positionals
        if (chat === undefined) throw new UsageError('goblin follow <chat>: name the chat to follow.')
        const slug = await slugFor(client, settings.workspace)
        const token = await accessToken(settings)
        return follow({ origin: settings.origin, slug, chat, token, json: settings.json })
      })
    case 'token': {
      const { token } = await appToken(settings.origin, await appCredentials(flagText(args, 'client-id')))
      console.log(token)
      return 0
    }
    default:
      return withClient(settings, args, (client) => runTool(client, args, settings))
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (error) {
  // expected: the CLI's last resort prints what failed and exits non-zero (2 for a usage error).
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = error instanceof UsageError ? 2 : 1
}
