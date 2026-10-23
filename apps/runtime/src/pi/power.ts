import {
  type Extension,
  type ToolExecutionResult,
  type ToolRegistration,
  ToolTask,
  defineExtension,
  hook,
} from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import { mirrorReaches } from '../grants/mirror.ts'
import { CLOSED_VIEW, viewOf } from '../files/folders.ts'
import { type Effective, type ToolNeed, allows, effectivePower, turnBoundary } from '../grants/power.ts'
import { Forbidden } from '../http/errors.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover, safeErrorType } from '../observability/report.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { Db } from '../runtime/db.ts'
import { Setups } from '../setup/service.ts'
import { BOUNDARY_TEXT, type CallApi, POWER_TEXT, turnPower } from './asker.ts'
import type { PiContext } from './context.ts'
import { anyTurn, needOf } from './tool-needs.ts'

// A turn's power (ADR 0115) at call time. The offered-tool filter (`setup/scope.ts` `piToolsFor`) leaves out what the
// sender of a turn's input may not use; this guard refuses it at every call, deny by default, whatever the filter says:
// a filter set for another sender's turn, one stored before a deploy, a tool `tool_search` loaded or a tool added later
// that `pi/tool-needs.ts` does not know. Every tool that needs more than a read refuses again before it runs
// (`outsidePower`), for a call the guard did not see.

/**
 * What the call `api` serves may do where it runs: its run's power (`turnPower`) bounded by its chat's setup and
 * boundary, and a credential's connections by its grant's list. None for a session no chat owns, which may do nothing.
 */
export const effectiveOf = (api: CallApi, context: PiContext) =>
  Effect.gen(function* () {
    const scope = yield* Setups.use((setups) => setups.scope(String(api.conversationId)))
    if (scope.boundary === undefined) return undefined
    const power = yield* turnPower(api, context)
    const db = yield* Db
    return effectivePower(power, scope, scope.boundary, (grant, connection) =>
      mirrorReaches(db, grant, 'connection', connection),
    )
  })

/**
 * The files the call `api` serves reaches (ADR 0115): its Topic's folder (every Topic's from a hub its power reaches),
 * the Shared folder on a person's turn, and its own Topic's `agent` folder to write. A session no chat owns reaches no
 * file.
 */
export const turnFileView = (api: CallApi, context: PiContext) =>
  Effect.map(effectiveOf(api, context), (effective) =>
    effective === undefined ? CLOSED_VIEW : viewOf(turnBoundary(effective), effective.people),
  )

/**
 * Whether the call `api` serves may use MCP connection `connectionId` (ADR 0115): every credential whose connections
 * are a list that sent one of its inputs lists it. The setup holding it is the chat's scope's to say.
 */
export const reachesConnection = (api: CallApi, context: PiContext, connectionId: string) =>
  Effect.gen(function* () {
    const power = yield* turnPower(api, context)
    if (power.connectionLists.length === 0) return true
    const db = yield* Db
    return power.connectionLists.every((grant) => mirrorReaches(db, grant, 'connection', connectionId))
  })

/** Why a call is refused: its tool is unknown, its turn may not use it, or what it may could not be read. */
type Verdict = 'open' | 'unknown' | 'power' | 'boundary' | 'failed'

const BLOCKS: Readonly<Record<Exclude<Verdict, 'open'>, string>> = {
  unknown: 'This tool is not one goblin knows what a turn needs for, so it was not run.',
  power: POWER_TEXT,
  boundary: BOUNDARY_TEXT,
  failed: 'Whether this tool may run here could not be checked, so it was not run. Try again later.',
}

/** Whether a turn with `effective` power may use a tool that needs `need`, and if not, why. */
const verdictOf = (effective: Effective | undefined, need: ToolNeed): Verdict => {
  if (effective === undefined) return 'power'
  if (allows(effective, need)) return 'open'
  // A tool the turn's own power reaches, refused only because its chat is not a hub, is refused for its boundary.
  return allows({ ...effective, hub: true }, need) ? 'boundary' : 'power'
}

/** The verdict on a tool that needs `need` for the call `api` serves; a check that cannot run fails closed. */
const verdict = (api: CallApi, context: PiContext, need: ToolNeed) =>
  Effect.map(effectiveOf(api, context), (effective) => verdictOf(effective, need)).pipe(
    reportAndRecover('power.beforeTool', 'failed' as const),
  )

/**
 * The verdict on tool `name` for the call `api` serves: a tool the table does not know never runs, one every turn may
 * use runs without reading anything, and any other is judged by its turn's power through `run`.
 */
const judged = async (run: RunProgram, api: CallApi, context: PiContext, name: string): Promise<Verdict> => {
  const need = needOf(name)
  if (need === undefined) return 'unknown'
  if (anyTurn(need)) return 'open'
  return run(verdict(api, context, need)).catch(reportUnchecked)
}

/** The check could not run at all (the agent's runtime did not start): the call is blocked as a failed check. */
const reportUnchecked = (error: unknown): Verdict => {
  writeLine('error', { event: 'failure', where: 'power.beforeTool', 'error.type': safeErrorType(error) })
  return 'failed'
}

/**
 * The guard, selected by every conversation, helper and routine run: before every call, the tool's need
 * (`pi/tool-needs.ts`) against its turn's power where it runs. A tool every turn may use runs without the read; a tool
 * the table does not know never runs. Pi reports and swallows hook exceptions, so the guard blocks rather than throws.
 */
export function powerGuardExtension(run: RunProgram): Extension {
  return defineExtension({
    name: 'goblin.power',
    hooks: [
      hook(ToolTask, {
        beforeTool: async (call, api, context) => {
          const found = await judged(run, api, context, call.name)
          return found === 'open' ? undefined : { block: BLOCKS[found] }
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

/** `tool` checked against its turn's power before it runs: refused, it does nothing. */
const checked = (run: RunProgram, tool: ToolRegistration): ToolRegistration => ({
  ...tool,
  execute: async (args, api, context) => {
    const found = await judged(run, api, context, tool.name)
    return found === 'open' ? tool.execute(args, api, context) : refused(BLOCKS[found])
  },
})

/**
 * `extension` with each of its tools that needs more than a read checking its turn's power before it runs: behind the
 * guard, for a call the guard did not see. An extension with no such tool is itself.
 */
/** Whether every turn may use `tool`, so it runs without a check. */
const open = (tool: ToolRegistration): boolean => {
  const need = needOf(tool.name)
  return need !== undefined && anyTurn(need)
}

export function outsidePower(run: RunProgram, extension: Extension): Extension {
  const tools = extension.tools ?? []
  if (tools.every(open)) return extension
  return { ...extension, tools: tools.map((tool) => (open(tool) ? tool : checked(run, tool))) }
}

/** `Forbidden` `power` or `boundary` for the call `api` serves, when its power does not reach `need` where it runs. */
export const requireNeed = (api: CallApi, context: PiContext, need: ToolNeed) =>
  Effect.gen(function* () {
    const found = verdictOf(yield* effectiveOf(api, context), need)
    if (found !== 'open') return yield* new Forbidden({ reason: found === 'boundary' ? 'boundary' : 'power' })
  })

/** Every tool of `extensions`, each name once: what Pi's filter chooses from (`ToolSets.all`). */
export const toolsOf = (extensions: readonly Extension[]): readonly ToolRegistration[] => {
  const tools = new Map<string, ToolRegistration>()
  for (const tool of extensions.flatMap((extension) => extension.tools ?? []))
    if (!tools.has(tool.name)) tools.set(tool.name, tool)
  return [...tools.values()]
}
