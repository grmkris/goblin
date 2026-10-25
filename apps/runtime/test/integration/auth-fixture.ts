/** Injected mail capture and D1 clocks for native fixtures only; never imported by the deployed Worker. */
import type { RuntimeEnv } from '../../src/env.ts'
import type { MailMessage } from '../../src/auth/mail.ts'

const outbox = new Map<string, MailMessage>()

/** A Client ID Metadata Document client of the fixture (ADR 0122): its id is the URL of its document. */
export const DOCUMENT_CLIENT = 'https://client.test/cimd.json'
/** A document that lists a private-use redirect: refused at authorization like a dynamic registration would be. */
export const SCHEME_CLIENT = 'https://client.test/cursor.json'
/** A document URL that answers with a redirect, which a metadata fetch must not follow. */
export const MOVED_CLIENT = 'https://client.test/moved.json'
const DOCUMENTS: Readonly<Record<string, Record<string, unknown>>> = {
  [DOCUMENT_CLIENT]: {
    client_id: DOCUMENT_CLIENT,
    client_name: 'Document Client',
    client_uri: 'https://client.test',
    redirect_uris: ['http://127.0.0.1:9/callback', 'https://client.test/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
  [SCHEME_CLIENT]: {
    client_id: SCHEME_CLIENT,
    client_name: 'Scheme Client',
    redirect_uris: ['cursor://anysphere.cursor-mcp/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  },
}
/** The fixture's metadata documents, in place of the network: the deployed Worker fetches them itself. */
const documentFetch = (input: RequestInfo | URL): Promise<Response> => {
  const url = input instanceof Request ? input.url : String(input)
  if (url === MOVED_CLIENT)
    return Promise.resolve(new Response(null, { status: 302, headers: { location: DOCUMENT_CLIENT } }))
  const document = DOCUMENTS[url]
  return Promise.resolve(
    document === undefined ? new Response('no such document', { status: 404 }) : Response.json(document),
  )
}

export function fixtureAuth(request: Request, env: RuntimeEnv): RuntimeEnv {
  const mode = request.headers.get('x-fixture-signup')
  return {
    ...env,
    ...(mode === 'open' || mode === 'invite' || mode === 'closed' ? { SIGNUP_MODE: mode } : {}),
    SIGNUP_INVITE_CODE: 'fixture-invite',
    MAIL_SENDER: 'hello@goblin.test',
    CLIENT_METADATA_FETCH: documentFetch,
    MAIL: {
      send: (message) => {
        if (request.headers.has('x-fixture-mail-failure')) return Promise.reject(new Error('fixture mail unavailable'))
        outbox.set(message.to, message)
        return Promise.resolve(undefined)
      },
    },
  }
}
export async function authFixtureRoute(request: Request, env: RuntimeEnv): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!url.pathname.startsWith('/__test/auth/')) return undefined
  const email = url.searchParams.get('email') ?? ''
  const identifier = `sign-in-otp-${email}`
  switch (url.pathname) {
    case '/__test/auth/mail': {
      const mail = outbox.get(email)
      const row = await env.AUTH_DB.prepare('SELECT value, createdAt, expiresAt FROM verification WHERE identifier = ?')
        .bind(identifier)
        .first()
      return Response.json({ code: mail?.text.match(/code is (\d{6})/u)?.[1], row })
    }
    case '/__test/auth/expire':
      await env.AUTH_DB.prepare('UPDATE verification SET expiresAt = ? WHERE identifier = ?')
        .bind(new Date(Date.now() - 1000).toISOString(), identifier)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/cooldown':
      await env.AUTH_DB.prepare('UPDATE verification SET createdAt = ? WHERE identifier = ?')
        .bind(new Date(Date.now() - 61_000).toISOString(), identifier)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/age-session':
      await env.AUTH_DB.prepare(
        'UPDATE session SET createdAt = ? WHERE userId IN (SELECT id FROM user WHERE email = ?)',
      )
        .bind(new Date(Date.now() - 601_000).toISOString(), email)
        .run()
      return Response.json({ ok: true })
    case '/__test/auth/accounts':
      return Response.json(
        await env.AUTH_DB.prepare('SELECT COUNT(*) AS count FROM user WHERE email = ?').bind(email).first(),
      )
    default:
      return new Response(null, { status: 404 })
  }
}
