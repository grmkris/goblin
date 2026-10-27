import { describe, expect, it } from 'vitest'
import { alertOperationId, alertText, failureOf, stepSummary } from '../../scripts/release-alert.ts'

const SHA = 'a'.repeat(40)
const BEFORE = 'b'.repeat(40)
const context = { before: BEFORE, run: 'https://github.com/owner/repo/actions/runs/7' }

describe('a failed release (ADR 0128)', () => {
  const failure = failureOf(
    JSON.stringify({ stage: 'prod', sha: SHA, step: 'smoke', reason: 'turn_not_pong' }),
    'prod',
    SHA,
  )

  it("reads the release's failure record, or says the job failed before the release ran", () => {
    expect(failure).toEqual({ stage: 'prod', sha: SHA, step: 'smoke', reason: 'turn_not_pong' })
    expect(failureOf(undefined, 'prod', SHA)).toEqual({
      stage: 'prod',
      sha: SHA,
      step: 'before the release (see the job log)',
    })
    expect(failureOf('not json', 'prod', SHA).step).toBe('before the release (see the job log)')
  })

  it('tells Telegram the step, the commits and the run, and that nothing was rolled back', () => {
    expect(alertText(failure, context)).toBe(
      'goblin prod release failed at smoke (turn_not_pong). Commit aaaaaaaaaaaa; prod was bbbbbbbbbbbb before. ' +
        'Nothing was rolled back. https://github.com/owner/repo/actions/runs/7',
    )
  })

  it('names the failed step and prod before the push in the step summary, with a way back that works', () => {
    const summary = stepSummary(failure, context)
    expect(summary).toContain('- Step: `smoke` (`turn_not_pong`)')
    expect(summary).toContain(`- Prod before this push: \`${BEFORE}\``)
    expect(summary).toContain('`bun run promote <the revert sha>`')
    expect(summary).toContain(`\`bun run promote ${BEFORE}\` is refused`)
    expect(summary).toContain('roll the `goblin-prod` Worker back')
  })

  it('sends one message per run attempt', () => {
    expect(alertOperationId('prod', '123', '2')).toBe('goblin-prod-release-123-2')
    expect(alertOperationId('prod', '123', '2')).toMatch(/^[\w.:-]{8,128}$/u)
  })
})
