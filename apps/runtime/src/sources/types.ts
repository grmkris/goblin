import type { SourceSetup } from '@goblin/contracts'
import type { KeptAttachments } from '../pi/content.ts'
import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { McpToolResult } from '../mcp/connections/types.ts'
import type { LedgerInput, turnLedger } from './delivery.ts'
import type { SourceRow } from './store.ts'
import type { Answer, ReplyRef, Turn } from './turns.ts'

/** An untrusted notice to the owner from a Source: kept once by its id, in `topic` (Personal when none). */
export type SourceNotice = {
  readonly id: string
  readonly sourceId: string
  readonly connectionId: string
  readonly label: string
  readonly topic: number | undefined
  readonly title: string
  readonly body?: string
}

/** What the Sources' engine needs from the agent: the connection's tools, the Topics, the end of a turn, notices. */
export interface SourcePorts {
  /**
   * A tool of a Source's connection, called for the agent itself under the owner's exact grant (an Ask-first tool is
   * refused, never asked): its structured result. An error result fails.
   */
  readonly call: (connectionId: string, tool: string, args: Record<string, unknown>) => Effect.Effect<unknown, AppError>
  /** A reply retains the whole MCP result and rechecks the Source immediately before dispatch. */
  readonly send: (
    connectionId: string,
    tool: string,
    args: Record<string, unknown>,
    authorize: Effect.Effect<void, AppError>,
  ) => Effect.Effect<McpToolResult, AppError>
  /** The owner's message as a turn in the Topic (idempotent by operation id), answered by `persona` while it is active. */
  readonly submit: (
    turn: Turn,
    persona?: number,
  ) => Effect.Effect<{ readonly chatId: string; readonly persona?: number }, AppError>
  /** The owner's message kept in the Topic as a note, with no turn (idempotent by operation id). */
  readonly keep: (turn: Turn) => Effect.Effect<void, AppError>
  /** How a turn ended, once it has; undefined while it runs. */
  readonly answer: (reply: ReplyRef) => Effect.Effect<Answer | undefined, AppError>
  /** A notice to the owner, framed as untrusted data from the connection. */
  readonly notice: (notice: SourceNotice) => Effect.Effect<void, AppError>
  /**
   * A message's attachments (MCP content blocks) kept in the owner's files with `materialize` (ADR 0065): the files, a
   * note for each one not kept, and small images for a model that sees them. It never fails.
   */
  readonly receive: (connectionId: string, blocks: readonly unknown[]) => Effect.Effect<KeptAttachments>
  /** A new Topic named `name` (`fallback` when it has no words) for a conversation, made once by `operationId`. */
  readonly topic: (name: string, fallback: string, operationId: string) => Effect.Effect<number, AppError>
  /** The connection's label: the owner's own name for it. */
  readonly label: (connectionId: string) => Effect.Effect<string>
}

/** What the engine is made over: the agent's database and run ledger, and the alarm that sends what is owed. */
export type EngineInput = LedgerInput & {
  /** Asks the agent to run the Sources' alarm in `seconds`. */
  readonly wake: (seconds: number) => void
}

/** What the engine's steps share: the agent's database, the run ledger's lines and the alarm. */
export type EngineContext = {
  readonly db: DrizzleSqliteDODatabase
  readonly record: ReturnType<typeof turnLedger>
  readonly wake: (seconds: number) => void
}

/** One answer's delivery: its turn's operation, how many pieces it took, and why it failed if it did. */
export type SourceDelivery = { readonly operationId: string; readonly pieces: number; readonly errorType?: string }

/** A Source as the engine works with it: its row and its decoded setup. */
export type Loaded = { readonly row: SourceRow; readonly setup: SourceSetup }
