import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigProvider, Effect } from 'effect'
import { afterEach, describe, expect, test } from 'vitest'
import {
  CHECKER,
  GLOBAL_API_DIAGNOSTICS,
  PLUGIN,
  effectArgs,
  effectProjects,
  missingPlugin,
  pluginBlock,
  severities,
  stripJsonc,
  typecheckProjects,
} from '../effect.ts'
import { placementOf } from '../oxlint/boundaries.ts'
import { nodes } from '../graph.ts'
import { repoRoot } from '../run.ts'

describe('goblin quality tooling', () => {
  test('script parsers preserve explicit project paths', () => {
    expect(typecheckProjects('bun ../../tools/typecheck.ts tsconfig.json scripts/tsconfig.json')).toEqual([
      'tsconfig.json',
      'scripts/tsconfig.json',
    ])
    expect(typecheckProjects('bun tools/typecheck.ts --workspaces tsconfig.json')).toEqual(['tsconfig.json'])
    expect(typecheckProjects('tsc -p tsconfig.json')).toEqual([])
    expect(JSON.parse(stripJsonc('{"a":"x // text", /* c */ "b":[1,],}'))).toEqual({ a: 'x // text', b: [1] })
  })

  test('every typecheck project gets the Effect plugin block, inherited from tsconfig.base.json', () => {
    const projects = effectProjects()
    expect(projects.length).toBeGreaterThan(nodes.length)
    for (const { dir, tsconfig } of projects) expect(missingPlugin(path.join(dir, tsconfig))).toBeUndefined()
    expect(severities(pluginBlock('apps/runtime/tsconfig.json'))['floatingEffect']).toBeUndefined()
    expect(severities(pluginBlock('apps/runtime/tsconfig.json'))['processEnv']).toBe('error')
  })

  test('runtime zones keep contracts/browser isolated from worker internals', () => {
    expect(placementOf(path.resolve(repoRoot, 'apps/runtime/src/agent.ts'))?.runtime).toBe('cloud')
    expect(placementOf(path.resolve(repoRoot, 'apps/web/src/main.tsx'))?.runtime).toBe('browser')
    expect(placementOf(path.resolve(repoRoot, 'apps/web/test/agent.test.ts'))?.runtime).toBe('test')
    expect(placementOf(path.resolve(repoRoot, 'apps/openui-spike/src/main.tsx'))?.runtime).toBe('browser')
    expect(placementOf(path.resolve(repoRoot, 'apps/openui-spike/alchemy.run.ts'))?.runtime).toBe('tooling')
    expect(placementOf(path.resolve(repoRoot, 'packages/contracts/src/index.ts'))?.runtime).toBe('shared')
    expect(placementOf(path.resolve(repoRoot, 'packages/kit/src/map.tsx'))?.runtime).toBe('browser')
    expect(placementOf(path.resolve(repoRoot, 'apps/cli/src/main.ts'))?.runtime).toBe('daemon')
    expect(nodes.map((node) => node.name)).toEqual([
      '@goblin/openui-spike',
      '@goblin/cli',
      '@goblin/runtime',
      '@goblin/web',
      '@goblin/contracts',
      '@goblin/app',
      '@goblin/kit',
      '@goblin/ui',
      '@goblin/tools',
    ])
  })

  test('global Effect API diagnostics remain configured', () => {
    expect(GLOBAL_API_DIAGNOSTICS.has('processEnv')).toBe(true)
    expect(GLOBAL_API_DIAGNOSTICS.has('nodeBuiltinImport')).toBe(true)
    expect(severities({ diagnosticSeverity: { processEnv: 'error' } })).toEqual({ processEnv: 'error' })
  })
})

describe('the Effect plugin block through extends', () => {
  const owned: string[] = []
  afterEach(() => {
    for (const dir of owned.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** Writes tsconfigs into a fresh directory and answers the path of `name`. */
  const configs = (files: Readonly<Record<string, unknown>>): ((name: string) => string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'goblin-plugin-block-'))
    owned.push(dir)
    for (const [name, config] of Object.entries(files)) writeFileSync(path.join(dir, name), JSON.stringify(config))
    return (name) => path.join(dir, name)
  }
  const block = { compilerOptions: { plugins: [{ name: PLUGIN, diagnosticSeverity: { floatingEffect: 'error' } }] } }

  test('a tsconfig inherits the block from what it extends, with or without .json', () => {
    const at = configs({ 'base.json': block, 'a.json': { extends: './base.json' }, 'b.json': { extends: './a' } })
    expect(severities(pluginBlock(at('b.json')))).toEqual({ floatingEffect: 'error' })
    expect(missingPlugin(at('b.json'))).toBeUndefined()
  })

  test('its own plugins replace the inherited ones, so an empty list turns the block off', () => {
    const at = configs({
      'base.json': block,
      'off.json': { extends: './base.json', compilerOptions: { plugins: [] } },
      'other.json': { extends: './base.json', compilerOptions: { plugins: [{ name: 'other' }] } },
    })
    expect(missingPlugin(at('off.json'))).toContain('does not enable @effect/language-service')
    expect(pluginBlock(at('other.json'))).toBeUndefined()
  })

  test('of several extends, the last one that sets plugins wins', () => {
    const at = configs({
      'base.json': block,
      'off.json': { compilerOptions: { plugins: [] } },
      'none.json': { compilerOptions: { strict: true } },
      'on.json': { extends: ['./off.json', './base.json', './none.json'] },
      'later.json': { extends: ['./base.json', './off.json'] },
    })
    expect(pluginBlock(at('on.json'))).toBeDefined()
    expect(pluginBlock(at('later.json'))).toBeUndefined()
  })

  test('a package tsconfig or a cycle fails the check instead of passing it', () => {
    const at = configs({ 'pkg.json': { extends: '@tsconfig/strictest' }, 'a.json': { extends: './b.json' } })
    writeFileSync(at('b.json'), JSON.stringify({ extends: './a.json' }))
    expect(() => pluginBlock(at('pkg.json'))).toThrow('cannot follow extends')
    expect(() => pluginBlock(at('a.json'))).toThrow('extends itself')
  })
})

const parse = (env: Readonly<Record<string, string>>) => Effect.runSync(CHECKER.parse(ConfigProvider.fromUnknown(env)))

describe('the checker', () => {
  test('effect-tsrs by default, effect-tsgo with EFFECT_CHECKER=tsgo, and nothing else', () => {
    expect(parse({})).toBe('tsrs')
    expect(parse({ EFFECT_CHECKER: 'tsgo' })).toBe('tsgo')
    expect(() => parse({ EFFECT_CHECKER: 'tsc' })).toThrow()
  })

  test('effect-tsrs runs as its native binary; effect-tsgo through its launcher', () => {
    const [tsrs, ...tsrsArgs] = effectArgs('tools/tsconfig.json', 'tsrs')
    expect(tsrs).toMatch(/@yielded\/effect-tsrs-[a-z0-9]+-[a-z0-9]+\/bin\/effect-tsrs$/u)
    expect(tsrsArgs).toEqual(['diagnostics', '-p', path.join(repoRoot, 'tools/tsconfig.json'), '--format', 'json'])
    expect(effectArgs('tools/tsconfig.json', 'tsgo').slice(1)).toEqual([
      'diagnostics',
      '--project',
      path.join(repoRoot, 'tools/tsconfig.json'),
      '--format',
      'json',
    ])
  })
})
