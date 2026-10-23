import { GenerationTask, defineExtension, hook, section } from '@earendil-works/pi-durable'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import { BuildResult } from '../agent-apps/build.ts'
import type { AgentApps } from '../agent-apps/engine.ts'
import { AppInspection, InspectPart } from '../agent-apps/inspect.ts'
import { RolledBack } from '../agent-apps/rollback.ts'
import { problemText } from '../agent-apps/queue.ts'
import { ScriptResult, runScript } from '../agent-apps/script.ts'
import { withContext } from './context-tail.ts'
import type { RunProgram } from '../runtime/bridge.ts'
import { type CallApi, adminOnly } from './asker.ts'
import type { PiContext } from './context.ts'
import { allows } from '../grants/power.ts'
import { reportAndRecover } from '../observability/report.ts'
import { Setups } from '../setup/service.ts'
import { effectiveOf, turnFileView } from './power.ts'
import { APP_CALL } from './tool-needs.ts'
import { newAppJoinsTopic } from '../topics/program.ts'
import { typedTool } from './typed-tool.ts'

const GUIDE = [
  'You can build apps for the owner: small programs with durable state on the server, whose actions and views you',
  'call with `app_call` (app, member, input). Use one when the owner wants something kept and worked on over time (a list,',
  'a tracker, a log, a calculation over their data). Read `app_docs` (topic `core`) before your first build. Build or',
  'change one with `app_build`; for small fixes send `edits`. If a build fails, read its problems and fix them. An',
  'app with a `view.tsx` (topic `ui`) shows the owner a live UI in chat and as a page. Before you write or change a',
  '`view.tsx`, read `app_docs` topic `ui` and follow its Design rules: give each section room. Use `useHost()`',
  'from `@goblin/app` for its surface and available room. An app',
  "reaches the internet, the owner's MCP tools, a model, the owner (through their Notify me via) or other apps only",
  'with powers the owner approves',
  '(topic `powers`), and runs an action on its own with `schedules` (topic `schedules`). When a task needs a service',
  'the owner has not connected, look with `mcp_suggest` and ask them with `mcp_request_server`.',
  "`code_run` runs a one-off JavaScript snippet over the owner's files for calculations; it keeps nothing. The owner",
  'manages apps on the Apps page (allow powers, pause schedules, go back a version, delete); you cannot delete one.',
  'Your apps, their versions, members and last errors are listed under <apps> in the <goblin-context> block that ends',
  'each request.',
].join(' ')

/**
 * The apps this chat may call as they are now, for the trailing context block: they change with every build and the
 * Topic's setup (ADR 0040), the guide never does. Apps are the workspace's (ADR 0115): a turn that may not call them
 * (a server key's, outside a hub) lists none and says nothing of apps.
 */
const appsNow = (apps: AgentApps, run: RunProgram, api: CallApi, context: PiContext): Promise<string | undefined> =>
  run(
    Effect.gen(function* () {
      const effective = yield* effectiveOf(api, context)
      if (effective === undefined || !allows(effective, APP_CALL)) return undefined
      const scope = yield* Setups.use((setups) => setups.scope(String(api.conversationId)))
      return apps.summary((name) => scope.app(name)) || '(none here)'
    }),
  ).catch(
    // expected: the listing is optional context; run reported anything unexpected
    () => undefined,
  )

/** Whether `input`'s agent is offered tool `name`: an extension's guide is said only where its tools are. */
const offers = (input: { readonly agent: { readonly tools: readonly { readonly name: string }[] } }, name: string) =>
  input.agent.tools.some((offered) => offered.name === name)

const AppName = Schema.String.check(Schema.isMaxLength(24))

/** `app_docs`: the SDK reference, by topic. */
const docsTool = (apps: AgentApps) =>
  typedTool({
    name: 'app_docs',
    description:
      'Read how to write an app: topic "core" (start here), "ui" (its view), "powers" (fetch, tools, model, notify, other apps), "schedules", "files" or "examples".',
    input: Schema.Struct({ topic: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(40))) }),
    output: Schema.Struct({ docs: Schema.String }),
    replay: 'safe',
    execute: async ({ topic }) => ({ docs: await apps.docs(topic ?? 'core') }),
    text: ({ docs }) => docs,
  })

/** `app_build`: create or change an app. */
const buildTool = (apps: AgentApps, run: RunProgram) =>
  typedTool({
    name: 'app_build',
    description:
      'Create an app, or change one by name. A new app sends `files` ({"app.ts": "...", "view.tsx": "..."} — the view is optional); a change sends the files it replaces or `edits` (find must occur exactly once). Returns the new version and its members (call them with app_call), or the problems to fix.',
    input: Schema.Struct({
      name: AppName.annotate({ description: 'kebab-case, like reading-list' }),
      // A plain key keeps the value type in the JSON Schema; the builder checks each file name.
      files: Schema.optionalKey(Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(131_072)))),
      edits: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            file: Schema.String.check(Schema.isMaxLength(40)),
            find: Schema.String.check(Schema.isMaxLength(20_000)),
            replace: Schema.String.check(Schema.isMaxLength(20_000)),
          }),
        ).check(Schema.isMaxLength(20)),
      ),
      note: Schema.optionalKey(
        Schema.String.check(Schema.isMaxLength(300)).annotate({ description: 'what this version changes' }),
      ),
    }),
    output: BuildResult,
    replay: 'safe',
    execute: async (request, api) => {
      const session = String(api.conversationId)
      const built = await apps.build(request, { session, callId: api.callId })
      // A new app joins a Topic that lists its apps; failing that leaves the build as it is, and the owner can add it.
      if (built.status === 'active' && built.version === 1)
        await run(
          newAppJoinsTopic(session, built.app, `app:${session}:${api.callId}`).pipe(
            reportAndRecover('apps.join-topic', undefined),
          ),
        )
      return built
    },
    failure: adminOnly('apps', problemText),
  })

/** `app_inspect`: an app's version, members and, on request, its source, state, events and releases. */
const inspectTool = (apps: AgentApps) =>
  typedTool({
    name: 'app_inspect',
    description:
      'Look at an app: its version and members, and optionally its source, state, recent events and releases.',
    input: Schema.Struct({ app: AppName, include: Schema.optionalKey(Schema.Array(InspectPart)) }),
    output: AppInspection,
    replay: 'safe',
    execute: async ({ app, include }) => apps.inspect(app, include ?? []),
    failure: problemText,
  })

/** `app_rollback`: an earlier release active again. */
const rollbackTool = (apps: AgentApps, run: RunProgram) =>
  typedTool({
    name: 'app_rollback',
    description: 'Make an earlier release of an app active again (app_inspect with "releases" lists them).',
    input: Schema.Struct({ app: AppName, release: Schema.String.check(Schema.isMaxLength(40)) }),
    output: RolledBack,
    replay: 'safe',
    execute: async ({ app, release }) => apps.rollback(app, release),
    failure: adminOnly('apps', problemText),
  })

/** `code_run`: one-off JavaScript over the files its turn reaches (ADR 0115). */
const codeTool = (apps: AgentApps, run: RunProgram) =>
  typedTool({
    name: 'code_run',
    description:
      "Run JavaScript once (the body of an async function; `return` a JSON value). `files.read(path)`, `files.list(dir)` and `files.write(path, text)` reach the files you reach (`files.write` into this Topic's `agent` folder, a path inside it like `out.csv`); `log(...)` notes. No network; 30 s.",
    input: Schema.Struct({ code: Schema.String.check(Schema.isMaxLength(100_000)) }),
    output: ScriptResult,
    // Scripts may write files before eviction interrupts the tool. Pi must surface that interruption,
    // rather than automatically executing the script and its writes again.
    replay: 'unsafe',
    execute: async ({ code }, api, context) =>
      runScript(apps.isolates, { store: apps.ownerFiles, view: await run(turnFileView(api, context)) }, code),
  })

/**
 * Owner app management, on main and threads (ADR 0021). Without Dynamic Workers (`buildable` false, ADR 0064) no app
 * can be built or run, so there is none. Changing an app takes the `setup` extra of its turn's power (ADR 0115), which
 * an admin's role holds and a member's does not, and a person's turn or a hub.
 */
export function appsExtension(apps: AgentApps, run: RunProgram, buildable = true) {
  const extension = defineExtension({
    name: 'goblin.apps',
    // Only where the tools are offered: a turn whose power does not reach apps has them filtered out (ADR 0115).
    sections: [section('apps', (input) => (offers(input, 'app_build') ? GUIDE : undefined))],
    tools: [docsTool(apps), buildTool(apps, run), inspectTool(apps), rollbackTool(apps, run)],
  })
  return buildable ? [extension] : []
}

/** Execution shared with helpers, without app management. */
export function appExecutionExtension(apps: AgentApps, run: RunProgram) {
  return defineExtension({
    name: 'goblin.app-execution',
    sections: [
      section('code', (input) =>
        offers(input, 'code_run')
          ? '`code_run` runs JavaScript over the files you reach. `app_call` executes approved app actions and views listed under <apps>; app powers still require owner approval.'
          : undefined,
      ),
    ],
    tools: [codeTool(apps, run)],
    hooks: [
      hook(GenerationTask, {
        beforeRequest: async ({ messages }, api, context) => {
          const listed = await appsNow(apps, run, api, context)
          return listed === undefined ? undefined : { messages: withContext(messages, 'apps', listed) }
        },
      }),
    ],
  })
}
