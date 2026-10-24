import { envelopeOf } from '@goblin/contracts/api'
import { ProtocolError } from '@modelcontextprotocol/client'
import { describe, expect, it } from 'vitest'
import { Internal, InvalidArguments, UpstreamMcp } from '../src/http/errors.ts'
import { mapMcpError } from '../src/mcp/connections/errors.ts'
import { describeError, failureAttributes, outcomeOf } from '../src/telemetry/attributes.ts'

describe('a failure as one line (unit, ADR 0024)', () => {
  it('names what failed and why', () => {
    expect(describeError(new Error('boom'))).toBe('boom')
    expect(describeError(new TypeError('x is not a function'))).toBe('TypeError: x is not a function')
    expect(describeError(new UpstreamMcp({ connectionId: 'myplan', reason: 'timeout' }))).toBe(
      'UpstreamMcp (connectionId: myplan, reason: timeout)',
    )
    expect(describeError(new Internal({ reason: 'unexpected' }))).toBe('Internal (reason: unexpected)')
    expect(describeError('empty line')).toBe('empty line')
  })

  it('reads what Workers RPC hands over: a plain object, never [object Object]', () => {
    expect(describeError({ _tag: 'BudgetExhausted', reason: 'daily' })).toBe('BudgetExhausted (reason: daily)')
    expect(describeError({ message: 'socket closed' })).toBe('socket closed')
    expect(describeError({ payload: { text: 'secret' } })).toBe('error without a message')
  })

  it('follows the cause chain and stays bounded', () => {
    expect(describeError(new Error('summary failed', { cause: new Error('empty line') }))).toBe(
      'summary failed, caused by empty line',
    )
    expect(describeError(new Error('x'.repeat(1000)))).toHaveLength(300)
    expect(failureAttributes({ _tag: 'UpstreamMcp', reason: 'timeout' })).toMatchObject({
      'error.type': 'UpstreamMcp:timeout',
      'goblin.error': 'Remote MCP request failed (timeout).',
    })
  })
})

describe("what a server's JSON-RPC error says (unit, ADR 0092)", () => {
  const words = `Unknown folder\u0000 "inbox".\nUse one of: ${'notes, '.repeat(200)}`
  const failure = mapMcpError(new ProtocolError(-32_602, words), 'myplan')
  const said = failure instanceof UpstreamMcp ? (failure.serverMessage ?? '') : ''

  it('keeps its message as one line of at most 500 characters, without control characters', () => {
    expect(failure).toMatchObject({ _tag: 'UpstreamMcp', connectionId: 'myplan', reason: 'remote-rpc', code: -32_602 })
    expect(said).toMatch(/^Unknown folder "inbox"\. Use one of: notes, notes, /u)
    expect(Array.from(said)).toHaveLength(500)
    expect(said.endsWith('…')).toBe(true)
    expect(said).not.toMatch(/\p{Cc}/u)
    // Of `data`, only text is kept; nothing is kept of a server that says nothing.
    expect(mapMcpError(new ProtocolError(-32_602, 'Bad call', 'treeId is required'), 'myplan')).toMatchObject({
      serverMessage: 'Bad call: treeId is required',
    })
    expect(mapMcpError(new ProtocolError(-32_602, 'Bad call', { token: 'secret' }), 'myplan')).toMatchObject({
      serverMessage: 'Bad call',
    })
    expect(mapMcpError(new ProtocolError(-32_602, ' \n '), 'myplan')).not.toHaveProperty('serverMessage')
  })

  it("shows it whole after the failure, as the server's words", () => {
    expect(describeError(failure)).toBe(
      `UpstreamMcp (connectionId: myplan, reason: remote-rpc, code: -32602): the server says: ${JSON.stringify(said)}`,
    )
  })

  it('keeps it out of telemetry and out of the API envelope', () => {
    expect(outcomeOf(failure)).toBe('UpstreamMcp:remote-rpc')
    expect(failureAttributes(failure)).toEqual({
      'error.type': 'UpstreamMcp:remote-rpc',
      'goblin.error': 'Remote MCP request failed (remote-rpc).',
    })
    expect(JSON.stringify(envelopeOf(failure))).not.toContain('Unknown folder')
  })
})

describe('arguments that do not fit a tool (unit, ADR 0092)', () => {
  it('are invalid_arguments in telemetry, with none of their problems', () => {
    const failure = new InvalidArguments({
      connectionId: 'tree',
      name: 'move',
      problems: ['/step/source: Instance does not have required property "treeId".'],
    })
    expect(outcomeOf(failure)).toBe('invalid_arguments')
    expect(failureAttributes(failure)).toEqual({
      'error.type': 'invalid_arguments',
      'goblin.error': 'Tool arguments did not match the input schema.',
    })
  })
})
