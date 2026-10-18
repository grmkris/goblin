import { WorkspacePlanProposal, WorkspacePlanView } from '@goblin/contracts'
import { defineExtension, section } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Chats } from '../chats/service.ts'
import { Forbidden, NotFound } from '../http/errors.ts'
import { requireResident } from '../mcp/service.ts'
import { Setups } from '../setup/service.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { proposeWorkspacePlan } from '../workspace-plans/program.ts'
import { WorkspacePlans } from '../workspace-plans/service.ts'
import { typedTool } from './typed-tool.ts'

const GUIDE =
  'When the owner asks you to set up a workflow or connect an outside conversation, compose the existing building blocks. Discover their connections with mcp_list, use mcp_suggest and mcp_request_server only when a needed connection is missing, and activate relevant owner-enabled skills. Create the requested Topics and Personas with organize tools, then use workspace_propose for one review of all Sources and routines together. Sources use the same setup as source_propose but route to numeric Topic and Persona ids returned by organize tools. Proposing grants nothing. The owner reviews exact definitions in the chat and activates them together. workspace_status reads durable progress. A ready setup means configuration applied, not a verified reply or external completion. Never claim shared-group privacy: cross-Topic retrieval is not isolated yet; explain that limitation before proposing a shared conversation.'

/** Composition tools available only to owner conversations, never helpers, Personas or routine runs. */
export function workspacePlansExtension(run: RunProgram) {
  return defineExtension({
    name: 'goblin.workspace-plans',
    sections: [section('workspace-plans', () => GUIDE)],
    tools: [
      typedTool({
        name: 'workspace_propose',
        description:
          'Prepare several Sources and routines together as one durable setup review. First discover actual MCP schemas and create the requested Topics or Personas. Give a short title and purpose, Source setups (numeric route ids), and routines with their Topic ids and full definitions. Creates proposals only. The owner activates the exact reviewed setup; this ends the turn.',
        input: WorkspacePlanProposal,
        output: WorkspacePlanView,
        replay: 'safe',
        execute: async (proposal, api) =>
          run(
            Effect.gen(function* () {
              const session = String(api.conversationId)
              yield* requireResident
              const scope = yield* (yield* Setups).scope(session)
              if (!scope.editable) return yield* new Forbidden({ reason: 'workspace_plan_owner_only' })
              const chat = yield* (yield* Chats).chatOf(session)
              if (Option.isNone(chat)) return yield* new NotFound({ what: 'chat' })
              return yield* proposeWorkspacePlan(proposal, chat.value, `workspace:${session}:${api.callId}`)
            }),
          ),
        text: (plan) =>
          plan.state === 'preparing'
            ? `Setup "${plan.title}" (${plan.id}) needs preparation retried: ${plan.problem ?? 'interrupted'}. Nothing is activated.`
            : `Prepared "${plan.title}" (${plan.id}) for the owner to review. Nothing is activated yet.`,
        details: (plan) => ({ kind: 'workspace-plan', setupId: plan.id, revision: plan.revision }),
        terminate: () => true,
      }),
      typedTool({
        name: 'workspace_status',
        description:
          'Read durable setup progress, including exact reviewed Sources and routines. Ready means configured, not external delivery verified.',
        input: Schema.Struct({ id: Schema.String }),
        output: WorkspacePlanView,
        replay: 'safe',
        execute: async ({ id }) =>
          run(
            Effect.andThen(
              requireResident,
              WorkspacePlans.use((plans) => plans.get(id)),
            ),
          ),
      }),
    ],
  })
}
