import type { SubmissionRecord } from '@earendil-works/pi-durable'
import { describe, expect, it } from '@effect/vitest'
import { OtlpTraceData } from '@goblin/contracts/inspect'
import { RunAttribute, type RunEvent } from '@goblin/contracts/telemetry'
import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as TestClock from 'effect/testing/TestClock'
import { conversationId, entryId, submissionId } from '../src/pi/context.ts'
import { flowRunEvent } from '../src/telemetry/events.ts'
import { inspectionFixture } from './inspection-fixture.ts'

const NOW = 1_760_000_000_000
const release = 'a'.repeat(40)
const next = 'b'.repeat(40)

const event = (id: string, kind: RunEvent['kind'], fields: Partial<RunEvent> = {}): RunEvent => ({
  id,
  kind,
  status: 'ok',
  conversationId: '1',
  operationId: 'op-1',
  startedAt: NOW - 10_000,
  endedAt: NOW - 1_000,
  attributes: { [RunAttribute.agentVersion]: release },
  ...fields,
})

/** A turn in main: an attempt, an MCP tool call with its request, and the Persona answer it started in a thread. */
const turnEvents: readonly RunEvent[] = [
  event('turn:7', 'turn.submitted', {
    attributes: { [RunAttribute.agentVersion]: release, [RunAttribute.operation]: 'invoke_agent' },
  }),
  event('model:g1:1:3', 'model.attempt', {
    taskId: 'g1',
    startedAt: NOW - 9_000,
    endedAt: NOW - 8_000,
    attributes: {
      [RunAttribute.agentVersion]: release,
      [RunAttribute.requestModel]: 'glm-5.1',
      [RunAttribute.finishReason]: 'toolUse',
      [RunAttribute.firstPartialAt]: NOW - 8_500,
      [RunAttribute.toolsChanged]: 'echo,mcp_call',
      [RunAttribute.entry]: 11,
    },
  }),
  event('tool:t1', 'tool.call', {
    taskId: 't1',
    startedAt: NOW - 7_900,
    endedAt: NOW - 7_000,
    attributes: {
      [RunAttribute.agentVersion]: release,
      [RunAttribute.toolName]: 'mcp_call',
      [RunAttribute.mcpServer]: 'mycut',
      [RunAttribute.mcpTool]: 'job_submit',
    },
  }),
  event('mcp:1', 'mcp.request', {
    taskId: 't1',
    startedAt: NOW - 7_800,
    endedAt: NOW - 7_100,
    status: 'error',
    attributes: {
      [RunAttribute.agentVersion]: release,
      [RunAttribute.mcpMethod]: 'tools/call',
      [RunAttribute.mcpServer]: 'mycut',
      [RunAttribute.mcpTool]: 'job_submit',
      [RunAttribute.errorType]: 'UpstreamMcp:timeout',
      [RunAttribute.error]: 'Remote MCP request failed (timeout).',
    },
  }),
  // The agent restarted into a new release before this attempt.
  event('model:g1:2:9', 'model.attempt', {
    taskId: 'g1',
    status: 'started',
    startedAt: NOW - 6_000,
    endedAt: undefined,
    attributes: { [RunAttribute.agentVersion]: next, [RunAttribute.requestModel]: 'glm-5.1' },
  }),
  event('persona:op-1:3', 'turn.submitted', {
    operationId: 'persona:op-1:3',
    conversationId: '40',
    startedAt: NOW - 5_000,
    attributes: { [RunAttribute.agentVersion]: next },
  }),
]

const settled: Readonly<Record<string, SubmissionRecord>> = {
  '1/op-1': {
    id: submissionId(1),
    conversationId: conversationId('1'),
    type: 'input',
    status: 'done',
    entry: entryId(10),
    answer: entryId(15),
  },
}

const traced = () => {
  const fixture = inspectionFixture(settled)
  for (const each of turnEvents) fixture.ledger.ended(each)
  fixture.ledger.ended(
    flowRunEvent(
      { flow: 'send', via: 'app', actor: 'owner', chat: '1', operationId: 'op-1', status: 'ok' },
      'f1',
      NOW - 9_500,
    ),
  )
  return fixture
}

const spansOf = (trace: OtlpTraceData) =>
  trace.resourceSpans.flatMap((resource) => resource.scopeSpans.flatMap((scope) => scope.spans))
const attribute = (
  span: { readonly attributes: OtlpTraceData['resourceSpans'][number]['resource']['attributes'] },
  key: string,
) => span.attributes.find((each) => each.key === key)?.value

describe('a turn as an OpenTelemetry trace (ADR 0107)', () => {
  it.effect('names its spans by the GenAI and MCP conventions and nests them', () =>
    Effect.gen(function* () {
      const fixture = traced()
      yield* TestClock.setTime(NOW)
      const trace = yield* fixture.inspection.trace('op-1')
      fixture.close()
      expect(Schema.is(OtlpTraceData)(trace)).toBe(true)
      const spans = spansOf(trace)
      const byName = (name: string) => spans.filter((span) => span.name === name)
      const [root] = byName('invoke_agent goblin')
      const [tool] = byName('execute_tool mcp_call')
      const [request] = byName('tools/call job_submit')
      expect(spans.map((span) => span.name).toSorted()).toEqual([
        'chat glm-5.1',
        'chat glm-5.1',
        'execute_tool mcp_call',
        'invoke_agent goblin',
        'invoke_agent goblin',
        'tools/call job_submit',
      ])
      expect(new Set(spans.map((span) => span.traceId)).size).toBe(1)
      expect(root?.traceId).toMatch(/^[0-9a-f]{32}$/u)
      expect(root?.spanId).toMatch(/^[0-9a-f]{16}$/u)
      expect(root?.parentSpanId).toBe('')
      expect(root?.kind).toBe(1)
      expect(tool?.parentSpanId).toBe(root?.spanId)
      // The MCP request sits inside the tool call that made it, a client span that failed.
      expect(request).toMatchObject({
        parentSpanId: tool?.spanId,
        kind: 3,
        status: { code: 2, message: 'Remote MCP request failed (timeout).' },
      })
      // A turn it started nests under it.
      const persona = byName('invoke_agent goblin').find((span) => span !== root)
      expect(persona?.parentSpanId).toBe(root?.spanId)
      // The flow step is an event on its operation's root span.
      expect(root?.events.map((each) => each.name)).toEqual(['flow send'])
      // The settlement's entries, so a reader can join the words in.
      expect(attribute(root!, 'goblin.submission.answer')).toEqual({ intValue: 15 })
      expect(attribute(root!, RunAttribute.chat)).toEqual({ stringValue: '1' })
    }),
  )

  it.effect('says when each call ran, in the conventions’ units, and is the same trace on every read', () =>
    Effect.gen(function* () {
      const fixture = traced()
      yield* TestClock.setTime(NOW)
      const trace = yield* fixture.inspection.trace('op-1')
      const again = yield* fixture.inspection.trace('op-1')
      fixture.close()
      expect(again).toEqual(trace)
      const [attempt, running] = spansOf(trace).filter((span) => span.name === 'chat glm-5.1')
      expect(attempt?.startTimeUnixNano).toBe(`${NOW - 9_000}000000`)
      expect(attribute(attempt!, RunAttribute.finishReason)).toEqual({
        arrayValue: { values: [{ stringValue: 'tool_call' }] },
      })
      expect(attribute(attempt!, 'gen_ai.response.time_to_first_chunk')).toEqual({ doubleValue: 0.5 })
      expect(attribute(attempt!, RunAttribute.toolsChanged)).toEqual({
        arrayValue: { values: [{ stringValue: 'echo' }, { stringValue: 'mcp_call' }] },
      })
      // Still running: it ends now, with an unset status.
      expect(running).toMatchObject({ endTimeUnixNano: `${NOW}000000`, status: { code: 0 } })
    }),
  )

  it.effect('groups spans by the release they ran on, under one goblin service in its stage', () =>
    Effect.gen(function* () {
      const fixture = traced()
      yield* TestClock.setTime(NOW)
      const trace = yield* fixture.inspection.trace('op-1')
      fixture.close()
      const services = trace.resourceSpans.map((resource) => ({
        version: attribute(resource.resource, 'service.version'),
        name: attribute(resource.resource, 'service.name'),
        stage: attribute(resource.resource, 'deployment.environment.name'),
      }))
      expect(services).toEqual([
        { version: { stringValue: release }, name: { stringValue: 'goblin' }, stage: { stringValue: 'test' } },
        { version: { stringValue: next }, name: { stringValue: 'goblin' }, stage: { stringValue: 'test' } },
      ])
    }),
  )

  it.effect('is NotFound for an operation that ran no turn', () =>
    Effect.gen(function* () {
      const fixture = inspectionFixture()
      const failure = yield* Effect.flip(fixture.inspection.trace('op-missing'))
      fixture.close()
      expect(failure).toMatchObject({ _tag: 'NotFound', what: 'turn' })
    }),
  )
})
