import type { CallToolResult } from '@modelcontextprotocol/client'
import { createMcpHandler } from '@modelcontextprotocol/server'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { describe, expect, it } from 'vitest'
import { type Materialized, materialize } from '../../src/mcp/content.ts'
import { mcpModelResult } from '../../src/mcp/extension.ts'
import { mcpHost } from '../../src/mcp/host.ts'
import { SingleFlight } from '../../src/observability/single-flight.ts'
import { AgentInput, type AgentInputs } from '../../src/runtime/input.ts'
import { memoryFiles } from '../memory-files.ts'
import { lowLevelServer } from './low-level-server.ts'
import { MemoryCredentials, MemoryGrants, MemoryLabels, MemoryRegistries } from './memory.ts'

/** Noon on the day the files land in: their folder is named after it. */
const NOON = Date.UTC(2026, 9, 15, 12)
/** Where the docs connection's files go that day: its label, slugged, then the day. */
const FOLDER = '/agent/received/docs-work/2026-10-15'

/** The docs server's resources: the owner allowed reading `q3.csv`, never `notes.txt`. */
const docs = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'docs', version: '1.0.0' }, { capabilities: { tools: {}, resources: {} } })
  server.setRequestHandler('tools/list', () => ({ tools: [] }))
  server.setRequestHandler('resources/list', () => ({ resources: [] }))
  server.setRequestHandler('resources/read', (request) => ({
    contents: [{ uri: request.params.uri, mimeType: 'text/csv', text: 'quarter,revenue\nq3,42\n' }],
  }))
  return server
})

/** A request a link's fetch sent: its URL and headers. */
type Sent = { readonly url: string; readonly headers: Readonly<Record<string, string>> }

/**
 * The web as a link's fetch sees it: each URL answers what `routes` gives for it (a 404 for any other), and every
 * request is recorded.
 */
const web = (routes: Readonly<Record<string, () => Response>>) => {
  const sent: Sent[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init)
    sent.push({ url: request.url, headers: Object.fromEntries(request.headers) })
    return routes[request.url]?.() ?? new Response('missing', { status: 404 })
  }
  return { sent, fetcher }
}

const CSV = 'quarter,revenue\nq3,42\n'
const csv = () => new Response(CSV, { headers: { 'content-type': 'text/csv; charset=utf-8' } })
const redirect = (location: string) => () => new Response(null, { status: 302, headers: { location } })
/** A 200 KiB file: more than a deployment without the files bucket keeps. */
const big = () => new Response('x'.repeat(200 * 1024), { headers: { 'content-type': 'text/csv' } })
/** A response that says it is larger than 25 MiB, whatever it holds. */
const declared = () => new Response('tiny', { headers: { 'content-length': String(26 * 1024 * 1024) } })

/**
 * `materialize` over the docs connection (signed in, the owner's label "Docs · Work"), the owner's files in memory,
 * and links fetched through `fetcher`; the clock at {@link NOON}.
 */
const fixture = async (fetcher: typeof fetch, held: Readonly<Record<string, string>> = {}) => {
  const credentials = new MemoryCredentials()
  await credentials.saveTokens('docs', { access_token: 'connection-token', token_type: 'bearer' }, 0)
  const host = mcpHost({
    servers: [{ connectionId: 'docs', endpoint: 'https://docs.test/mcp', label: 'Docs · Work' }],
    credentials,
    grants: new MemoryGrants([{ connectionId: 'docs', capability: 'resource', name: 'docs://reports/q3.csv' }]),
    registries: new MemoryRegistries(),
    labels: new MemoryLabels(),
    appUrl: 'https://goblin.test',
    fetch: async (input, init) => docs.fetch(new Request(input, init)),
  })
  const files = memoryFiles(held)
  // SAFETY: materialize reads only the instance's fetch of AgentInput.
  const input = { mcpFetch: fetcher } as AgentInputs
  const layer = host.pipe(
    Layer.provideMerge(Layer.mergeAll(SingleFlight.layer, TestClock.layer())),
    Layer.merge(Layer.mergeAll(files.layer, Layer.succeed(AgentInput, input))),
  )
  const keep = (content: CallToolResult['content'], images = false): Promise<Materialized> =>
    Effect.runPromise(
      Effect.provide(
        Effect.andThen(TestClock.setTime(NOON), materialize('docs', { content }, { images: Effect.succeed(images) })),
        layer,
      ),
    )
  return { keep, files }
}

const link = (uri: string, name: string, mimeType?: string) => ({
  type: 'resource_link' as const,
  uri,
  name,
  ...(mimeType === undefined ? {} : { mimeType }),
})

describe('files from MCP content (unit)', () => {
  it("keeps a public link's file, fetched without the connection's credentials", async () => {
    const signed = 'https://cdn.example.com/exports/q3%20report.csv?X-Amz-Signature=signed-secret#top'
    const { sent, fetcher } = web({
      'https://cdn.example.com/exports/q3%20report.csv?X-Amz-Signature=signed-secret': csv,
    })
    const { keep, files } = await fixture(fetcher)
    const content = [{ type: 'text' as const, text: 'Your export is ready.' }, link(signed, 'Q3 report')]
    const received = await keep(content)
    const file = { path: `${FOLDER}/Q3 report.csv`, name: 'Q3 report.csv', size: CSV.length, mimeType: 'text/csv' }
    expect(received).toEqual(new Map([[1, { kind: 'file', file }]]))
    expect(new TextDecoder().decode(files.written.get(file.path)?.bytes)).toBe(CSV)
    // The signed URL is what is fetched, as anyone could: no token, no cookie.
    expect(sent.map(({ url }) => url)).toEqual([
      'https://cdn.example.com/exports/q3%20report.csv?X-Amz-Signature=signed-secret',
    ])
    expect(Object.keys(sent[0]?.headers ?? {})).not.toContain('authorization')
    expect(Object.keys(sent[0]?.headers ?? {})).not.toContain('cookie')
    expect(JSON.stringify(sent)).not.toContain('connection-token')

    // The model reads the file's reference in the link's place; the signature reaches neither it nor the transcript.
    const projected = mcpModelResult('docs', { content }, received)
    const reference = projected.content?.[2]
    expect(reference?.type === 'text' && JSON.parse(reference.text)).toEqual({ receivedFile: file })
    expect(projected.details).toMatchObject({
      content: [{ type: 'text' }, { type: 'resource_link', uri: 'https://cdn.example.com/exports/q3%20report.csv' }],
      received: [file],
    })
    expect(JSON.stringify(projected)).not.toContain('signed-secret')
  })

  it('refuses a link that is not a public https address, and never fetches it', async () => {
    const { sent, fetcher } = web({})
    const { keep, files } = await fixture(fetcher)
    const refused = [
      'http://cdn.example.com/a.pdf',
      'https://localhost/a.pdf',
      'https://localhost./a.pdf',
      'https://127.0.0.1/a.pdf',
      'https://[::1]/a.pdf',
      'https://nas.local/a.pdf',
      'https://intranet/a.pdf',
      'https://user:pw@cdn.example.com/a.pdf',
    ]
    const received = await keep(refused.map((uri) => link(uri, 'a.pdf')))
    expect([...received.values()]).toEqual(
      refused.map(() => ({ kind: 'note', note: 'could not fetch a.pdf: it is not a public https address' })),
    )
    expect(sent).toEqual([])
    expect(files.written.size).toBe(0)
  })

  it('follows at most three redirects, each to a public https address again', async () => {
    const { sent, fetcher } = web({
      'https://cdn.example.com/moved.csv': redirect('/exports/moved.csv'),
      'https://cdn.example.com/exports/moved.csv': redirect('https://files.example.org/moved.csv?sig=one'),
      'https://files.example.org/moved.csv?sig=one': csv,
      'https://cdn.example.com/inside.csv': redirect('https://10.0.0.7/inside.csv'),
      'https://cdn.example.com/plain.csv': redirect('http://cdn.example.com/plain.csv'),
      'https://cdn.example.com/loop.csv': redirect('https://cdn.example.com/loop.csv'),
    })
    const { keep } = await fixture(fetcher)
    const received = await keep([
      link('https://cdn.example.com/moved.csv', 'moved.csv'),
      link('https://cdn.example.com/inside.csv', 'inside.csv'),
      link('https://cdn.example.com/plain.csv', 'plain.csv'),
      link('https://cdn.example.com/loop.csv', 'loop.csv'),
    ])
    expect(received.get(0)).toMatchObject({ kind: 'file', file: { path: `${FOLDER}/moved.csv` } })
    expect(received.get(1)).toEqual({
      kind: 'note',
      note: 'could not fetch inside.csv: it redirected to an address that is not public https',
    })
    expect(received.get(2)).toEqual({
      kind: 'note',
      note: 'could not fetch plain.csv: it redirected to an address that is not public https',
    })
    expect(received.get(3)).toEqual({ kind: 'note', note: 'could not fetch loop.csv: it redirected too many times' })
    // The private address is never asked; the loop is asked four times: the link and three redirects.
    expect(sent.map(({ url }) => url)).not.toContain('https://10.0.0.7/inside.csv')
    expect(sent.filter(({ url }) => url === 'https://cdn.example.com/loop.csv')).toHaveLength(4)
  })

  it('stops reading a download past 25 MiB, whatever it declared', async () => {
    const MIB = new Uint8Array(1024 * 1024)
    let pulled = 0
    let cancelled = false
    const endless = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull: (controller) => {
            pulled += 1
            controller.enqueue(MIB)
          },
          cancel: () => {
            cancelled = true
          },
        }),
      )
    const { fetcher } = web({
      'https://cdn.example.com/huge.bin': endless,
      'https://cdn.example.com/says.bin': declared,
    })
    const { keep, files } = await fixture(fetcher)
    const received = await keep([
      link('https://cdn.example.com/huge.bin', 'huge.bin'),
      link('https://cdn.example.com/says.bin', 'says.bin'),
    ])
    expect([...received.values()]).toEqual([
      { kind: 'note', note: 'could not fetch huge.bin: it is larger than 25 MiB' },
      { kind: 'note', note: 'could not fetch says.bin: it is larger than 25 MiB' },
    ])
    expect(cancelled).toBe(true)
    expect(pulled).toBeLessThanOrEqual(27)
    expect(files.written.size).toBe(0)
  })

  it("reads a link of another scheme from its own server, only as the owner's grant allows", async () => {
    const { sent, fetcher } = web({})
    const { keep, files } = await fixture(fetcher)
    const received = await keep([
      link('docs://reports/q3.csv', 'Q3'),
      link('docs://private/notes.txt?token=signed-secret', 'notes.txt', 'text/plain'),
    ])
    expect(received.get(0)).toEqual({
      kind: 'file',
      file: { path: `${FOLDER}/Q3.csv`, name: 'Q3.csv', size: CSV.length, mimeType: 'text/csv' },
    })
    expect(new TextDecoder().decode(files.written.get(`${FOLDER}/Q3.csv`)?.bytes)).toBe(CSV)
    // Not granted: the link stays a reference, without its query, and the call goes on.
    expect(received.get(1)).toEqual({
      kind: 'note',
      note: 'could not fetch notes.txt: the owner has not allowed reading it',
      link: { uri: 'docs://private/notes.txt', name: 'notes.txt' },
    })
    expect(sent).toEqual([])
  })

  it('keeps embedded blobs, long text and audio, shows a small image to a model that sees images, and leaves short text', async () => {
    const { fetcher } = web({})
    const { keep, files } = await fixture(fetcher)
    const image = '\u0089PNG\r\n\u001A\nfixture'
    const png = btoa(image)
    const long = 'x'.repeat(17 * 1024)
    const content: CallToolResult['content'] = [
      { type: 'resource', resource: { uri: 'docs://charts/q3.png', mimeType: 'image/png', blob: png } },
      { type: 'resource', resource: { uri: 'docs://logs/build', mimeType: 'text/plain', text: long } },
      { type: 'resource', resource: { uri: 'docs://notes/short.md', mimeType: 'text/markdown', text: 'short' } },
      { type: 'audio', data: btoa('ID3fixture'), mimeType: 'audio/mpeg' },
      { type: 'resource', resource: { uri: 'docs://broken.bin', blob: 'not base64!' } },
    ]
    const received = await keep(content, true)
    const chart = { path: `${FOLDER}/q3.png`, name: 'q3.png', size: image.length, mimeType: 'image/png' }
    expect(received.get(0)).toEqual({ kind: 'file', file: chart, image: { data: png, mimeType: 'image/png' } })
    expect(received.get(1)).toMatchObject({ kind: 'file', file: { path: `${FOLDER}/build.txt`, size: long.length } })
    expect(received.has(2)).toBe(false)
    expect(received.get(3)).toMatchObject({
      kind: 'file',
      file: { path: `${FOLDER}/audio.mp3`, mimeType: 'audio/mpeg' },
    })
    expect(received.get(4)).toEqual({ kind: 'note', note: 'could not keep broken.bin: its bytes are not base64' })
    expect(files.written.size).toBe(3)

    // The model reads each file's reference, the small image beside it; short text stays as it was.
    const projected = mcpModelResult('docs', { content }, received)
    const { path, name, mimeType, size } = chart
    expect(projected.content?.slice(1, 3)).toEqual([
      { type: 'text', text: JSON.stringify({ receivedFile: { path, name, mimeType, size } }) },
      { type: 'image', data: png, mimeType: 'image/png' },
    ])
    expect(JSON.stringify(projected.content)).toContain('short')
    // The transcript keeps no bytes of a kept block.
    expect(JSON.stringify(projected.details)).not.toContain(png)
    expect(JSON.stringify(projected.details)).not.toContain(long)
    expect(JSON.stringify(projected.details)).not.toContain(btoa('ID3fixture'))

    // A model that does not see images reads the reference alone.
    expect((await keep(content.slice(0, 1))).get(0)).not.toHaveProperty('image')
  })

  it('never replaces a file already in the folder, and keeps at most eight files of one result', async () => {
    const { fetcher } = web({ 'https://cdn.example.com/a.csv': csv, 'https://cdn.example.com/big.csv': big })
    const { keep, files } = await fixture(fetcher, { [`${FOLDER}/a.csv`]: 'mine' })
    const received = await keep(Array.from({ length: 9 }, () => link('https://cdn.example.com/a.csv', 'a.csv')))
    expect([...received.values()].slice(0, 3).map((item) => item.kind === 'file' && item.file.name)).toEqual([
      'a (2).csv',
      'a (3).csv',
      'a (4).csv',
    ])
    expect(received.get(8)).toEqual({ kind: 'note', note: 'could not fetch a.csv: one result keeps at most 8 files' })
    expect(new TextDecoder().decode(files.written.get(`${FOLDER}/a.csv`)?.bytes)).toBe('mine')

    // Full storage is a note too, never a failed call.
    files.state.full = true
    expect((await keep([link('https://cdn.example.com/a.csv', 'a.csv')])).get(0)).toEqual({
      kind: 'note',
      note: "could not fetch a.csv: the owner's files are full",
    })
    // A deployment without the files bucket keeps no file over 128 KiB (ADR 0064).
    files.state.full = false
    files.state.fileLimit = 128 * 1024
    expect((await keep([link('https://cdn.example.com/big.csv', 'big.csv')])).get(0)).toEqual({
      kind: 'note',
      note: 'could not fetch big.csv: it is larger than 128 KiB',
    })
  })

  it("leaves an App's own resource to the Apps host, linked or embedded", async () => {
    const { sent, fetcher } = web({})
    const { keep, files } = await fixture(fetcher)
    const html = `<!doctype html>${'<p>view</p>'.repeat(2000)}`
    const received = await keep([
      link('ui://docs/view.html', 'View'),
      { type: 'resource', resource: { uri: 'ui://docs/view.html', mimeType: 'text/html;profile=mcp-app', text: html } },
    ])
    expect(received.size).toBe(0)
    expect(sent).toEqual([])
    expect(files.written.size).toBe(0)
  })

  it('records every link without its query and fragment, kept or not', () => {
    const projected = mcpModelResult('docs', {
      content: [
        link('https://cdn.example.com/a.pdf?sig=signed-secret', 'a.pdf'),
        { type: 'resource', resource: { uri: 'https://cdn.example.com/b.txt#signed-secret', text: 'b' } },
      ],
    })
    expect(projected.details).toMatchObject({
      content: [
        { type: 'resource_link', uri: 'https://cdn.example.com/a.pdf' },
        { type: 'resource', resource: { uri: 'https://cdn.example.com/b.txt', text: 'b' } },
      ],
    })
    expect(JSON.stringify(projected)).not.toContain('signed-secret')
  })
})
