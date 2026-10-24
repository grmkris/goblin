import { describe, expect, it } from 'vitest'
import { PersonaView, SourcesDetails, SourceUse } from '@goblin/contracts'
import { Schema } from 'effect'
import { activePersonas, personasByMaker, taggedPersonas } from '../src/lib/personas.ts'
import { sourcePlaces, sourceTopics, sourcesOf } from '../src/lib/sources.ts'

// Every fixture decodes with the contract schema the runtime answers with.
const source = (topicName: string, chat: string, entryStart: number) => ({
  topic: topicName === 'Personal' ? 1 : 2,
  topicName,
  chat,
  entryStart,
  entryEnd: entryStart + 2,
  excerpt: `about ${topicName}`,
  retrievedAt: 100,
  score: 0.8,
})
const details = Schema.decodeUnknownSync(SourcesDetails)({
  kind: 'sources',
  mode: 'tool',
  sources: [source('Japan', '20', 4), source('Personal', '1', 9), source('Japan', '21', 2)],
})
const use = (inputEntry: number | undefined, topicName = 'Japan', mode = 'auto') =>
  Schema.decodeUnknownSync(SourceUse)({
    id: `use-${String(inputEntry)}-${mode}`,
    chat: '1',
    ...(inputEntry !== undefined && { inputEntry }),
    mode,
    sources: [source(topicName, '20', 4)],
    retrievedAt: 100,
  })
const persona = (id: number, name: string, archivedAt?: number, app?: string) =>
  Schema.decodeUnknownSync(PersonaView)({
    id,
    name,
    avatar: { glyph: name.slice(0, 1), hue: id * 40 },
    role: `${name} role`,
    instructions: 'Be useful.',
    setup: { mcpServers: [], skills: [], apps: [] },
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    ...(archivedAt !== undefined && { archivedAt }),
    ...(app !== undefined && { madeBy: { app } }),
  })
const PARTS = [
  { id: '3:0', kind: 'user' },
  { id: '4:0:reasoning', kind: 'reasoning' },
  { id: '4:0:text', kind: 'text' },
  { id: 'tool:c1', kind: 'tool' },
  { id: '6:0:text', kind: 'text' },
  { id: '7:0', kind: 'user' },
  { id: '9:0', kind: 'persona-ask' },
]

describe('the source strip', () => {
  it("reads a search_chats call's sources from its details, and none from anything else", () => {
    expect(sourcesOf(details).map(({ chat }) => chat)).toEqual(['20', '1', '21'])
    expect(sourcesOf({ kind: 'other' })).toEqual([])
    expect(sourcesOf(undefined)).toEqual([])
  })

  it('names each Topic once, in the order the sources came', () => {
    expect(sourceTopics(details.sources)).toEqual(['Japan', 'Personal'])
  })

  it('puts an automatic retrieval under the last answer text of the turn its input started', () => {
    const places = sourcePlaces(PARTS, [use(3), use(7), use(9), use(42)])
    expect([...places.keys()]).toEqual(['6:0:text', '7:0', '9:0'])
    expect(places.get('6:0:text')?.[0]?.id).toBe('use-3-auto')
  })

  it('leaves a search_chats call, which draws its own strip, and a use naming no input without a place', () => {
    expect(sourcePlaces(PARTS, [use(3, 'Japan', 'tool'), use(undefined)]).size).toBe(0)
  })
})

describe('Personas in the composer', () => {
  it('shows the ones not archived, by name', () => {
    const offered = activePersonas([persona(2, 'critic'), persona(1, 'Coach'), persona(3, 'Old', 5)])
    expect(offered.map(({ name }) => name)).toEqual(['Coach', 'critic'])
    expect(activePersonas([])).toEqual([])
  })

  it("lists the owner's own Personas apart from each app's, by app and then by name, never an archived one", () => {
    const { own, apps } = personasByMaker([
      persona(1, 'coach'),
      persona(2, 'scout', undefined, 'swarmm-prod'),
      persona(3, 'Analyst', undefined, 'swarmm-prod'),
      persona(4, 'old', 5, 'swarmm-prod'),
      persona(5, 'runner', undefined, 'Sidequest'),
    ])
    expect(own.map(({ name }) => name)).toEqual(['coach'])
    expect(apps.map(({ app, personas }) => [app, personas.map(({ name }) => name)])).toEqual([
      ['Sidequest', ['runner']],
      ['swarmm-prod', ['Analyst', 'scout']],
    ])
  })

  it('counts the Personas a draft tags, for the together-or-in-turn choice', () => {
    const tagged = [1, 2].map((personaId) => ({
      selection: { kind: 'persona' as const, personaId },
      label: `P${String(personaId)}`,
      description: '',
    }))
    const connection = {
      selection: { kind: 'connection' as const, connectionId: 'myplan' },
      label: 'myplan',
      description: '',
    }
    expect(taggedPersonas([...tagged, connection])).toBe(2)
    expect(taggedPersonas([connection])).toBe(0)
  })
})
