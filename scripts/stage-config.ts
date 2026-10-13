/**
 * Workers Logs and Traces (ADR 0024), the same on every stage: every request is kept, because a sampled log would
 * drop exactly the turn someone asks about. Cloudflare keeps both for seven days.
 */
const OBSERVABILITY = {
  enabled: true,
  headSamplingRate: 1,
  logs: { enabled: true, invocationLogs: true, headSamplingRate: 1, persist: true },
  traces: { enabled: true, headSamplingRate: 1, persist: true },
}

/** `app` prefixes every physical name: goblin's are `goblin-<stage>…`, the wallet's `goblin-wallet-<stage>…`. */
export function resolveStage(name: string, app = 'goblin') {
  if (name !== 'local' && name !== 'dev' && name !== 'prod' && !/^test_[a-z0-9_-]+$/u.test(name))
    throw new Error('unsupported_stage')
  return {
    name,
    workerName: `${app}-${name.replaceAll('_', '-')}`,
    resourceName: (role: string) => `${app}-${name.replaceAll('_', '-')}-${role}`,
    local: name === 'local',
    observability: OBSERVABILITY,
  }
}

/**
 * Dev and prod keep their Alchemy state in the shared Cloudflare state store, which has no lock: GitHub Actions deploys
 * each stage through one non-cancelling concurrency group. A deploy or destroy anywhere else is break-glass, and the
 * operator says so with `GOBLIN_BREAK_GLASS=1` (after pausing CI). Plan, drift and smoke stay available anywhere.
 */
export function requireDeployInCi(env: Readonly<Record<string, string | undefined>>): void {
  if (env['GITHUB_ACTIONS'] !== 'true' && env['GOBLIN_BREAK_GLASS'] !== '1')
    throw new Error('deploy_runs_in_ci_or_GOBLIN_BREAK_GLASS=1')
}
