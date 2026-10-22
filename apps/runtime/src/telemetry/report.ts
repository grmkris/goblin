import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import { nowMillis } from '../clock.ts'
import { aliasOf } from '../pi/native-tools.ts'
import { type Answer, answerAttributes, failureAttributes, statusOfStop } from './attributes.ts'
import type { RunTelemetry } from './events.ts'
import { expectedFailure, safeFailureCode } from './safety.ts'

/** A model call made outside a turn: its response, or the error it threw. */
export type AuxCall = { readonly startedAt: number; readonly message?: Answer; readonly error?: unknown }

/** What a model call outside a turn was for (ADR 0024). */
export type AuxPurpose = 'naming' | 'memory' | 'skill' | 'app_llm' | 'retrieval'

/** Records each cheap-model call for `purpose` as one `model.aux` event. */
export const auxReporter =
  (telemetry: RunTelemetry, purpose: AuxPurpose) =>
  (call: AuxCall): void => {
    try {
      recordAux(telemetry, purpose, call)
    } catch {
      // expected: a malformed response is the model's problem, not the caller's; the call goes on unrecorded.
    }
  }

function recordAux(telemetry: RunTelemetry, purpose: AuxPurpose, call: AuxCall): void {
  const endedAt = nowMillis()
  const outcome =
    call.message === undefined
      ? { status: 'error' as const, attributes: failureAttributes(call.error) }
      : { status: statusOfStop(call.message.stopReason), attributes: answerAttributes(call.message) }
  telemetry.record({
    id: telemetry.id('aux', call.startedAt),
    kind: 'model.aux',
    status: outcome.status,
    startedAt: call.startedAt,
    endedAt,
    attributes: {
      [RunAttribute.operation]: 'chat',
      [RunAttribute.purpose]: purpose,
      // A call outside a turn has no start of its own: the model that answered is the best it knows of the one asked.
      ...(call.message === undefined ? {} : { [RunAttribute.requestModel]: call.message.model }),
      ...outcome.attributes,
    },
  })
}

/** The server a step reached, as it last connected (ADR 0107): what it says it is, and its tool list's digest. */
export type McpReached = {
  readonly name?: string | undefined
  readonly version?: string | undefined
  readonly protocolVersion?: string | undefined
  readonly toolsDigest?: string | undefined
}

/** One remote MCP step (mcp/connections/log.ts): which, on which server, how it ended and when. */
export type McpStep = {
  readonly step: 'connect' | 'call' | 'tools' | 'listen' | 'skills' | 'events'
  readonly connectionId: string
  readonly tool?: string
  readonly method?: string
  readonly scope?: { readonly conversationId: string; readonly taskId: string }
  readonly sharedConnection?: boolean
  /** Filled by the manager when the step ends (`reaching`, mcp/connections/log.ts). */
  readonly reached?: McpReached
}

/** The JSON-RPC method a step sends when the step names none (MCP semantic conventions' `mcp.method.name`). */
const METHODS: Partial<Record<McpStep['step'], string>> = {
  connect: 'initialize',
  call: 'tools/call',
  tools: 'tools/list',
}

/**
 * What a step's attributes say of its server and method, for the run ledger and the log line alike: the method, and
 * the server's own name (as an alias, `aliasOf`), version, protocol and tool list digest. Never its address.
 */
export function mcpStepAttributes(step: McpStep): RunAttributes {
  const method = step.method ?? METHODS[step.step]
  const reached = step.reached
  return {
    ...(method === undefined ? {} : { [RunAttribute.mcpMethod]: method }),
    ...(reached?.protocolVersion === undefined ? {} : { [RunAttribute.mcpProtocol]: reached.protocolVersion }),
    ...(reached?.name === undefined ? {} : { [RunAttribute.mcpServerName]: aliasOf(reached.name) }),
    ...(reached?.version === undefined ? {} : { [RunAttribute.mcpServerVersion]: reached.version }),
    ...(reached?.toolsDigest === undefined ? {} : { [RunAttribute.mcpToolsDigest]: reached.toolsDigest }),
  }
}

/** Records each remote MCP step as one `mcp.request` event. */
export const mcpReporter =
  (telemetry: RunTelemetry) =>
  (step: McpStep, outcome: string, startedAt: number, endedAt: number): void => {
    const code = safeFailureCode(outcome)
    telemetry.record({
      id: telemetry.id('mcp', startedAt),
      kind: 'mcp.request',
      ...(step.scope === undefined ? {} : telemetry.scopeOf(step.scope)),
      status: outcome === 'ok' ? 'ok' : expectedFailure(code) ? 'blocked' : 'error',
      startedAt,
      endedAt,
      attributes: {
        [RunAttribute.mcpStep]: step.step,
        [RunAttribute.mcpServer]: step.connectionId,
        ...(step.sharedConnection === true ? { [RunAttribute.sharedConnection]: true } : {}),
        ...(step.tool === undefined ? {} : { [RunAttribute.mcpTool]: step.tool }),
        ...mcpStepAttributes(step),
        ...(outcome === 'ok' ? {} : { [RunAttribute.errorType]: code }),
      },
    })
  }
