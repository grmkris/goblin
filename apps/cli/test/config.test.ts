import * as ConfigProvider from 'effect/ConfigProvider'
import { describe, expect, it } from 'vitest'
import { UsageError, parseArgs } from '../src/args.ts'
import { settingsOf } from '../src/config.ts'

/** The environment as the settings read it. */
const environment = (env: Record<string, string>) => ConfigProvider.fromEnvRecord(env)

describe('which goblin the CLI talks to (unit)', () => {
  it('needs an origin, from --origin over GOBLIN_ORIGIN, and has no default', async () => {
    await expect(settingsOf(parseArgs(['tools']), environment({}))).rejects.toBeInstanceOf(UsageError)
    await expect(settingsOf(parseArgs(['tools']), environment({ GOBLIN_ORIGIN: ' ' }))).rejects.toBeInstanceOf(
      UsageError,
    )
    const env = environment({ GOBLIN_ORIGIN: 'https://goblin.example/' })
    expect((await settingsOf(parseArgs(['tools']), env)).endpoint.href).toBe('https://goblin.example/mcp')
    const flagged = await settingsOf(parseArgs(['tools', '--origin', 'http://localhost:18971']), env)
    expect(flagged.origin).toBe('http://localhost:18971')
    await expect(settingsOf(parseArgs(['tools', '--origin', 'not a url']), env)).rejects.toBeInstanceOf(UsageError)
  })
})
