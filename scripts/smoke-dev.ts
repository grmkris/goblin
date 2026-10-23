/**
 * Acceptance against the retained dev Worker (`smoke:dev`), which every dev deploy runs, or the local stack
 * (`smoke:local`). Never imported by the deployed Worker. By default it makes no model call (ADR 0106): it reads the
 * owner's state, round-trips a file, checks the edge and the MCP servers, and drives an inbound client up to its tool
 * list and an inspection read. With `GOBLIN_SMOKE_TURNS=1` it also runs the agent turns, and with `GOBLIN_SMOKE_MODEL`
 * set they answer on that model, the owner's own pick put back afterwards, whatever failed. Grants stay as the owner set
 * them. Turns run in main and a side thread closed afterwards; the throwaway inbound client is revoked before the script
 * exits, and the one file it uploads is deleted again.
 */
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { randomBytes } from 'node:crypto'
import { chmod, stat, writeFile } from 'node:fs/promises'
import { runInput } from '../packages/contracts/src/agui/run-input.ts'
import type { ToolView } from '../packages/contracts/src/mcp.ts'
import { appChecks } from './smoke-apps.ts'
import { DevClient, type Step } from './smoke-client.ts'
import { InboundClient, SMOKE_CLIENT_NAME, base64url, operationId } from './smoke-inbound.ts'
import { edgeChecks, internalChecks } from './smoke-edge.ts'
import { delegateReported, idleAfter, marksOf, openingOf } from './smoke-entries.ts'
import { publicSmoke } from './smoke-public.ts'
import { clientBuild, flowsCheck } from './smoke-release.ts'

const ObjectSchema = Schema.Record(Schema.String, Schema.MutableJson)
type JsonObject = typeof ObjectSchema.Type
const objects = Schema.decodeUnknownSync(Schema.Array(ObjectSchema))
const string = Schema.decodeUnknownSync(Schema.String)

const DEV_MARKER = 'GOBLIN_DEV_OK'
const MCP_MARKER = 'GOBLIN_MCP_OK'
/** Main's newest page of history. */
const MAIN_HISTORY = { params: { id: '1' }, query: { before: 2_147_483_647 } } as const

type Settings = {
  readonly stage: string
  readonly url: string
  readonly email: Redacted.Redacted
  readonly sessionFile: string
  readonly turns: boolean
}

const settings = Effect.gen(function* () {
  return {
    stage: yield* Config.String('GOBLIN_STAGE'),
    url: yield* Config.String('GOBLIN_APP_URL'),
    email: yield* Config.Redacted('GOBLIN_OWNER_EMAIL').pipe(Config.withDefault(Redacted.make(''))),
    sessionFile: yield* Config.String('GOBLIN_SMOKE_SESSION_FILE').pipe(Config.withDefault('')),
    /** Whether the smoke runs agent turns, which spend model tokens (ADR 0106); off unless `GOBLIN_SMOKE_TURNS=1`. */
    turns: yield* Config.Boolean('GOBLIN_SMOKE_TURNS').pipe(Config.withDefault(false)),
    /** The model the smoke's agent turns run on (dev: an Alibaba Token Plan model); unset: the owner's own pick. */
    smokeModel: Option.getOrUndefined(yield* Config.option(Config.String('GOBLIN_SMOKE_MODEL'))),
  }
})

/** Smoke follows the stage's configured APP_URL; local remains tied to the local stack. */
function targetUrl(config: Settings): URL {
  const url = new URL(config.url)
  const deployed = (config.stage === 'dev' || config.stage === 'prod') && url.protocol === 'https:'
  const local = config.stage === 'local' && url.origin === 'http://localhost:18971'
  if ((!deployed && !local) || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('stage_app_origin_required')
  return url
}

type ServerReport = {
  connectionId: string
  status: string
  tools?: number
  granted?: number
  probe?: string
  /** The read-only tool probed, when it was. */
  probeTool?: string
}

/**
 * The tool a connected server is probed with: one the owner allowed to run without asking, that the server says only
 * reads, that the agent may call too, and that needs no input. None when the server has no such tool.
 */
const probeOf = (tools: readonly ToolView[]): string | undefined =>
  tools.find(
    (tool) =>
      tool.granted &&
      tool.askFirst !== true &&
      tool.readOnlyHint === true &&
      tool.destructiveHint !== true &&
      tool.modelVisible &&
      tool.needsInput !== true,
  )?.name

async function serverReport(
  dev: DevClient,
  server: { readonly connectionId: string; readonly status: string },
): Promise<ServerReport> {
  const { connectionId } = server
  const report: ServerReport = { connectionId, status: server.status }
  if (report.status !== 'connected') return report
  // A connected server whose host no longer answers (a stopped tunnel) is the server's outage, not goblin's: the
  // agent answers it as UpstreamMcp (502, or 504 on a timeout), which the report records instead of failing. One that
  // asks for sign-in on this refresh (NeedsAuthorization, 409) is the server's state too, and is recorded the same way.
  const tools = await dev.owner((api) =>
    api.mcp.tools({ params: { id: connectionId }, query: { refresh: '' } }).pipe(
      Effect.catchTag('UpstreamMcp', () => Effect.succeed('unreachable' as const)),
      Effect.catchTag('NeedsAuthorization', () => Effect.succeed('needs_auth' as const)),
    ),
  )
  if (tools === 'unreachable') return { ...report, probe: 'unreachable' }
  if (tools === 'needs_auth') return { ...report, status: 'needs_auth' }
  report.tools = tools.length
  report.granted = tools.filter((tool) => tool.granted).length
  const probe = probeOf(tools)
  if (probe === undefined) {
    report.probe = 'none'
    return report
  }
  const result = await dev.owner((api) =>
    api.mcp.callTool({ params: { id: connectionId }, headers: {}, payload: { name: probe, arguments: {} } }),
  )
  report.probe = result.isError === true ? 'error' : 'ok'
  report.probeTool = probe
  return report
}

/**
 * If a connection proved a probe (a granted read-only tool that needs no input), the agent must be able to call it
 * through its resident authority; skipped when none did.
 */
async function residentToolTurn(client: InboundClient, servers: readonly ServerReport[]): Promise<'ok' | 'skipped'> {
  const probed = servers.find((server) => server.probe === 'ok' && server.probeTool !== undefined)
  if (probed?.probeTool === undefined) return 'skipped'
  const used = await client.ask(
    `Call mcp_call exactly once with connectionId "${probed.connectionId}", name "${probed.probeTool}" and ` +
      `arguments {}. After a successful result reply with exactly ${MCP_MARKER}; otherwise describe the failure.`,
  )
  if (used['status'] !== 'done' || used['text'] !== MCP_MARKER) throw new Error('resident_tool_turn_failed')
  return 'ok'
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds))

/** Reads with `read` until `ready`, or fails with `reason` once `milliseconds` have passed. */
async function poll<A>(
  read: (signal: AbortSignal) => Promise<A>,
  ready: (value: A) => boolean,
  milliseconds: number,
  reason: string,
): Promise<void> {
  const deadline = Date.now() + milliseconds
  const signal = AbortSignal.timeout(milliseconds)
  try {
    await wait(1_500)
    while (Date.now() < deadline) {
      if (ready(await read(signal))) return
      await wait(1_000)
    }
  } catch (error) {
    if (!signal.aborted) throw error
  }
  throw new Error(reason)
}

const mainHistory = (dev: DevClient, signal?: AbortSignal) =>
  dev.owner((api) => api.conversations.history(MAIN_HISTORY), signal)

/**
 * Chat `thread`'s stream as any reader reads it: a connection to it, and the opening it begins with (the chat's
 * snapshots and the run in flight, docs/architecture/streams.md); the connection is let go then.
 */
async function streamEvents(dev: DevClient, thread: string, signal?: AbortSignal): Promise<JsonObject[]> {
  const response = await dev.send(`/api/conversations/${thread}/stream`, {
    headers: { accept: 'text/event-stream' },
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok || response.body === null) throw new Error(`stream_read_${response.status}`)
  return openingOf(response.body)
}

const waitForIdle = (dev: DevClient, thread: string): Promise<void> =>
  poll((signal) => streamEvents(dev, thread, signal), idleAfter, 120_000, 'thread_still_busy')

/** The entries of a page of history's messages. */
const entriesOf = (messages: readonly JsonObject[]) => new Set(messages.map((message) => marksOf(message)['entryId']))

async function submitMessage(dev: DevClient, thread: string, input: string, step: string): Promise<void> {
  const payload = runInput(thread, { input, operationId: operationId(step) })
  await dev
    .owner((api) => api.conversations.submit({ params: { id: thread }, payload }))
    .catch(() => {
      throw new Error(`${step}_submit_failed`)
    })
}

type ThreadCheck = { readonly thread: 'ok'; readonly shared: true }

async function closeThread(dev: DevClient, thread: string): Promise<void> {
  const payload = { closed: true }
  await dev
    .owner((api) => api.conversations.update({ params: { id: thread }, payload }))
    .catch(() => {
      throw new Error('thread_close_failed')
    })
}

async function threadChecks(dev: DevClient): Promise<ThreadCheck> {
  const { id: thread } = await dev.owner((api) => api.conversations.create({ payload: {} }))
  try {
    await submitMessage(
      dev,
      thread,
      'Pick three prime numbers between 10 and 30 and tell me which you picked. Short.',
      'thread',
    )
    await waitForIdle(dev, thread)
    const seen = entriesOf(objects((await mainHistory(dev)).messages))
    await submitMessage(dev, thread, 'Share what we concluded here with main.', 'thread_share')
    // A shared note is a user message that names the thread it came from.
    await poll(
      (signal) => mainHistory(dev, signal),
      (history) =>
        objects(history.messages).some(
          (message) => marksOf(message)['thread'] === thread && !seen.has(marksOf(message)['entryId']),
        ),
      60_000,
      'thread_share_missing',
    )
    await waitForIdle(dev, thread)
    return { thread: 'ok', shared: true }
  } finally {
    await closeThread(dev, thread)
  }
}

type SubagentCheck = { readonly subagent: 'reported' }

async function subagentChecks(dev: DevClient): Promise<SubagentCheck> {
  const seen = entriesOf(objects((await mainHistory(dev)).messages))
  await submitMessage(
    dev,
    '1',
    'Start a subagent named smokecount: it should count the letters in the word "goblin" and report the number. Then tell me you started it.',
    'subagent',
  )
  await poll(
    (signal) => mainHistory(dev, signal),
    (history) => {
      const messages = objects(history.messages).filter((message) => !seen.has(marksOf(message)['entryId']))
      return delegateReported(messages, 'smokecount')
    },
    120_000,
    'subagent_report_missing',
  )
  await waitForIdle(dev, '1')
  return { subagent: 'reported' }
}

type MemoryCheck = { readonly memory: { readonly messages: number; readonly summarized: number } }

async function memoryChecks(dev: DevClient): Promise<MemoryCheck> {
  const { messages, summarized } = await dev.owner((api) => api.memory.status({ query: {} }))
  if (messages === 0) throw new Error('memory_empty')
  return { memory: { messages, summarized } }
}

const revokeClient = (dev: DevClient, clientId: string) =>
  dev.person((api) => api.clients.revoke({ params: { clientId } }))

/**
 * Why an inbound answer is not the smoke's marker, or nothing when it is: its status and the reason it went unanswered
 * (or the type of the text it answered), never the text itself. Enough to tell a turn still running past the wait from
 * one that failed.
 */
function notTheMarker(reply: JsonObject): string | undefined {
  if (reply['status'] === 'done' && reply['text'] === DEV_MARKER) return undefined
  const why = reply['status'] === 'done' ? `text:${typeof reply['text']}` : (reply['reason'] ?? 'none')
  return `${JSON.stringify(reply['status'])}:${JSON.stringify(why)}`
}

/** The inbound client without a model call (ADR 0106): opened, main's recent messages read, then revoked. */
async function inboundReads(dev: DevClient, client: InboundClient) {
  await inboundOpen(client)
  const recent = await client.tool('get_recent_messages', { limit: 10 })
  if (!Array.isArray(recent['messages'])) throw new Error('inbound_history_missing')
  await inboundRevoked(dev, client)
  return { initialized: true, modelTurn: 'skipped', residentTool: 'skipped', history: 'read', revokedThen401: true }
}

/** Consent, token, `initialize`, the tool list with the seven inspection tools, and an inspection read. */
async function inboundOpen(client: InboundClient): Promise<void> {
  await client.authorize()
  const init = await client.rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: SMOKE_CLIENT_NAME, version: '1' },
  })
  const listed = await client.rpc('tools/list')
  const names = objects(listed.result?.['tools'] ?? []).map((tool) => tool['name'])
  if (init.result === undefined || !names.includes('ask_agent') || !names.includes('get_recent_messages'))
    throw new Error('inbound_tools_missing')
  // Its grant holds `inspect`, so the same /mcp offers read-only inspection (ADRs 0024, 0114). It reads without a
  // model.
  const inspection = names.filter((name) => typeof name === 'string' && name.startsWith('inspect_'))
  const problems = inspection.length === 7 ? await client.tool('inspect_problems', {}) : {}
  if (!Array.isArray(problems['problems'])) throw new Error('inbound_inspection_missing')
}

/** The client revoked, and `/mcp` answering it 401 from then on. */
async function inboundRevoked(dev: DevClient, client: InboundClient): Promise<void> {
  const revoked = await revokeClient(dev, client.clientId)
  const after = await client.rpc('tools/list')
  if (!revoked.revoked || after.status !== 401) throw new Error('inbound_revocation_failed')
}

/** The inbound client with its model turns (`GOBLIN_SMOKE_TURNS=1`): an answer, a tool call, history and authorship. */
async function inboundChecks(dev: DevClient, client: InboundClient, servers: readonly ServerReport[]) {
  await inboundOpen(client)
  const smokeInput = `Reply with exactly: ${DEV_MARKER}`
  const reply = await client.ask(smokeInput)
  const unexpected = notTheMarker(reply)
  if (unexpected !== undefined) throw new Error(`inbound_model_turn_failed:${unexpected}`)
  const residentTool = await residentToolTurn(client, servers)
  const recent = await client.tool('get_recent_messages', { limit: 10 })
  const messages = objects(recent['messages'])
  const texts = messages.map((message) => message['text'])
  if (!texts.includes(DEV_MARKER)) throw new Error('inbound_history_missing')
  const smokeMessage = messages.findLast((message) => message['role'] === 'user' && message['text'] === smokeInput)
  if (smokeMessage?.['author'] !== SMOKE_CLIENT_NAME) throw new Error('inbound_author_missing')
  await inboundRevoked(dev, client)
  return { initialized: true, modelTurn: 'ok', residentTool, history: 'ok', author: 'ok', revokedThen401: true }
}

const putModel = (dev: DevClient, model: string) => dev.owner((api) => api.agent.chooseModel({ payload: { model } }))

/** Runs `work` with the agent answering on `model`, then puts the owner's own pick back, whatever happened. */
async function withModel<T>(dev: DevClient, model: string | undefined, work: () => Promise<T>): Promise<T> {
  if (model === undefined) return work()
  const choice = await dev.owner((api) => api.agent.model())
  if (!choice.options.some((option) => option.id === model)) throw new Error('smoke_model_not_offered')
  const own = choice.current
  if (own === undefined || own === model) return work()
  await putModel(dev, model)
  try {
    return await work()
  } finally {
    await putModel(dev, own)
  }
}

type FileCheck = { readonly files: 'ok' }

/** Why a file that was just uploaded does not read back as it was, or nothing. */
async function fileReadBack(dev: DevClient, path: string, target: string, body: string): Promise<string | undefined> {
  const listing = await dev.json('/api/files?dir=%2Fuploads')
  if (!objects(listing['entries']).some((entry) => entry['path'] === path)) return 'file_not_listed'
  const read = await dev.send(target)
  return read.ok && (await read.text()) === body ? undefined : 'file_read_mismatch'
}

/** The owner's files (ADR 0022): a small text file uploads, lists, downloads byte for byte and is deleted. */
async function fileChecks(dev: DevClient): Promise<FileCheck> {
  const path = `/uploads/smoke-${base64url(randomBytes(6))}.txt`
  const target = `/api/files/content?path=${encodeURIComponent(path)}`
  const body = `goblin smoke ${new Date().toISOString()}\n`
  const csrf = { 'x-goblin-csrf': '1' }
  const put = await dev.send(target, { method: 'PUT', headers: { ...csrf, 'content-type': 'text/plain' }, body })
  if (put.status !== 201) throw new Error('file_upload_failed')
  // expected: a failed read is thrown below as file_read_failed, once the file is deleted
  const failure = await fileReadBack(dev, path, target, body).catch(() => 'file_read_failed')
  // Delete it whatever the read found, then report.
  const deleted = await dev.send(target, { method: 'DELETE', headers: csrf })
  if (failure !== undefined) throw new Error(failure)
  if (!deleted.ok) throw new Error('file_delete_failed')
  return { files: 'ok' }
}

/** Unless sign-up is open, a registration without the invite code must be refused (and so writes nothing). */
async function refusedSignup(dev: DevClient, steps: Step[]): Promise<void> {
  const response = await dev.send('/api/auth/email-otp/send-verification-otp', {
    method: 'POST',
    owner: false,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: `smoke-${base64url(randomBytes(6)).toLowerCase()}@example.invalid`,
      type: 'sign-in',
    }),
  })
  if (response.status === 429) {
    steps.push({ step: 'signup refused (rate-limited); gate not proven open', status: response.status })
    return
  }
  if (response.status !== 403) throw new Error('signup_gate_open')
}

type Receipt = {
  readonly stage: string
  readonly model: string
  readonly signup: string
  readonly resident: string
  readonly servers: readonly ServerReport[]
  readonly inbound: Awaited<ReturnType<typeof inboundChecks>> | Awaited<ReturnType<typeof inboundReads>>
  /** The agent turns' checks, run only with `GOBLIN_SMOKE_TURNS=1` (ADR 0106). */
  readonly thread?: ThreadCheck['thread']
  readonly shared?: ThreadCheck['shared']
  readonly subagent?: SubagentCheck['subagent']
  readonly memory?: MemoryCheck['memory']
  readonly files: FileCheck['files']
  readonly edge: Awaited<ReturnType<typeof edgeChecks>>['edge']
  readonly internal: Awaited<ReturnType<typeof internalChecks>>['internal']
  readonly app?: 'ok'
  /** The commit the deployed client bundle names, or why it was not checked. */
  readonly build: string
  /** `ok`: the smoke's sends reached the flows dataset; or why it was not checked. */
  readonly flows: string
}

/** Signed in: resident authority is active and main's stream opens with its messages. */
async function ownerReads(dev: DevClient): Promise<{ readonly resident: 'active' }> {
  const resident = await dev.owner((api) => api.resident.status())
  if (resident.state !== 'active') throw new Error('resident_authority_inactive')
  const [opening] = await streamEvents(dev, '1')
  if (opening?.['type'] !== 'MESSAGES_SNAPSHOT') throw new Error('main_stream_missing')
  return { resident: resident.state }
}

/** Each of the owner's MCP servers, as `serverReport` finds it. */
async function serverReports(dev: DevClient): Promise<readonly ServerReport[]> {
  const reports: ServerReport[] = []
  for (const server of await dev.owner((api) => api.mcp.servers())) reports.push(await serverReport(dev, server))
  return reports
}

async function smokeDev(
  steps: Step[],
): Promise<
  Receipt | { readonly stage: string; readonly signup: string; readonly mode: 'read-only'; readonly build: string }
> {
  const started = Date.now()
  const config = await Effect.runPromise(settings)
  if ((await stat(new URL(`../.local/${config.stage}.env`, import.meta.url))).mode & 0o077)
    throw new Error('private_stage_env_required')
  const dev = new DevClient(targetUrl(config), steps)
  const health = await dev.json('/health', { owner: false })
  if (health['stage'] !== config.stage || health['service'] !== 'goblin') throw new Error('stage_health_mismatch')
  const signup = string(health['signup'])
  const build = await clientBuild(dev, config.stage)
  if (config.stage === 'prod' && (Redacted.value(config.email) === '' || config.sessionFile === '')) {
    await publicSmoke(dev, health, signup, steps, () => refusedSignup(dev, steps))
    return { stage: config.stage, signup, mode: 'read-only', build }
  }
  if (signup !== 'open') await refusedSignup(dev, steps)
  await dev.useSession(config.sessionFile, config.email)
  const { resident } = await ownerReads(dev)
  const { files } = await fileChecks(dev)
  const { edge } = await edgeChecks(dev)
  const { internal } = await internalChecks(dev.origin, steps)
  const servers = await serverReports(dev)
  const client = await InboundClient.register(dev)
  try {
    if (!config.turns) {
      const inbound = await inboundReads(dev, client)
      const flows = 'skipped: no agent turns ran (GOBLIN_SMOKE_TURNS unset)'
      return {
        stage: config.stage,
        model: 'none',
        signup,
        resident,
        servers,
        files,
        edge,
        internal,
        build,
        flows,
        inbound,
      }
    }
    const checks = await withModel(dev, config.smokeModel, async () => {
      const inbound = await inboundChecks(dev, client, servers)
      const thread = await threadChecks(dev)
      const subagent = await subagentChecks(dev)
      const memory = await memoryChecks(dev)
      const app = await appChecks(dev, { submit: submitMessage, idle: waitForIdle, close: closeThread })
      return { inbound, ...thread, ...subagent, ...memory, ...app }
    })
    const model = config.smokeModel ?? 'owner pick'
    const flows = await flowsCheck(config.stage, started)
    return { stage: config.stage, model, signup, resident, servers, files, edge, internal, build, flows, ...checks }
  } finally {
    // Never leave the throwaway client authorized, whatever failed above.
    // expected: the step list records the revoke's answer; a refusal here must not hide the failure above
    await revokeClient(dev, client.clientId).catch(() => undefined)
  }
}

const steps: Step[] = []
try {
  const result = await smokeDev(steps)
  const receipt = { utc: new Date().toISOString(), status: 'passed', ...result, steps }
  const output = `${JSON.stringify(receipt, null, 2)}\n`
  const receiptPath = new URL(`../.local/smoke-${result.stage}-receipt.json`, import.meta.url)
  await writeFile(receiptPath, output, { mode: 0o600 })
  await chmod(receiptPath, 0o600)
  console.info(output)
} catch (error) {
  // expected: the smoke's last resort prints the failed step list and exits non-zero
  const reason = error instanceof Error ? error.message : 'unknown'
  console.error(JSON.stringify({ status: 'failed', reason, steps }, null, 2))
  process.exitCode = 1
}
