import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Args, UsageError, flagText } from './args.ts'

/** The loopback port the CLI's OAuth client registers its redirect on. */
const DEFAULT_PORT = 18979

export type Settings = {
  readonly origin: string
  readonly endpoint: URL
  readonly scope: string
  readonly redirect: URL
  readonly store: string
  readonly json: boolean
}

const Environment = Config.all({
  origin: Config.option(Config.String('GOBLIN_ORIGIN')),
  configHome: Config.String('XDG_CONFIG_HOME').pipe(Config.withDefault(join(homedir(), '.config'))),
})

/**
 * Flags over environment (`provider`'s, else the process's) over defaults. The deployment has no default (ADR 0064):
 * every goblin is someone's own, so `--origin` or `GOBLIN_ORIGIN` names it (`http://localhost:18971` locally).
 */
export async function settingsOf(args: Args, provider?: ConfigProvider.ConfigProvider): Promise<Settings> {
  const environment = await Effect.runPromise(
    provider === undefined ? Environment : Effect.provideService(Environment, ConfigProvider.ConfigProvider, provider),
  )
  const named = flagText(args, 'origin') ?? Option.getOrUndefined(environment.origin)
  if (named === undefined || named.trim() === '')
    throw new UsageError('Name your goblin: --origin https://… or GOBLIN_ORIGIN.')
  const origin = named.trim().replace(/\/$/u, '')
  if (!URL.canParse(origin)) throw new UsageError(`--origin ${origin} is not a URL`)
  const port = Number(flagText(args, 'port') ?? DEFAULT_PORT)
  if (!Number.isInteger(port) || port < 1024 || port > 65_535) throw new UsageError('--port takes 1024 to 65535')
  return {
    origin,
    endpoint: new URL('/mcp', origin),
    // Inspection on top of what every /mcp client may do; no identity scopes, which the CLI never reads.
    scope: 'goblin:inspect goblin:transcripts offline_access',
    redirect: new URL(`http://127.0.0.1:${port}/callback`),
    store: join(environment.configHome, 'goblin', 'credentials.json'),
    json: args.flags.get('json') === true,
  }
}
