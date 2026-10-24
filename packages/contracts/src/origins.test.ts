import { describe, expect, it } from 'vitest'
import { grantOriginsOf, serverOriginOf } from './origins.ts'

const job = (origin: string, tools: readonly string[] = ['job_submit']) => ({ origin, tools })

describe("a grant's MCP origins (ADR 0091)", () => {
  it('keeps https origins of public hosts, normalized, with their tools once each', () => {
    expect(grantOriginsOf([job('https://MCP.Swarmm.app/', ['job_submit', 'job_status', 'job_submit'])])).toEqual({
      origins: [{ origin: 'https://mcp.swarmm.app', tools: ['job_submit', 'job_status'] }],
    })
    expect(grantOriginsOf([job('https://dev.swarmm.app:8443')])).toEqual({
      origins: [job('https://dev.swarmm.app:8443')],
    })
    expect(grantOriginsOf([])).toEqual({ origins: [] })
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
    ['localhost with a trailing dot', 'https://localhost.'],
    ['a localhost name with a trailing dot', 'https://api.localhost.'],
    ['an internal name with a trailing dot', 'https://db.corp.internal.'],
    ['no address at all', 'mcp.swarmm.app'],
  ])('refuses %s as origin', (_case, origin) => {
    expect(grantOriginsOf([job(origin)])).toEqual({ problem: 'origin' })
  })

  it('refuses the same origin twice and more than eight, and tools that are none, all or too many', () => {
    expect(grantOriginsOf([job('https://a.example'), job('https://A.example/')])).toEqual({ problem: 'origin' })
    const nine = Array.from({ length: 9 }, (_, n) => job(`https://s${n}.example`))
    expect(grantOriginsOf(nine)).toEqual({ problem: 'origin' })
    expect(grantOriginsOf([job('https://a.example', [])])).toEqual({ problem: 'origin_tools' })
    expect(grantOriginsOf([job('https://a.example', ['all'])])).toEqual({ problem: 'origin_tools' })
    const many = Array.from({ length: 51 }, (_, n) => `tool_${n}`)
    expect(grantOriginsOf([job('https://a.example', many)])).toEqual({ problem: 'origin_tools' })
  })

  it("names the origin a thread's server url is on, and none for one no grant may name", () => {
    expect(serverOriginOf('https://MCP.swarmm.app/mcp/job/42?token=x')).toBe('https://mcp.swarmm.app')
    expect(serverOriginOf('http://mcp.swarmm.app/mcp')).toBeUndefined()
    expect(serverOriginOf('https://127.0.0.1/mcp')).toBeUndefined()
    expect(serverOriginOf('not a url')).toBeUndefined()
  })
})
