import { describe, expect, it } from 'vitest'
import { keyOriginsOf, serverOriginOf } from './account.ts'

const job = (origin: string, tools: readonly string[] = ['job_submit']) => ({ origin, tools })

describe("a key's MCP origins (ADR 0091)", () => {
  it('keeps https origins of public hosts, normalized, with their tools once each', () => {
    expect(keyOriginsOf([job('https://MCP.Swarmm.app/', ['job_submit', 'job_status', 'job_submit'])])).toEqual({
      origins: [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit', 'job_status'] }],
    })
    expect(keyOriginsOf([job('https://dev.swarmm.app:8443')])).toEqual({
      origins: [job('https://dev.swarmm.app:8443')],
    })
    expect(keyOriginsOf([])).toEqual({ origins: [] })
  })

  it.each([
    ['plain http', 'http://mcp.swarmm.app'],
    ['a path', 'https://mcp.swarmm.app/mcp'],
    ['a query', 'https://mcp.swarmm.app/?x=1'],
    ['credentials', 'https://user:pass@mcp.swarmm.app'],
    ['an IP literal', 'https://10.0.0.1'],
    ['an IPv6 literal', 'https://[::1]'],
    ['localhost', 'https://localhost'],
    ['a local name', 'https://printer.local'],
    ['an internal name', 'https://db.corp.internal'],
    ['no address at all', 'mcp.swarmm.app'],
  ])('refuses %s as key_origin', (_case, origin) => {
    expect(keyOriginsOf([job(origin)])).toEqual({ problem: 'key_origin' })
  })

  it('refuses the same origin twice and more than eight, and tools that are none, all or too many', () => {
    expect(keyOriginsOf([job('https://a.example'), job('https://A.example/')])).toEqual({ problem: 'key_origin' })
    const nine = Array.from({ length: 9 }, (_, n) => job(`https://s${n}.example`))
    expect(keyOriginsOf(nine)).toEqual({ problem: 'key_origin' })
    expect(keyOriginsOf([job('https://a.example', [])])).toEqual({ problem: 'key_origin_tools' })
    expect(keyOriginsOf([job('https://a.example', ['all'])])).toEqual({ problem: 'key_origin_tools' })
    const many = Array.from({ length: 51 }, (_, n) => `tool_${n}`)
    expect(keyOriginsOf([job('https://a.example', many)])).toEqual({ problem: 'key_origin_tools' })
  })

  it("names the origin a thread's server url is on, and none for one no key may name", () => {
    expect(serverOriginOf('https://MCP.swarmm.app/mcp/job/42?token=x')).toBe('https://mcp.swarmm.app')
    expect(serverOriginOf('http://mcp.swarmm.app/mcp')).toBeUndefined()
    expect(serverOriginOf('https://127.0.0.1/mcp')).toBeUndefined()
    expect(serverOriginOf('not a url')).toBeUndefined()
  })
})
