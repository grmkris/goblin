import * as Alchemy from 'alchemy'
import * as Cloudflare from 'alchemy/Cloudflare'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Redacted from 'effect/Redacted'
import { fileURLToPath } from 'node:url'
import { stackState } from '../../scripts/alchemy-state.ts'
import { resolveStage } from '../../scripts/stage-config.ts'

const root = fileURLToPath(new URL('./', import.meta.url))

/**
 * The deployment's own model endpoint, model choice and daily budget the Worker reads (docs/development.md). All
 * optional: without the base URL, key and default model the deployment has no endpoint, and each owner brings their
 * own (ADR 0064). Local defaults to CLIProxy (scripts/stage.ts).
 */
const modelEnv = {
  MODEL_BASE_URL: Config.String('GOBLIN_MODEL_BASE_URL').pipe(Config.withDefault('')),
  MODEL_ID: Config.String('GOBLIN_MODEL_ID').pipe(Config.withDefault('')),
  MODELS: Config.String('GOBLIN_MODELS').pipe(Config.withDefault('')),
  MODEL_KEY: Config.Redacted('GOBLIN_MODEL_KEY').pipe(Config.withDefault(Redacted.make(''))),
  DAILY_TOKEN_CAP: Config.String('GOBLIN_DAILY_TOKEN_CAP').pipe(Config.withDefault('')),
  MEMORY_MODEL: Config.String('GOBLIN_MEMORY_MODEL').pipe(Config.withDefault('')),
}

/**
 * The deployment's OpenID Connect provider (ADR 0064): its issuer, the client goblin is registered as and that
 * client's secret, all three or none (half a provider is refused), and the button's words. Bound only when set.
 */
const oidcEnv = Effect.gen(function* () {
  const issuer = yield* Config.String('GOBLIN_OIDC_ISSUER').pipe(Config.withDefault(''))
  const clientId = yield* Config.String('GOBLIN_OIDC_CLIENT_ID').pipe(Config.withDefault(''))
  const secret = Config.Redacted('GOBLIN_OIDC_CLIENT_SECRET')
  const hasSecret = Redacted.value(yield* secret.pipe(Config.withDefault(Redacted.make('')))) !== ''
  const label = yield* Config.String('GOBLIN_OIDC_LABEL').pipe(Config.withDefault(''))
  if (issuer === '' && clientId === '' && !hasSecret) return undefined
  if (issuer === '' || clientId === '' || !hasSecret)
    return yield* Effect.die(
      new Error('GOBLIN_OIDC_ISSUER, GOBLIN_OIDC_CLIENT_ID and GOBLIN_OIDC_CLIENT_SECRET go together'),
    )
  return {
    OIDC_ISSUER: issuer,
    OIDC_CLIENT_ID: clientId,
    OIDC_CLIENT_SECRET: secret,
    ...(label === '' ? {} : { OIDC_LABEL: label }),
  }
})

/** What the Website build reads: a change to any of them builds again. */
const BUILD_INPUTS = [
  'src/**',
  'vite.config.ts',
  'vite.react.ts',
  'package.json',
  '../../apps/runtime/src/**',
  '../../packages/**',
]

const runtimeStage = (name: string) => (name === 'local' || name === 'dev' || name === 'prod' ? name : 'test')

export default Alchemy.Stack(
  'goblin',
  { providers: Cloudflare.providers(), state: stackState() },
  Effect.gen(function* () {
    const stage = resolveStage(yield* Alchemy.Stage)
    const appUrl = yield* Config.String('GOBLIN_APP_URL').pipe(Config.withDefault('http://localhost:18971'))
    const domain = yield* Config.String('GOBLIN_DOMAIN').pipe(Config.withDefault(''))
    const zoneId = domain === '' ? '' : yield* Config.String('GOBLIN_ZONE_ID')
    const signupMode = yield* Config.String('GOBLIN_SIGNUP_MODE').pipe(Config.withDefault('closed'))
    const build = yield* Config.String('VITE_GOBLIN_BUILD').pipe(Config.withDefault(''))
    // An address on a domain onboarded for Cloudflare Email Sending; local uses its mail simulator (scripts/stage.ts).
    const mailSender = yield* Config.String('GOBLIN_MAIL_SENDER').pipe(Config.withDefault(''))
    const oidc = yield* oidcEnv
    // A deployment needs one way in: emailed codes, its OpenID Connect provider, or both (ADR 0064).
    if (mailSender === '' && oidc === undefined)
      return yield* Effect.die(
        new Error('sign-in needs GOBLIN_MAIL_SENDER, or GOBLIN_OIDC_ISSUER, GOBLIN_OIDC_CLIENT_ID and _SECRET'),
      )
    if (stage.name === 'dev' && signupMode === 'open')
      return yield* Effect.die(new Error('dev_sign_up_must_be_closed_or_invite_only'))
    const db = yield* Cloudflare.D1.Database('goblinAuth', {
      name: stage.resourceName('auth'),
      migrations: fileURLToPath(new URL('../../apps/runtime/migrations', import.meta.url)),
    })
    const files = yield* Cloudflare.R2.Bucket('Files', { name: stage.resourceName('files') })
    // Conversation flows across every agent, one point per operation with a hashed agent id (ADR 0037).
    const flows = yield* Cloudflare.AnalyticsEngine.Dataset('Flows', { dataset: stage.resourceName('flows') })
    const agents = Cloudflare.DurableObject('PersonalAgent', { className: 'PersonalAgent' })
    const web = yield* Cloudflare.Website.Vite('Web', {
      name: stage.workerName,
      rootDir: root,
      main: 'src/worker.ts',
      workersDev: true,
      ...(domain === ''
        ? {}
        : {
            domain: {
              name: domain,
              zoneId,
              ...(stage.name === 'prod' ? { aliases: [`www.${domain}`] } : {}),
            },
          }),
      compatibility: { date: '2026-09-25', flags: ['nodejs_compat'] },
      observability: stage.observability,
      dev: { port: 18971, strictPort: true },
      memo: {
        include: BUILD_INPUTS,
        lockfile: true,
      },
      env: {
        AGENTS: agents,
        AUTH_DB: db,
        FILES: files,
        FLOWS: flows,
        LOADER: Cloudflare.WorkerLoader(),
        // Workers AI for typed decisions through Clef (ADR 0031), on dev only: elsewhere decisions judge nothing.
        ...(stage.name === 'dev' ? { AI: Cloudflare.Workers.AI() } : {}),
        APP_URL: appUrl,
        BETTER_AUTH_SECRET: Config.Redacted('GOBLIN_BETTER_AUTH_SECRET'),
        SIGNUP_MODE: signupMode,
        ...(mailSender === ''
          ? {}
          : {
              MAIL: Cloudflare.Email.SendEmail('Mail', { allowedSenderAddresses: [mailSender] }),
              MAIL_SENDER: mailSender,
            }),
        SIGNUP_INVITE_CODE: Config.Redacted('GOBLIN_SIGNUP_INVITE_CODE').pipe(Config.withDefault(Redacted.make(''))),
        ...oidc,
        ...modelEnv,
        MCP_SERVERS: Config.String('GOBLIN_MCP_SERVERS').pipe(Config.withDefault('[]')),
        MCP_SHELF: Config.String('GOBLIN_MCP_SHELF').pipe(Config.withDefault('')),
        CREDENTIAL_KEY: Config.Redacted('GOBLIN_CREDENTIAL_KEY'),
        STAGE: runtimeStage(stage.name),
        // The release SHA stage.ts sets: as a prop it changes every release, which forces the rebuild that bakes it
        // into the client bundle (the build's input hash covers files only). Unset (the local stack), crash reports
        // say `dev`.
        ...(build === '' ? {} : { VITE_GOBLIN_BUILD: build }),
      },
    })
    return { url: web.url, authDatabase: db.databaseId }
  }),
)
