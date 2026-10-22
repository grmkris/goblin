import { describe, expect, it } from 'vitest'
import { guardedSource, guardedTest, termViolations } from '../terms.ts'

const RUNTIME = 'apps/runtime/src/example.ts'

describe('retired integration guard', () => {
  it('catches integration names across identifiers, strings and current-source comments', () => {
    for (const text of [
      'const telegramTools = {}',
      'type TelegramRoute = string',
      'TELEGRAM_AUTHOR',
      'mygram_inbox_read',
      'MyGramClient',
      '// The Mercator profile',
      'app_wallet_balance',
      'TempoClient',
      'DODO_API_KEY',
      'USDC',
      'x402',
      'mpp',
      'milliCredits',
      'daily_credits',
      'PlanTier',
      'plan_override',
      'FIRST_CLASS_SERVERS',
      "'https://mysi.lol/mcp'",
      "'https://dev.goblin.surf/c/1'",
    ])
      expect(termViolations(RUNTIME, text), text).not.toEqual([])
  })

  it('keeps ordinary planning, channel, home and temporary wording available', () => {
    const source = 'const plan = home.channel; // temporarily unavailable; plan the next task at home'
    expect(termViolations(RUNTIME, source)).toEqual([])
    expect(termViolations(RUNTIME, 'template; temporary; contemporary; attempt; temperature')).toEqual([])
  })

  it('allows names only in the declared shelf and non-source operator or historical files', () => {
    for (const file of [
      'apps/runtime/src/mcp/servers/shelf.ts',
      'scripts/stage-config.ts',
      'docs/adr/archive/0009-telegram.md',
      'evidence/handoffs/example.md',
    ]) {
      expect(guardedSource(file) || guardedTest(file), file).toBe(false)
      expect(termViolations(file, 'Telegram wallet mygram https://mysi.lol/mcp'), file).toEqual([])
    }
    expect(guardedSource('apps/runtime/src/mcp/servers/shelf-other.ts')).toBe(true)
    expect(guardedSource('packages/app/src/ui/frame.css')).toBe(true)
    expect(guardedSource('apps/web/src/components/example.tsx')).toBe(true)
  })

  it("refuses the names in tests and their fixtures too, but not a deployment's hosts", () => {
    for (const file of [
      'apps/runtime/test/example.test.ts',
      'apps/runtime/test/mcp/events-fixture.ts',
      'apps/web/test/browser/services-fixture.ts',
      'packages/contracts/src/index.test.ts',
      'packages/kit/test/example.test.tsx',
      'apps/web/src/__tests__/example.ts',
    ]) {
      expect(guardedSource(file), file).toBe(false)
      expect(guardedTest(file), file).toBe(true)
      expect(termViolations(file, "const MYGRAM = 'mygram_message_send' // Telegram wallet"), file).toEqual([
        { line: 1, term: 'mygram' },
        { line: 1, term: 'telegram' },
        { line: 1, term: 'wallet' },
      ])
      expect(
        termViolations(file, "const app = 'https://dev.goblin.surf'; const gateway = 'https://mysi.lol/mcp'"),
        file,
      ).toEqual([])
    }
    expect(guardedTest('apps/runtime/test/fixtures/notes.md')).toBe(false)
    expect(guardedTest('scripts/smoke-dev.test.ts')).toBe(false)
  })

  it('reports stable line numbers and deduplicates a repeated term on one line', () => {
    expect(termViolations(RUNTIME, 'const value = 1\n// Telegram telegram\nconst dailyCredits = 0')).toEqual([
      { line: 2, term: 'telegram' },
      { line: 3, term: 'credits' },
    ])
  })
})
