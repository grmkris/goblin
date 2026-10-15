import { describe, expect, it } from 'vitest'
import { guardedSource, termViolations } from '../terms.ts'

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

  it('allows names only in the declared shelf, tests and non-source operator or historical files', () => {
    for (const file of [
      'apps/runtime/src/mcp/servers/shelf.ts',
      'apps/runtime/test/example.test.ts',
      'packages/contracts/src/index.test.ts',
      'apps/web/src/__tests__/example.ts',
      'scripts/stage-config.ts',
      'docs/adr/archive/0009-telegram.md',
      'evidence/handoffs/example.md',
    ]) {
      expect(guardedSource(file), file).toBe(false)
      expect(termViolations(file, 'Telegram wallet mygram https://mysi.lol/mcp'), file).toEqual([])
    }
    expect(guardedSource('apps/runtime/src/mcp/servers/shelf-other.ts')).toBe(true)
    expect(guardedSource('packages/app/src/ui/frame.css')).toBe(true)
    expect(guardedSource('apps/web/src/components/example.tsx')).toBe(true)
  })

  it('reports stable line numbers and deduplicates a repeated term on one line', () => {
    expect(termViolations(RUNTIME, 'const value = 1\n// Telegram telegram\nconst dailyCredits = 0')).toEqual([
      { line: 2, term: 'telegram' },
      { line: 3, term: 'credits' },
    ])
  })
})
