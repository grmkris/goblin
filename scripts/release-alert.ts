/**
 * What a failed release tells the owner (ADR 0128), run by ci.yml's Deploy prod job once a step failed: `bun
 * scripts/release-alert.ts prod`. The job's step summary names the step that failed, the prod commit before this push,
 * and the way back; a Telegram message says the same through a mysi workload allowed mygram's `message_send` to the
 * alerts chat only. Nothing is rolled back. Without the workload the message is skipped, saying why. Neither carries
 * content or a secret: the release's failure record (`scripts/release.py`) holds a step name and a machine reason.
 */
import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Config, Effect, Option, Redacted, Schema } from 'effect'
import { mysiOrigin, openWorkload, workloadMissing } from './smoke-workload.ts'

const Failure = Schema.Struct({
  stage: Schema.String,
  sha: Schema.String,
  step: Schema.String,
  reason: Schema.optional(Schema.String),
})
export type Failure = typeof Failure.Type
const decodeFailure = Schema.decodeUnknownOption(Schema.fromJsonString(Failure))

/** Where the failed run is, and what prod served before its push. */
export type AlertContext = { readonly before: string; readonly run: string }

/** The release's failure record, or what is known when the job failed before the release wrote one. */
export function failureOf(text: string | undefined, stage: string, sha: string): Failure {
  const recorded = text === undefined ? undefined : Option.getOrUndefined(decodeFailure(text))
  return recorded ?? { stage, sha, step: 'before the release (see the job log)' }
}

const short = (sha: string): string => sha.slice(0, 12)
const failedAt = (failure: Failure): string =>
  failure.reason === undefined ? failure.step : `${failure.step} (${failure.reason})`

/** The Telegram message: plain text, one line, no content. */
export function alertText(failure: Failure, context: AlertContext): string {
  return (
    `goblin ${failure.stage} release failed at ${failedAt(failure)}. Commit ${short(failure.sha)}; ` +
    `prod was ${short(context.before)} before. Nothing was rolled back. ${context.run}`
  )
}

/** The job's step summary: the failed step, the commits, and the way back. */
export function stepSummary(failure: Failure, context: AlertContext): string {
  return [
    `### goblin ${failure.stage} release failed`,
    '',
    `- Step: \`${failure.step}\`${failure.reason === undefined ? '' : ` (\`${failure.reason}\`)`}`,
    `- Commit: \`${failure.sha}\``,
    `- Prod before this push: \`${context.before}\``,
    '- Nothing was rolled back (ADR 0128).',
    '',
    'To go back, revert the change on `dev`; once Deploy dev is green, `bun run promote <the revert sha>`. When prod',
    'cannot wait, roll the `goblin-prod` Worker back to its previous version in Cloudflare and follow with the revert',
    "(scripts/README.md, Release operation). Promotion only fast-forwards prod to dev's tip (ADR 0077), so",
    `\`bun run promote ${context.before}\` is refused.`,
    '',
  ].join('\n')
}

/** A message id mygram keeps once per run attempt, so a retried send is the same message. */
export const alertOperationId = (stage: string, run: string, attempt: string): string =>
  `goblin-${stage}-release-${run}-${attempt}`

const optional = (name: string) => Config.String(name).pipe(Config.withDefault(''))

const settings = Config.all({
  logDir: optional('GOBLIN_LOG_DIR'),
  summary: optional('GITHUB_STEP_SUMMARY'),
  sha: optional('GITHUB_SHA'),
  before: optional('GOBLIN_PROD_BEFORE'),
  server: Config.String('GITHUB_SERVER_URL').pipe(Config.withDefault('https://github.com')),
  repository: optional('GITHUB_REPOSITORY'),
  runId: optional('GITHUB_RUN_ID'),
  attempt: Config.String('GITHUB_RUN_ATTEMPT').pipe(Config.withDefault('1')),
  workload: Config.all({
    origin: mysiOrigin,
    clientId: optional('GOBLIN_ALERT_WORKLOAD'),
    requestUrl: optional('ACTIONS_ID_TOKEN_REQUEST_URL'),
    requestToken: Config.Redacted('ACTIONS_ID_TOKEN_REQUEST_TOKEN').pipe(Config.withDefault(Redacted.make(''))),
  }),
})

/** Sends the message, or says why it did not. */
async function sendAlert(config: Config.Success<typeof settings>, stage: string, text: string): Promise<string> {
  const missing = workloadMissing(config.workload)
  if (missing !== undefined) return `skipped: ${missing}`
  const alerts = await openWorkload(config.workload)
  await alerts.call('mygram_message_send', {
    operationId: alertOperationId(stage, config.runId, config.attempt),
    text,
    format: 'text',
  })
  return 'sent'
}

/** Writes the step summary, then sends the message; exits non-zero only when a configured send failed. */
async function alert(stage: string): Promise<void> {
  const config = await Effect.runPromise(settings)
  const record = config.logDir === '' ? undefined : join(config.logDir, 'failure.json')
  // expected: no record means the job failed before the release ran (an install or the credentials)
  const recorded = record === undefined ? undefined : await readFile(record, 'utf8').catch(() => undefined)
  const failure = failureOf(recorded, stage, config.sha)
  const context = { before: config.before, run: `${config.server}/${config.repository}/actions/runs/${config.runId}` }
  if (config.summary !== '') await appendFile(config.summary, stepSummary(failure, context))
  let telegram: string
  try {
    telegram = await sendAlert(config, stage, alertText(failure, context))
  } catch (error) {
    // expected: the workload's errors are content-free (smoke-workload.ts); the job is red already, and says so
    telegram = `failed: ${error instanceof Error ? error.message : 'unknown'}`
    process.exitCode = 1
  }
  if (config.summary !== '') await appendFile(config.summary, `\nTelegram: ${telegram}\n`)
  console.info(`release alert: ${telegram}`)
}

if (import.meta.main) {
  const stage = Bun.argv[2] ?? ''
  if (stage !== 'dev' && stage !== 'prod') throw new Error('stage_required: dev or prod')
  await alert(stage)
}
