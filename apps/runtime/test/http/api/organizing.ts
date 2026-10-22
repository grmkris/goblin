import { OrganizeGroup, PersonasGroup, TopicsGroup } from '@goblin/contracts/api'
import type { FlowEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import { ChatOperations, Chats, Conversations } from '../../../src/chats/service.ts'
import { RoutineControl, RoutineRuns } from '../../../src/routines/service.ts'
import { AgentInput } from '../../../src/runtime/input.ts'
import { PiSessions } from '../../../src/pi/sessions.ts'
import { Apps } from '../../../src/apps/service.ts'
import { delegationServices } from '../../../src/layers/delegation.ts'
import { KeyedLock } from '../../../src/observability/lock.ts'
import { Changes, makeChanges } from '../../../src/runtime/changes.ts'
import { McpConnections, McpGrants, McpServers, Resident } from '../../../src/mcp/service.ts'
import { AppEngine } from '../../../src/agent-apps/service.ts'
import { Setups } from '../../../src/setup/service.ts'
import { Skills } from '../../../src/skills/service.ts'
import { Sources } from '../../../src/sources/service.ts'
import { FlowEvents } from '../../../src/observability/flows.ts'
import { OrganizeHandlers } from '../../../src/organize/api.ts'
import { PersonasHandlers } from '../../../src/personas/api.ts'
import { OrganizeReceipts } from '../../../src/organize/receipts.ts'
import { PersonaRegistry } from '../../../src/personas/registry.ts'
import { appConversations } from '../../../src/storage/schema.ts'
import { TopicsHandlers } from '../../../src/topics/api.ts'
import { TopicRegistry } from '../../../src/topics/registry.ts'
import { currentResident, database, serve, served, sqliteDb, stub } from './fixture.ts'
import { unread } from '../../fake.ts'

/**
 * What a Topic's setup is chosen from here: one server `notes` with its granted tool `read`, no skills and no apps. A
 * change of a setup's subagents is counted in `retooled`, and no routine lives in any Topic.
 */
const setupServices = (retooled: number[]) =>
  Layer.mergeAll(
    stub(McpServers, {
      list: () =>
        Effect.succeed([
          {
            connectionId: 'notes',
            label: 'Notes',
            endpoint: 'https://notes.test/mcp',
            status: 'connected',
            live: true,
            source: 'config',
          },
        ]),
    }),
    stub(McpGrants, { list: () => Effect.succeed([{ connectionId: 'notes', capability: 'tool', name: 'read' }]) }),
    stub(Skills, { sources: () => Effect.succeed([]), catalog: () => Effect.succeed({ skills: [], unavailable: [] }) }),
    stub(AppEngine, { summaries: Effect.succeed([]) }),
    stub(Setups, {
      retoolTopic: (topic) => Effect.sync(() => void retooled.push(topic)),
      routinesOutside: () => Effect.succeed([]),
    }),
  )

/**
 * The organizing groups (topics, personas, organize) as the agent serves them: lane D's services over real Topic,
 * Persona and receipt stores on SQLite. The gate's resident authority is the only fake. Nothing here
 * has an open chat to stop, an agent app or an MCP App, so Pi, Stop, the apps and the MCP host are never read.
 */
export const organizing = () => {
  const db = database()
  db.insert(appConversations).values({ chatId: '1', piSession: '1', kind: 'main', role: 'primary', createdAt: 1 }).run()
  let sessions = 100
  const topics = new TopicRegistry(db, {
    open: () => Effect.sync(() => String(sessions++)),
    register: (chat, topic, name, now) =>
      void db
        .insert(appConversations)
        .values({
          chatId: chat,
          piSession: chat,
          kind: 'main',
          role: 'conversation',
          title: name,
          topicId: topic,
          createdAt: now,
        })
        .run(),
    activate: () => Effect.void,
    seed: () => Effect.void,
    touched: () => Effect.void,
    retitle: () => undefined,
  })
  // `sub/opus` stands for one of the owner's own subscriptions (ADR 0087).
  const personas = new PersonaRegistry(db, () => ['model-a', 'model-b', 'sub/opus'])
  const receipts = new OrganizeReceipts(
    db,
    (kind, target) => (kind.startsWith('topic.') ? topics : personas).get(Number(target)).revision,
  )
  // Current, counting the gate's grants; the organizing programs ask it only to `require` itself.
  const resident = currentResident()
  // A Topic created here has no open chat, so an archive (an Undo of its creation) reads only `openIn`.
  const conversations = stub(Conversations, { openIn: () => Effect.succeed([]) })
  const flows: FlowEvent[] = []
  const retooled: number[] = []
  const catalog = setupServices(retooled)
  const changes = Layer.succeed(Changes, makeChanges())
  const lane = delegationServices({
    topics,
    personas,
    invocations: unread,
    receipts,
    fence: { ownerOnly: (id: string) => id === 'sub/opus', keyTopic: () => false },
  }).pipe(Layer.provide(Layer.merge(KeyedLock.layer, changes)))
  const { fetch } = serve(
    served(
      [TopicsGroup, PersonasGroup, OrganizeGroup],
      Layer.mergeAll(TopicsHandlers, PersonasHandlers, OrganizeHandlers),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          lane,
          conversations,
          stub(AgentInput),
          // No chat here is a Persona's fork: a reply to a hold finds none. A Topic's one chat is its own topic's.
          stub(Chats, {
            personaFork: () => Effect.succeed(Option.none()),
            topicOf: (chat) => Effect.succeed(topics.list().find((topic) => topic.conversation === chat)?.id ?? 1),
          }),
          // A reply to a hold finds no fork here, so it records no receipt.
          stub(ChatOperations),
          // What API keys made (ADR 0081), on the same SQLite.
          sqliteDb(db),
          stub(PiSessions),
          stub(RoutineRuns),
          stub(RoutineControl),
          stub(Apps),
          stub(McpConnections, { snapshot: () => Effect.succeed(Option.none()) }),
          // Only a Source's route receipt reaches the Sources.
          stub(Sources),
          catalog,
          // A key's create tells the views that it made what it made (ADR 0108).
          changes,
          Layer.succeed(Resident, resident.service),
          FlowEvents.layerWith((event) => Effect.sync(() => void flows.push(event))),
        ),
      ),
    ),
  )
  return { fetch, db, resident, topics, personas, receipts, flows, retooled }
}
