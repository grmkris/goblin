import {
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
  defineExtension,
  hook,
} from '@earendil-works/pi-durable'
import { TOOL_SEARCH_TOOL_NAME } from '@earendil-works/pi-durable/tool-search'
import * as Effect from 'effect/Effect'
import { Forbidden } from '../http/errors.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { Setups } from '../setup/service.ts'
import { SEPARATOR } from './native-tools.ts'

// A room (ADR 0108) is a Topic a server's key made, and every chat under it: its Conversation, threads, subagents,
// Persona forks and routine runs, whoever writes there. Only the tools below exist in a room. Pi's tool filter leaves
// the rest out of the tool list (`setup/scope.ts` `piToolsFor`), and this guard refuses them at call time, deny by
// default, so a stale filter, a tool `tool_search` loaded or a tool added later never runs there.

/**
 * The tools a room offers: MCP through the gateway (within the Topic's setup, and the servers the thread declared, ADR
 * 0103), skills, questions to whoever wrote, the room's own chats and memory, a thread's share-back, and `tool_search`
 * for a Persona fork's deferred native tools.
 */
export const ROOM_TOOLS: ReadonlySet<string> = new Set([
  'mcp_list',
  'mcp_call',
  'skill_activate',
  'skill_read',
  'ask_user',
  'search_chats',
  'zoom',
  'share_back',
  TOOL_SEARCH_TOOL_NAME,
])

/**
 * Whether a room offers tool `name`: one of `ROOM_TOOLS`, or a Persona fork's native MCP tool (`<server>__<tool>`, ADR
 * 0101), every call of which `callRemoteTool` checks again as `mcp_call`'s.
 */
export const roomAllows = (name: string): boolean => ROOM_TOOLS.has(name) || name.includes(SEPARATOR)

/** The tools of `extensions` a room does not offer, each name once: what Pi's filter removes in a room. */
export const roomTools = (extensions: readonly Extension[]): readonly ToolRegistration[] => {
  const tools = new Map<string, ToolRegistration>()
  for (const tool of extensions.flatMap((extension) => extension.tools ?? []))
    if (!roomAllows(tool.name) && !tools.has(tool.name)) tools.set(tool.name, tool)
  return [...tools.values()]
}

/** A tool that does not run in a room refuses there (`Forbidden`, `room`) before it does anything. */
export const refuseInRoom = (session: string) =>
  Effect.gen(function* () {
    const scope = yield* Setups.use((setups) => setups.scope(session))
    if (scope.room !== undefined) return yield* new Forbidden({ reason: 'room' })
  })

/** Why the guard blocks a call: the chat is in a room, or whether it is could not be read (it fails closed). */
type RoomVerdict = 'open' | 'room' | 'failed'

const ROOM_BLOCKS: Readonly<Record<Exclude<RoomVerdict, 'open'>, string>> = {
  room: 'This chat is a room: a Topic a server made, where only its own tools run. This tool is not one of them, so it was not run. Answer with what you have here.',
  failed: 'Whether this tool may run here could not be checked, so it was not run. Try again later.',
}

const verdict = (session: string): Effect.Effect<RoomVerdict, never, Setups> =>
  Effect.map(
    Setups.use((setups) => setups.scope(session)),
    (scope): RoomVerdict => (scope.room === undefined ? 'open' : 'room'),
  ).pipe(reportAndRecover('room.beforeTool', 'failed' as const))

/** The check could not run at all (the agent's runtime did not start): the call is blocked as a failed check. */
const reportUnchecked = (error: unknown): RoomVerdict => {
  writeLine('error', { event: 'failure', where: 'room.beforeTool', 'error.type': safeErrorType(error) })
  return 'failed'
}

/**
 * The guard: before every call of a tool a room does not offer, the chat's scope is read, and in a room the call is
 * blocked. A tool a room offers runs without the read. Pi reports and swallows hook exceptions, so the guard blocks
 * rather than throws.
 */
export function roomGuardExtension(run: RunProgram): Extension {
  return defineExtension({
    name: 'goblin.room',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api) => {
          if (roomAllows(call.name)) return undefined
          const found = await run(verdict(String(api.conversationId))).catch(reportUnchecked)
          return found === 'open' ? undefined : { block: ROOM_BLOCKS[found] }
        },
      }),
    ],
  })
}

const refused = (text: string): ToolExecutionResult => ({
  output: [{ type: 'text', text }],
  isError: true,
  diagnostics: [{ severity: 'error', code: 'forbidden', message: text }],
})

/** `tool` refusing in a room (`refuseInRoom`) before it runs. */
const outsideRoom = (run: RunProgram, tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    const inRoom = await run(
      refuseInRoom(String(api.conversationId)).pipe(
        Effect.as(false),
        Effect.catchTag('Forbidden', () => Effect.succeed(true)),
      ),
    )
    return inRoom ? refused(ROOM_BLOCKS.room) : tool.execute(args, api, context)
  },
})

/**
 * `extension` with each of its tools a room does not offer refusing in a room before it runs: behind the guard, for a
 * call the guard did not see. An extension with no such tool is itself.
 */
export function outsideRooms(run: RunProgram, extension: Extension): Extension {
  const tools = extension.tools ?? []
  if (tools.every((tool) => roomAllows(tool.name))) return extension
  return { ...extension, tools: tools.map((tool) => (roomAllows(tool.name) ? tool : outsideRoom(run, tool))) }
}
