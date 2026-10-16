import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { shelfOf, suggestedTitle, suggestions } from '../../src/mcp/servers/shelf.ts'

const shelf = shelfOf(undefined)

describe('the suggested servers', () => {
  it('marks what the owner already has', () => {
    const marked = suggestions(shelf, new Set(['https://mysi.lol/mcp?codemode=off']))
    expect(marked.find((item) => item.id === 'mysi')).toMatchObject({
      endpoint: 'https://mysi.lol/mcp?codemode=off',
      group: 'yours',
      added: true,
      signIn: true,
    })
    expect(marked.find((item) => item.id === 'deepwiki')).toMatchObject({ added: false, signIn: false, group: 'code' })
  })
  it('counts a mysi connection made without the query as added', () => {
    const marked = suggestions(shelf, new Set(['https://mysi.lol/mcp/']))
    expect(marked.find((item) => item.id === 'mysi')?.added).toBe(true)
  })
  it('offers mysi once instead of each my* app', () => {
    const ids = shelf.map((item) => item.id)
    expect(ids).toContain('mysi')
    for (const app of ['myplan', 'mytab', 'mygram', 'myinbox', 'myskills']) expect(ids).not.toContain(app)
  })
  it('suggests only https endpoints, each id once', () => {
    expect(new Set(shelf.map((item) => item.id)).size).toBe(shelf.length)
    for (const item of shelf) expect(new URL(item.endpoint).protocol).toBe('https:')
  })
  it('needs sign-in only for the owner’s own apps and the services that publish for them', () => {
    for (const item of shelf) expect(item.signIn).toBe(item.group === 'yours' || item.group === 'publish')
  })
  it('draws each mark from the web app’s own files, and passes it on with the suggestion', () => {
    const marked = shelf.filter((item) => item.icon !== undefined)
    expect(marked.length).toBeGreaterThan(0)
    for (const item of marked) {
      expect(item.icon).toBe(`/shelf/${item.id}.svg`)
      expect(existsSync(fileURLToPath(new URL(`../../../web/public${String(item.icon)}`, import.meta.url).href))).toBe(
        true,
      )
    }
    expect(suggestions(shelf, new Set()).find((item) => item.id === 'cloudflare')?.icon).toBe('/shelf/cloudflare.svg')
  })
  it('names a server added from the shelf by its title', () => {
    expect(suggestedTitle(shelf, 'https://mcp.kiwi.com/')).toBe('Kiwi.com')
    expect(suggestedTitle(shelf, 'https://unknown.example/mcp')).toBeUndefined()
  })
})

describe("a deployment's shelf (MCP_SHELF)", () => {
  const mysiDev = {
    id: 'mysi',
    title: 'mysi',
    description: 'Your my* apps, on the dev deployment.',
    endpoint: 'https://dev.mysi.lol/mcp?codemode=off',
    group: 'yours',
    signIn: true,
  }
  const notes = { ...mysiDev, id: 'notes', title: 'Notes', endpoint: 'https://notes.example/mcp', signIn: false }

  it('replaces an entry by its id in place, and adds the others after goblin’s', () => {
    const given = shelfOf(JSON.stringify([notes, mysiDev]))
    expect(given.map((item) => item.id).indexOf('mysi')).toBe(shelf.map((item) => item.id).indexOf('mysi'))
    expect(given.find((item) => item.id === 'mysi')?.endpoint).toBe('https://dev.mysi.lol/mcp?codemode=off')
    expect(given.at(-1)?.id).toBe('notes')
    expect(given).toHaveLength(shelf.length + 1)
  })
  it('keeps goblin’s shelf when unset or blank, and refuses one that does not decode', () => {
    expect(shelfOf('')).toBe(shelf)
    expect(() => shelfOf('{"id":"x"}')).toThrow()
    expect(() => shelfOf(JSON.stringify([{ ...notes, group: 'elsewhere' }]))).toThrow()
  })
})
