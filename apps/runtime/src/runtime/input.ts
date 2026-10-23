import type { Extension } from '@earendil-works/pi-durable'
import type { PiHarness } from 'agents/harness/pi'
import type { KeyOrigin } from '@goblin/contracts'
import * as Context from 'effect/Context'
import type { AgentApps } from '../agent-apps/engine.ts'
import type { Applied, Retooled } from '../agent-model.ts'
import type { MoverPorts } from '../chats/mover.ts'
import type { RuntimeEnv } from '../env.ts'
import type { PersonaTurnKit } from '../organize/kit.ts'
import type { PiModels } from '../pi/harness.ts'
import type { MemoryKit } from '../pi/memory.ts'
import type { StartRoutine } from '../pi/routine-run.ts'
import type { SubagentKit } from '../pi/subagents.ts'
import type { RoutineSchedules } from '../routines/scheduler.ts'
import type { ToolSets } from '../setup/scope.ts'
import type { RunTelemetry } from '../telemetry/events.ts'
import type { PublishFetch } from '../publish/deliver.ts'
import type { Instrument } from './instrument.ts'

/**
 * What the agent's programs and services need from its Durable Object instance, as one record: its storage and env,
 * the Pi pieces its constructor made, and the callbacks into the instance (schedules). A program
 * reads it instead of taking these as arguments. Built once per runtime from the instance (agent.ts).
 */
export interface AgentInputs {
  readonly storage: DurableObjectStorage
  readonly env: RuntimeEnv
  /** The workspace the agent belongs to (ADR 0089): its ID, which is the agent's name. */
  readonly workspaceId: string
  readonly harness: PiHarness
  readonly pi: PiModels
  readonly thread: Extension
  readonly memory: MemoryKit
  /** What Pi's tool filter chooses from: the subagent tools, and every tool of the agent's (ADR 0115). */
  readonly toolSets: ToolSets
  readonly helperExtensions: readonly Extension[]
  readonly subagents: SubagentKit
  readonly personas: PersonaTurnKit
  /** The model each session was last put on (agent-model.ts). */
  readonly applied: Applied
  /** The tool filter this lifetime applied to each session before a turn, by its sender's power (agent-model.ts, ADR 0115). */
  readonly retooled: Retooled
  /** The native schedules the routines arm and cancel, and their sweep's alarm (routines/wake.ts). */
  readonly routineSchedules: RoutineSchedules
  /** Starts a routine run's Pi work: the routines kit's, made before Pi opened (routines/kit.ts). */
  readonly startRoutine: StartRoutine
  readonly scheduleEvents: (at: number) => Promise<void>
  /** Arms the published Events' alarm (`publishWake`, ADR 0112) no later than `at` (epoch ms). */
  readonly schedulePublish: (at: number) => Promise<void>
  /** How the published Events' webhooks leave the agent (`publish/deliver.ts`); the harness points it at a receiver. */
  readonly publishFetch: PublishFetch
  /** Schedules the Sources' alarm (sourcesWake) in `seconds` (ADR 0066). */
  readonly scheduleSources: (seconds: number) => void
  readonly mcpFetch: typeof fetch
  /**
   * The origins grant `grantId` gives its threads in this workspace now (ADRs 0091, 0114), none once it is gone or
   * ended: what a thread's declared servers are checked against at every use (ADR 0103).
   */
  readonly grantOrigins: (grantId: string) => Promise<readonly KeyOrigin[] | undefined>
  /** The agent's apps, made before Pi opened (their tools are Pi's). */
  readonly agentApps: AgentApps
  /** The run ledger and log lines the agent's services report to (ADR 0024). */
  readonly telemetry: RunTelemetry
  /** Move to thread (ADR 0034): hands the moved turn's relays to the Thread, and the boundaries tests stop at. */
  readonly moves: MoverPorts
  /** How the bridge's programs and the change handlers are wrapped (instrument.ts). */
  readonly instrument: Instrument
}

/** The agent's inputs as a service, provided once per runtime (layers/core.ts). */
export class AgentInput extends Context.Service<AgentInput, AgentInputs>()('goblin/runtime/AgentInput') {}
