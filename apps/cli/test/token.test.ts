import * as ConfigProvider from 'effect/ConfigProvider'
import * as Redacted from 'effect/Redacted'
import { describe, expect, it } from 'vitest'
import { appCredentials, appToken } from '../src/token.ts'

const ORIGIN = 'https://goblin.test'
const SECRET = 'app-secret-words'

/** A token endpoint that records what it was sent and answers `status` with `body`. */
const endpoint = (status: number, body: unknown) => {
  const seen: Request[] = []
  const fetcher = async (url: string, init: RequestInit) => {
    seen.push(new Request(url, init))
    return Response.json(body, { status })
  }
  return { seen, fetcher }
}

/** An environment of `env` alone. */
const provider = (env: Record<string, string>) => ConfigProvider.fromEnv({ env })

describe('goblin token (ADR 0118)', () => {
  it("asks for a client_credentials token for /mcp with the app's id and secret as HTTP Basic", async () => {
    const { seen, fetcher } = endpoint(200, { access_token: 'jws.token.here', expires_in: 3600, token_type: 'Bearer' })
    const answer = await appToken(ORIGIN, { clientId: 'app.1', clientSecret: Redacted.make(SECRET) }, fetcher)
    expect(answer).toEqual({ token: 'jws.token.here', expiresIn: 3600 })
    const [request] = seen
    expect(request?.url).toBe(`${ORIGIN}/api/auth/oauth2/token`)
    expect(request?.headers.get('authorization')).toBe(`Basic ${btoa(`app.1:${SECRET}`)}`)
    expect(Object.fromEntries(new URLSearchParams(await request?.text()))).toEqual({
      grant_type: 'client_credentials',
      resource: `${ORIGIN}/mcp`,
      scope: 'goblin',
    })
  })

  it("names a refusal's status and code, never the secret", async () => {
    const { fetcher } = endpoint(401, { error: 'invalid_client' })
    const refused = appToken(ORIGIN, { clientId: 'app.1', clientSecret: Redacted.make(SECRET) }, fetcher)
    await expect(refused).rejects.toThrow('401 invalid_client')
    await expect(refused).rejects.not.toThrow(SECRET)
  })

  it('reads the id from the flag or the environment, the secret from the environment only', async () => {
    const both = await appCredentials(undefined, provider({ GOBLIN_CLIENT_ID: 'app.1', GOBLIN_CLIENT_SECRET: SECRET }))
    expect([both.clientId, Redacted.value(both.clientSecret)]).toEqual(['app.1', SECRET])
    expect((await appCredentials('app.2', provider({ GOBLIN_CLIENT_SECRET: SECRET }))).clientId).toBe('app.2')
    await expect(appCredentials(undefined, provider({ GOBLIN_CLIENT_SECRET: SECRET }))).rejects.toThrow(
      'GOBLIN_CLIENT_ID',
    )
    await expect(appCredentials('app.1', provider({}))).rejects.toThrow('GOBLIN_CLIENT_SECRET')
  })
})
