import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'

const empty = { type: 'snapshot', entries: [], tools: [], inbox: [] }
const frame = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
const json = (response: ServerResponse, value: object | null, status = 200) => {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value))
}

/** Synthetic loopback browser fixture. No external email, sessions, or models. */
export async function browserFixture() {
  const streams = new Set<ServerResponse>()
  const operations: { operationId: string; input: string; header: string | undefined }[] = []
  let signedIn = false
  let stops = 0
  const server = createServer((request, response) => {
    // expected: a synthetic route failure must become a visible HTTP failure for the browser assertion.
    void handle(request, response).catch((error: unknown) => {
      console.error(error)
      response.writeHead(500).end('Browser fixture failed')
    })
  })
  async function handle(request: IncomingMessage, response: ServerResponse) {
    const path = new URL(request.url ?? '/', 'http://localhost').pathname
    if (!path.startsWith('/api/')) return serve(path, response)
    if (path === '/api/auth/get-session') return json(response, signedIn ? { user: { id: 'fixture' } } : null)
    if (path === '/api/auth/email-otp/send-verification-otp') return json(response, { success: true })
    if (path === '/api/auth/sign-in/email-otp') {
      signedIn = true
      return json(response, { success: true })
    }
    if (path === '/api/auth/sign-out') {
      signedIn = false
      return json(response, { success: true })
    }
    if (!signedIn) return json(response, {}, 401)
    if (path.endsWith('/snapshot')) return json(response, empty)
    if (path.endsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      streams.add(response)
      response.on('close', () => streams.delete(response))
      response.write(frame('snapshot', empty))
      return
    }
    if (path.endsWith('/stop')) {
      stops += 1
      return json(response, { stopped: true })
    }
    if (path.endsWith('/messages')) return send(request, response)
    return json(response, {}, 404)
  }
  async function send(request: IncomingMessage, response: ServerResponse) {
    let raw = ''
    for await (const chunk of request) raw += String(chunk)
    const value: unknown = JSON.parse(raw)
    if (
      typeof value !== 'object' ||
      value === null ||
      !('input' in value) ||
      !('operationId' in value) ||
      typeof value.input !== 'string' ||
      typeof value.operationId !== 'string'
    )
      throw new Error('Bad fixture message')
    const header = request.headers['x-goblin-operation']
    operations.push({
      input: value.input,
      operationId: value.operationId,
      header: Array.isArray(header) ? header[0] : header,
    })
    // First submission has an uncertain result. Retry must keep both the input and operation id.
    if (operations.length === 1) return json(response, {}, 503)
    json(response, { accepted: false, operationId: value.operationId, session: 'fixture' })
  }
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Missing browser fixture port')
  return {
    url: `http://127.0.0.1:${address.port}`,
    operations,
    stops: () => stops,
    batch: (events: readonly object[]) => {
      for (const stream of streams) stream.write(frame('batch', events))
    },
    close: () =>
      new Promise<void>((done) => {
        for (const stream of streams) stream.end()
        server.closeAllConnections()
        server.close(() => done())
      }),
  }
}

async function serve(path: string, response: ServerResponse): Promise<void> {
  const root = resolve('dist/client')
  const file = path.startsWith('/assets/') ? resolve(root, `.${path}`) : resolve(root, 'index.html')
  if (!file.startsWith(`${root}/`)) {
    response.writeHead(404).end()
    return
  }
  const content = await readFile(file)
  response.writeHead(200, { 'content-type': extname(file) === '.js' ? 'text/javascript' : 'text/html' }).end(content)
}
