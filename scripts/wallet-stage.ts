/**
 * Goblin Wallet's stage loader: `dev` (local), `plan:dev`/`deploy:dev` and `plan:prod`/`deploy:prod` (the latter needs
 * `GOBLIN_CONFIRM_PROD=1`). Each stage reads `.local/wallet-<stage>.env`. scripts/stage.ts stays goblin's own. Like
 * goblin's, dev and prod state live in the account's Cloudflare state store, so a deploy outside CI is break-glass.
 */
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { requireDeployInCi, resolveStage } from './stage-config.ts'

const root = resolve(import.meta.dirname, '..')
const command = Bun.argv[2] ?? 'dev'
const subcommands: Record<string, readonly [alchemy: string, stage: string]> = {
  dev: ['dev', 'local'],
  'plan:dev': ['plan', 'dev'],
  'deploy:dev': ['deploy', 'dev'],
  'plan:prod': ['plan', 'prod'],
  'deploy:prod': ['deploy', 'prod'],
}
const selected = subcommands[command]
if (selected === undefined) throw new Error('unsupported_wallet_stage_command')
const [alchemyCommand, stageName] = selected
if (command === 'deploy:prod' && process.env['GOBLIN_CONFIRM_PROD'] !== '1')
  throw new Error('prod_deploy_requires_confirmation')
if (alchemyCommand === 'deploy' && stageName !== 'local') requireDeployInCi(process.env)

const stage = resolveStage(stageName, 'goblin-wallet')
// Local development runs with the dev stage's values.
const config = resolve(
  process.env['GOBLIN_ENV_DIR'] ?? resolve(root, '.local'),
  `wallet-${stage.local ? 'dev' : stage.name}.env`,
)
const shared = process.env['GOBLIN_CLOUD_ENV_FILE'] ?? resolve(homedir(), '.config/myapps/dev.env')
const requirePrivate = (file: string) => {
  if ((statSync(file).mode & 0o077) !== 0) throw new Error(`private_stage_file_requires_mode_600: ${file}`)
}

const childEnv: Record<string, string | undefined> = { ...process.env }
for (const key of Object.keys(childEnv)) {
  if (/^(CLOUDFLARE_|GOBLIN_|PRIVY_|PIMLICO_|TREASURY_|WALLET_|ALCHEMY_STAGE)/u.test(key)) delete childEnv[key]
}
childEnv['GOBLIN_STAGE'] = stage.name
childEnv['BUN_CONFIG_NO_ENVFILE'] = '1'

requirePrivate(config)
const envFiles = [config]
if (stage.local) {
  childEnv['CLOUDFLARE_ACCOUNT_ID'] = '0'.repeat(32)
  childEnv['CLOUDFLARE_API_TOKEN'] = 'local-placeholder-token'
} else {
  requirePrivate(shared)
  // Cloudflare credentials first, then the wallet's own values, merged into one temporary file.
  const merged = `/tmp/goblin-wallet-${stage.name}-${process.pid}.env`
  writeFileSync(merged, `${readFileSync(shared, 'utf8')}\n${readFileSync(config, 'utf8')}`, { mode: 0o600 })
  process.on('exit', () => {
    if (existsSync(merged)) unlinkSync(merged)
  })
  envFiles.splice(0, envFiles.length, merged)
}

// The Worker serves the SPA build as static assets, so the build comes first.
const build = Bun.spawn(['bun', 'run', 'build'], {
  cwd: resolve(root, 'apps/wallet-web'),
  stdio: ['ignore', 'inherit', 'inherit'],
})
if ((await build.exited) !== 0) throw new Error('wallet_web_build_failed')

const args = [
  resolve(root, 'node_modules/alchemy/bin/alchemy.js'),
  alchemyCommand,
  '--config',
  resolve(root, 'apps/wallet/alchemy.run.ts'),
  '--stage',
  stage.name,
  ...envFiles.flatMap((file) => ['--env-file', file]),
]
if (alchemyCommand === 'deploy') args.push('--yes')
const child = Bun.spawn(['bun', ...args], {
  cwd: resolve(root, 'apps/wallet'),
  env: childEnv,
  stdio: [alchemyCommand === 'plan' ? 'ignore' : 'inherit', 'inherit', 'inherit'],
})
process.exitCode = await child.exited
