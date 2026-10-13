import { describe, expect, it } from 'vitest'
import { requireDeployInCi } from '../../scripts/stage-config.ts'

describe('the break-glass guard on dev and prod deploys', () => {
  it('lets GitHub Actions deploy, and an operator who says GOBLIN_BREAK_GLASS=1', () => {
    requireDeployInCi({ GITHUB_ACTIONS: 'true' })
    requireDeployInCi({ GOBLIN_BREAK_GLASS: '1' })
  })
  it('refuses a deploy from anywhere else, CI=true included', () => {
    for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: '1' }, { GOBLIN_BREAK_GLASS: 'true' }])
      expect(() => requireDeployInCi(env)).toThrow('deploy_runs_in_ci_or_GOBLIN_BREAK_GLASS=1')
  })
})
