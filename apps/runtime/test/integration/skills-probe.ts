import { drizzle } from 'drizzle-orm/durable-sqlite'
import { eq } from 'drizzle-orm'
import { createMcpHandler } from '@modelcontextprotocol/server'
import type { FileEntry } from '@goblin/contracts'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { ChatId } from '../../src/chats/directory.ts'
import { Chats, Conversations } from '../../src/chats/service.ts'
import { Files } from '../../src/files/service.ts'
import { NotFound } from '../../src/http/errors.ts'
import { makeManager } from '../../src/mcp/connections/manager.ts'
import { McpConnections } from '../../src/mcp/service.ts'
import { Notices } from '../../src/notices/service.ts'
import { Changes, makeChanges } from '../../src/runtime/changes.ts'
import type { McpManagerOptions } from '../../src/mcp/connections/types.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { PiSessions } from '../../src/pi/sessions.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'
import { SKILLS_EXTENSION } from '../../src/skills/protocol.ts'
import { makeSkills } from '../../src/skills/library.ts'
import { Learner, Skills } from '../../src/skills/service.ts'
import { SqliteSkillState } from '../../src/skills/store.ts'
import { digestOf } from '../../src/skills/verify.ts'
import { runApplicationMigrations } from '../../src/storage/migrations.ts'
import { type Probes, inAgent } from './probe.ts'
import { appSkillFiles } from '../../src/storage/schema.ts'
import { appSkillDrafts } from '../../src/storage/schema.ts'
import { makeLearner } from '../../src/skills/learner.ts'
import { SqliteDraftLog } from '../../src/skills/store.ts'
import { CheapModel } from '../../src/memory/model.ts'
import { scriptedStreams } from './model.ts'
import { makePiModels } from '../../src/pi/model.ts'
import { conversationId } from '../../src/pi/context.ts'
import type { PiHarness } from 'agents/harness/pi'
import { lowLevelServer } from '../mcp/low-level-server.ts'
import { servicesOf } from '../mcp/runtime.ts'

/** One skill as a library lists it: its `SKILL.md` at `uri` is the one resource. */
interface ListedSkill {
  readonly uri: string
  readonly frontmatter: { readonly name: string; readonly description: string }
  readonly resources: readonly { readonly uri: string; readonly digest: string; readonly size: number }[]
}

/**
 * A skills library server `name` that lists `entry` and serves `body` as its file, `read` hearing each read; with
 * `tools`, it also declares tools for the test to answer.
 */
function libraryServer(name: string, entry: ListedSkill, body: Uint8Array, tools: boolean, read = () => {}) {
  const server = lowLevelServer(
    { name, version: '1' },
    { capabilities: { resources: {}, ...(tools ? { tools: {} } : {}), extensions: { [SKILLS_EXTENSION]: {} } } },
  )
  server.setRequestHandler(
    'skills/list',
    { params: Schema.toStandardSchemaV1(Schema.Record(Schema.String, Schema.Unknown)) },
    () => ({ skills: [entry], ttlMs: 60_000 }),
  )
  server.setRequestHandler('resources/list', () => ({ resources: [] }))
  server.setRequestHandler('resources/templates/list', () => ({ resourceTemplates: [] }))
  server.setRequestHandler('resources/read', () => {
    read()
    return { contents: [{ uri: entry.uri, text: new TextDecoder().decode(body), mimeType: 'text/markdown' }] }
  })
  return server
}

/** The host's options for one skills server `connectionId` reached through `fetch`, with signed-out credentials. */
const managerOver = (
  state: SqliteSkillState,
  connectionId: string,
  fetch: McpManagerOptions['fetch'],
  allows: McpManagerOptions['allows'] = () => false,
): McpManagerOptions => ({
  servers: [{ connectionId, endpoint: `https://${connectionId}.test/mcp` }],
  skillsEnabled: (enabled) => state.enabled(enabled),
  allows,
  auth: () => ({ token: async () => '', onUnauthorized: async () => undefined }),
  fetch,
})

/** The connections over `options`, made as the host makes them. */
export const connectionsLayer = (options: McpManagerOptions) =>
  Layer.effect(McpConnections, Effect.orDie(makeManager(options))).pipe(Layer.provide(SingleFlight.layer))

/** The skills service over connections made from `options`, as the agent's start makes it. */
export const skillsOver = (options: McpManagerOptions, state: SqliteSkillState) =>
  servicesOf(
    Layer.effect(Skills, makeSkills(state)).pipe(
      Layer.provide(Layer.mergeAll(connectionsLayer(options), SingleFlight.layer)),
    ),
  )

/** The real skills service and SQLite cache in workerd; the network boundary alone is injected. */
export async function skillsCacheProbe(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const state = new SqliteSkillState(db)
  const body = new TextEncoder().encode(
    '---\nname: cache-test\ndescription: Verify cached skill bytes.\n---\n\n# Cache test\n',
  )
  const uri = 'skill://skv_111111111111111111111111/cache-test/SKILL.md'
  const digest = await digestOf(body)
  const entry = {
    uri,
    frontmatter: { name: 'cache-test', description: 'Verify cached skill bytes.' },
    resources: [{ uri, digest, size: body.byteLength }],
  } as const
  let reads = 0
  const handler = createMcpHandler(() =>
    libraryServer('skills-fixture', entry, body, false, () => {
      reads += 1
    }),
  )
  const manager = managerOver(state, 'skills', (input, init) => handler.fetch(new Request(input, init)))
  state.setEnabled('skills', true, 1)
  const { run, dispose } = skillsOver(manager, state)
  const library = await run(Skills)
  const first = await run(library.activate('cache-session', 'skills:cache-test'))
  db.update(appSkillFiles)
    // Same size, different bytes: exercise digest verification rather than only a size mismatch.
    .set({ content: btoa(new TextDecoder().decode(body).replace('Cache test', 'False test')), storedAt: 2 })
    .where(eq(appSkillFiles.digest, digest))
    .run()
  const second = await run(library.activate('cache-session', 'skills:cache-test'))
  const repaired = state.file(digest)
  await run(library.activate('cache-session', 'skills:cache-test'))
  await dispose()
  return {
    firstBody: first.body,
    secondBody: second.body,
    reads,
    repaired: repaired !== undefined && new TextDecoder().decode(repaired) === new TextDecoder().decode(body),
  }
}

/** Reconstruct the library from SQLite, reading its retained version with a network boundary that must stay unused. */
export async function skillsPersistedRead(storage: DurableObjectStorage) {
  runApplicationMigrations(storage)
  const state = new SqliteSkillState(drizzle(storage))
  const activation = state.activations('cache-session')[0]
  if (activation === undefined || activation.entry.resources === 'dynamic')
    throw new Error('fixture activation missing')
  const resource = activation.entry.resources[0]
  if (resource === undefined) throw new Error('fixture manifest missing')
  let networkCalls = 0
  const manager = managerOver(state, 'skills', async () => {
    networkCalls += 1
    throw new Error('restart read must use verified persisted bytes')
  })
  const { run, dispose } = skillsOver(manager, state)
  const file = await run(
    Effect.flatMap(Skills, (library) => library.read('cache-session', 'skills:cache-test', 'SKILL.md')),
  )
  const cached = state.file(resource.digest)
  await dispose()
  return {
    activation,
    digest: resource.digest,
    cachedText: cached === undefined ? undefined : new TextDecoder().decode(cached),
    file,
    networkCalls,
  }
}

/** A file entry as the owner's files answer for `path`. */
const fileEntry = (path: string): FileEntry => ({
  path,
  name: path.slice(path.lastIndexOf('/') + 1),
  kind: 'file',
  size: 0,
  mimeType: 'text/markdown',
  updatedAt: 0,
})

/**
 * Real workerd SQLite learner state and MCP transport, with a deterministic scripted cheap model: an improvement of an
 * activated skill is written once to the owner's files (held in memory here), and the same lesson again is a duplicate.
 */
export async function skillsLearnerDraftProbe(storage: DurableObjectStorage, harness: PiHarness) {
  runApplicationMigrations(storage)
  const db = drizzle(storage)
  const state = new SqliteSkillState(db)
  const body = new TextEncoder().encode(
    '---\nname: draft-proof\ndescription: Keep a checksum procedure.\n---\n\n# Checksum procedure\n',
  )
  const uri = 'skill://skv_222222222222222222222222/draft-proof/SKILL.md'
  const entry = {
    uri,
    frontmatter: { name: 'draft-proof', description: 'Keep a checksum procedure.' },
    resources: [{ uri, digest: await digestOf(body), size: body.byteLength }],
  } as const
  const handler = createMcpHandler(() => libraryServer('skills-library', entry, body, false))
  const manager = managerOver(state, 'library', (input, init) => handler.fetch(new Request(input, init)))
  state.setEnabled('library', true, 1)
  const receipt = await harness.submit('Run the checksum procedure.', {
    operationId: 'checksum-procedure',
  })
  await harness.wait(receipt.operationId)
  const decision = JSON.stringify({
    action: 'improve',
    skill: 'library:draft-proof',
    description: 'Verify checksums before submitting a report.',
    body: '1. Calculate the checksum.\n2. Verify it before submitting.',
    evidence: 'The owner corrected the order of checksum verification.',
  })
  const scripted = makePiModels(
    { MODEL_ID: 'learner-fixture', MODEL_BASE_URL: 'https://no-model-calls.invalid', MODEL_KEY: 'unused' },
    scriptedStreams(
      () => undefined,
      () => [{ type: 'text', text: decision }],
    ),
  )
  /** The owner's files the learner wrote, and the notices it claimed. */
  const written = new Map<string, string>()
  const notices: string[] = []
  // SAFETY: PiSessions reads only the harness from the agent's inputs.
  const input = Object.assign(Object.create(null), { harness }) as AgentInputs
  const { run, dispose } = servicesOf(
    Layer.effectContext(
      Effect.gen(function* () {
        const skills = yield* makeSkills(state)
        const learner = yield* makeLearner({
          drafts: new SqliteDraftLog(db),
          state,
          skills,
          model: new CheapModel(scripted.models, scripted.model.id, () => undefined),
          room: () => false,
        })
        return Context.merge(Skills.context(skills), Learner.context(learner))
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          connectionsLayer(manager),
          Layer.mock(Files)({
            stat: (path: string) =>
              written.has(path) ? Effect.succeed(fileEntry(path)) : Effect.fail(new NotFound({ what: 'file' })),
            write: (_caller, path: string, text) =>
              Effect.sync(() => {
                // SAFETY: the learner writes its drafts as text.
                written.set(path, text as string)
                return fileEntry(path)
              }),
          }),
          Layer.mock(Notices)({
            claim: (notice: { readonly title: string }) =>
              Effect.sync(() => {
                notices.push(notice.title)
                return { posted: false }
              }),
          }),
          Layer.mock(Chats)({ primary: ChatId('1'), chatOf: () => Effect.succeed(Option.some(ChatId('1'))) }),
          Layer.mock(Conversations)({}),
          Layer.succeed(Changes, makeChanges()),
          PiSessions.layer.pipe(Layer.provide(Layer.succeed(AgentInput, input))),
          SingleFlight.layer,
        ),
      ),
    ),
  )
  await run(Effect.flatMap(Skills, (library) => library.activate(receipt.session, 'library:draft-proof')))
  const corrected = await harness.submit('No, next time verify the checksum before submitting.', {
    operationId: 'checksum-correction',
  })
  await harness.wait(corrected.operationId)
  const learner = await run(Learner)
  const first = await run(learner.consider(conversationId(receipt.session)))
  const repeated = await harness.submit('No, next time verify the checksum before submitting.', {
    operationId: 'checksum-correction-repeat',
  })
  await harness.wait(repeated.operationId)
  const second = await run(learner.consider(conversationId(receipt.session)))
  const rows = db
    .select({ connectionId: appSkillDrafts.connectionId, name: appSkillDrafts.name, baseUri: appSkillDrafts.baseUri })
    .from(appSkillDrafts)
    .all()
  await dispose()
  return { first, second, files: [...written.keys()], notices, rows }
}

export const probes: Probes = { 'skills-cache': inAgent(({ storage }) => skillsCacheProbe(storage)) }
