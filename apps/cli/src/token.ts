import * as Config from 'effect/Config'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import { UsageError } from './args.ts'

/** An app's credentials (ADR 0118): its client id and secret, from the environment, the secret never printed. */
export interface AppCredentials {
  readonly clientId: string
  readonly clientSecret: Redacted.Redacted
}

const Environment = Config.all({
  clientId: Config.option(Config.String('GOBLIN_CLIENT_ID')),
  clientSecret: Config.option(Config.Redacted('GOBLIN_CLIENT_SECRET')),
})

/**
 * The app credentials `goblin token` uses: `GOBLIN_CLIENT_ID` (or `--client-id`) and `GOBLIN_CLIENT_SECRET`, which has
 * no flag, so a secret never lands in shell history.
 */
export async function appCredentials(
  clientIdFlag: string | undefined,
  provider?: ConfigProvider.ConfigProvider,
): Promise<AppCredentials> {
  const environment = await Effect.runPromise(
    provider === undefined ? Environment : Effect.provideService(Environment, ConfigProvider.ConfigProvider, provider),
  )
  const clientId = clientIdFlag ?? Option.getOrUndefined(environment.clientId)
  if (clientId === undefined || clientId.trim() === '')
    throw new UsageError('Name the app: GOBLIN_CLIENT_ID or --client-id (Settings → Developer shows it).')
  const clientSecret = Option.getOrUndefined(environment.clientSecret)
  if (clientSecret === undefined)
    throw new UsageError('Set GOBLIN_CLIENT_SECRET to the app secret Settings → Developer showed you once.')
  return { clientId: clientId.trim(), clientSecret }
}

const Token = Schema.Struct({ access_token: Schema.String, expires_in: Schema.optional(Schema.Number) })

/**
 * An app's access token from goblin's token endpoint (ADR 0118): the client_credentials grant with HTTP Basic client
 * authentication, for the `/mcp` resource, so the token is a bearer on `/w/<slug>/api/…` and `/mcp` alike. A refusal is
 * an error naming the status and goblin's own error code, never the secret.
 */
export async function appToken(
  origin: string,
  credentials: AppCredentials,
  fetcher: (url: string, init: RequestInit) => Promise<Response> = fetch,
): Promise<{ readonly token: string; readonly expiresIn: number | undefined }> {
  const basic = btoa(`${credentials.clientId}:${Redacted.value(credentials.clientSecret)}`)
  const answered = await fetcher(`${origin}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      resource: `${origin}/mcp`,
      scope: 'goblin',
    }).toString(),
  })
  if (!answered.ok) {
    // expected: a refusal whose body is not JSON is named by its status alone.
    const body: unknown = await answered.json().catch(() => null)
    const code = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Struct({ error: Schema.String }))(body))?.error
    throw new Error(`goblin refused the app's credentials (${answered.status}${code === undefined ? '' : ` ${code}`}).`)
  }
  const { access_token: token, expires_in: expiresIn } = Schema.decodeUnknownSync(Token)(await answered.json())
  return { token, expiresIn }
}
