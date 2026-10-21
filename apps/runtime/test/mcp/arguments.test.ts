import { createMcpHandler } from '@modelcontextprotocol/server'
import { describe, expect, it } from 'vitest'
import { InvalidArguments } from '../../src/http/errors.ts'
import type { McpStep } from '../../src/telemetry/report.ts'
import { lowLevelServer } from './low-level-server.ts'
import { managerOf } from './manager.ts'
import { MemoryGrants } from './memory.ts'

/** A tool that moves a node of a tree: a nested required field, an integer, and no other fields. */
const MOVE = {
  type: 'object' as const,
  properties: {
    step: {
      type: 'object',
      properties: { source: { type: 'object', properties: { treeId: { type: 'string' } }, required: ['treeId'] } },
      required: ['source'],
    },
    count: { type: 'integer', minimum: 1 },
    tags: { type: 'array', items: { type: 'string' } },
  },
  required: ['step'],
  additionalProperties: false,
}

/** A long field name with a control character in it, as a careless or hostile schema may hold. */
const ODD = `field\u0007${'x'.repeat(300)}`

/** Twenty required fields, the first with the odd name: more problems than the model is shown. */
const WIDE = {
  type: 'object' as const,
  properties: {},
  required: [ODD, ...Array.from({ length: 19 }, (_, index) => `field${String(index)}`)],
}

/** A schema in a dialect the validator does not read: draft-04. */
const LEGACY = {
  $schema: 'http://json-schema.org/draft-04/schema#',
  type: 'object' as const,
  properties: { id: { type: 'string' } },
  required: ['id'],
}

/** A `format` the server may not check, beside a property that is itself named `format`. */
const LINK = {
  type: 'object' as const,
  properties: { url: { type: 'string', format: 'uri' }, format: { type: 'string', enum: ['mp4', 'png'] } },
  required: ['url', 'format'],
}

/** The tools whose calls reached the server, in order. */
const sent: string[] = []

const tree = createMcpHandler(() => {
  const server = lowLevelServer({ name: 'tree', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler('tools/list', () => ({
    tools: [
      { name: 'move', inputSchema: MOVE },
      { name: 'wide', inputSchema: WIDE },
      { name: 'legacy', inputSchema: LEGACY },
      { name: 'link', inputSchema: LINK },
    ],
  }))
  server.setRequestHandler('tools/call', (request) => {
    sent.push(request.params.name)
    return { content: [{ type: 'text', text: `moved by ${request.params.name}` }] }
  })
  return server
})

const grants = new MemoryGrants(
  ['move', 'wide', 'legacy', 'link'].map((name) => ({ connectionId: 'tree', capability: 'tool' as const, name })),
)

/** A manager over the tree server, with the steps it reports. */
const treeManager = () => {
  const reports: { step: McpStep; outcome: string }[] = []
  const manager = managerOf({
    servers: [{ connectionId: 'tree', endpoint: 'https://tree.test/mcp' }],
    allows: (grant) => grants.allows(grant),
    auth: () => ({ token: async () => 'fixture-token' }),
    report: (step, outcome) => reports.push({ step, outcome }),
    fetch: async (input, init) => tree.fetch(new Request(input, init)),
  })
  return { ...manager, reports }
}

describe("a tool call's arguments are checked against the tool's input schema (unit, ADR 0092)", () => {
  it('refuses a call that does not fit before it reaches the server, listing every problem', async () => {
    const { connections, dispose, reports } = treeManager()
    sent.length = 0
    try {
      const args = { step: { source: {} }, count: 0.5, tags: ['a', 2], extra: true }
      await expect(connections.callTool('tree', 'move', args)).rejects.toMatchObject({
        _tag: 'InvalidArguments',
        connectionId: 'tree',
        name: 'move',
        problems: [
          '/step/source: Instance does not have required property "treeId".',
          '/count: Instance type "number" is invalid. Expected "integer".',
          '/count: 0.5 is less than 1.',
          '/tags/1: Instance type "number" is invalid. Expected "string".',
          '/: Property "extra" is not allowed.',
        ],
      })
      // The model's own call is checked the same way.
      await expect(connections.callModelTool('tree', 'move', {})).rejects.toMatchObject({
        _tag: 'InvalidArguments',
        problems: ['/: Instance does not have required property "step".'],
      })
      expect(sent).toEqual([])
      // Telemetry names the refusal and none of what was wrong.
      expect(reports.filter(({ step }) => step.step === 'call').map(({ outcome }) => outcome)).toEqual([
        'invalid_arguments',
        'invalid_arguments',
      ])
      expect(JSON.stringify(reports)).not.toContain('treeId')
      // A call that fits goes out.
      const result = await connections.callTool('tree', 'move', { step: { source: { treeId: 't1' } }, count: 2 })
      expect(result.content).toEqual([{ type: 'text', text: 'moved by move' }])
      expect(sent).toEqual(['move'])
    } finally {
      await dispose()
    }
  })

  it('keeps at most twelve problems, each one bounded line without control characters', async () => {
    const { connections, dispose } = treeManager()
    try {
      const failure: unknown = await connections
        .callTool('tree', 'wide', {})
        // expected: the test asserts on the failure it captures
        .catch((error: unknown) => error)
      expect(failure).toBeInstanceOf(InvalidArguments)
      const problems = failure instanceof InvalidArguments ? failure.problems : []
      expect(problems).toHaveLength(12)
      expect(problems[0]).toMatch(/^\/: Instance does not have required property "field xxx+…$/u)
      for (const problem of problems) {
        expect(Array.from(problem).length).toBeLessThanOrEqual(200)
        expect(problem).not.toMatch(/\p{Cc}/u)
      }
    } finally {
      await dispose()
    }
  })

  it('leaves `format` to the server, as JSON Schema 2020-12 does, but checks a property named format', async () => {
    const { connections, dispose } = treeManager()
    sent.length = 0
    try {
      await connections.callTool('tree', 'link', { url: 'not a uri', format: 'mp4' })
      expect(sent).toEqual(['link'])
      const refused = await connections.callTool('tree', 'link', { url: 'not a uri', format: 'gif' }).then(
        () => undefined,
        (error: unknown) => error,
      )
      expect(refused).toBeInstanceOf(InvalidArguments)
      expect(sent).toEqual(['link'])
      expect(LINK.properties.url).toEqual({ type: 'string', format: 'uri' })
    } finally {
      await dispose()
    }
  })

  it('sends a call unchecked when the validator cannot read the schema, as before', async () => {
    const { connections, dispose } = treeManager()
    sent.length = 0
    try {
      const result = await connections.callTool('tree', 'legacy', {})
      expect(result.content).toEqual([{ type: 'text', text: 'moved by legacy' }])
      // The schema as listed is left as it was: nothing the validator marks is added to it.
      expect(Object.getOwnPropertyNames(LEGACY)).toEqual(['$schema', 'type', 'properties', 'required'])
      expect(sent).toEqual(['legacy'])
    } finally {
      await dispose()
    }
  })
})
