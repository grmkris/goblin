import { RunAttribute, type RunAttributes } from '@goblin/contracts/telemetry'
import { Predicate } from 'effect'
import { safeErrorType } from '../observability/report.ts'
import { failureSummary, safeFailureCode } from './safety.ts'

/** The parts of a model response telemetry reads; pi-ai's `AssistantMessage` has them. */
export type Answer = {
  readonly provider: string
  readonly model: string
  readonly responseModel?: string | undefined
  readonly responseId?: string | undefined
  readonly stopReason: string
  readonly errorMessage?: string | undefined
  readonly emptyAnswer?: boolean | undefined
  readonly diagnostics?: readonly { readonly type: string }[] | undefined
  readonly usage: {
    readonly input: number
    readonly output: number
    readonly cacheRead: number
    readonly cacheWrite: number
    readonly reasoning?: number | undefined
  }
}

/** Whether goblin's model streams marked `message` with diagnostic `type` (`pi/model.ts`, ADR 0083). */
const noted = (message: Answer, type: string): boolean =>
  message.diagnostics?.some((diagnostic) => diagnostic.type === type) === true

/** What a response tells about its model call: model, finish reason, tokens, error. Never its content. */
export function answerAttributes(message: Answer): RunAttributes {
  const failure = 'provider_error'
  const { usage } = message
  return {
    [RunAttribute.provider]: message.provider,
    [RunAttribute.requestModel]: message.model,
    ...(message.responseModel === undefined ? {} : { [RunAttribute.responseModel]: message.responseModel }),
    ...(message.responseId === undefined ? {} : { [RunAttribute.responseId]: message.responseId }),
    [RunAttribute.finishReason]: message.stopReason,
    [RunAttribute.inputTokens]: usage.input,
    [RunAttribute.outputTokens]: usage.output,
    [RunAttribute.cacheReadTokens]: usage.cacheRead,
    [RunAttribute.cacheWriteTokens]: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { [RunAttribute.reasoningTokens]: usage.reasoning }),
    ...(message.errorMessage === undefined && message.stopReason !== 'error'
      ? {}
      : { [RunAttribute.errorType]: failure, [RunAttribute.error]: failure }),
    ...(message.stopReason === 'length' || noted(message, RunAttribute.cutoff) ? { [RunAttribute.cutoff]: true } : {}),
    ...(noted(message, RunAttribute.recovered) ? { [RunAttribute.recovered]: true } : {}),
    ...(message.emptyAnswer === true || noted(message, RunAttribute.emptyAnswer)
      ? { [RunAttribute.emptyAnswer]: true }
      : {}),
  }
}

/** Stop reasons that are not a failure of the call. */
export const statusOfStop = (stop: string): 'ok' | 'error' | 'interrupted' => {
  if (stop === 'error') return 'error'
  return stop === 'aborted' ? 'interrupted' : 'ok'
}

const MAX_ERROR = 300
const OWN_TEXT = new Set(['_tag', 'name', 'message', 'stack', 'cause'])
/** The field that holds a server's own words (`UpstreamMcp`), bounded where it is kept: shown whole, as theirs. */
const SAID = 'serverMessage'

/** A tagged failure's scalar fields (`reason: timeout`), the part of it that says what went wrong. */
const fieldsOf = (error: object): string[] =>
  Object.entries(error).flatMap(([key, field]) =>
    !OWN_TEXT.has(key) &&
    key !== SAID &&
    (Predicate.isString(field) || Predicate.isNumber(field) || Predicate.isBoolean(field))
      ? [`${key}: ${String(field).slice(0, 80)}`]
      : [],
  )

/** What a server said of a failure, when it said something. */
const saidOf = (error: unknown): string | undefined =>
  Predicate.isObject(error) && SAID in error && Predicate.isString(error[SAID]) && error[SAID] !== ''
    ? error[SAID]
    : undefined

function describeOne(error: unknown): string {
  if (Predicate.isString(error)) return error
  if (!Predicate.isObject(error)) return String(error)
  const tag = '_tag' in error && Predicate.isString(error._tag) ? error._tag : undefined
  const name = tag ?? (error instanceof Error && error.name !== 'Error' ? error.name : undefined)
  const fields = tag === undefined ? [] : fieldsOf(error)
  const head = fields.length === 0 ? name : `${name ?? 'error'} (${fields.join(', ')})`
  const message = 'message' in error && Predicate.isString(error.message) ? error.message : ''
  return [head, message].filter((part) => part !== undefined && part !== '').join(': ') || 'error without a message'
}

/**
 * A private tool failure as one bounded line, for Pi and conversation inspection: its tag or name, a tagged failure's
 * scalar fields, its message, then its causes. Never `[object Object]`. What a server said of it (`serverMessage`,
 * ADR 0092) follows whole, quoted as the server's words. Remote error text stays data (ADR 0024).
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  let said: string | undefined
  let current = error
  for (let depth = 0; depth < 4 && current !== undefined; depth += 1) {
    parts.push(describeOne(current))
    said ??= saidOf(current)
    current = Predicate.isObject(current) && 'cause' in current ? current.cause : undefined
  }
  const line = parts.join(', caused by ').slice(0, MAX_ERROR)
  return said === undefined ? line : `${line}: the server says: ${JSON.stringify(said)}`
}

/**
 * A failure's telemetry code: its type (`safeErrorType`) when telemetry has a summary for it, an `UpstreamMcp` failure
 * with its finite reason, arguments that do not fit a tool's schema `invalid_arguments`, anything else `error`. Never
 * its message, fields, stack or cause.
 */
export function outcomeOf(error: unknown): string {
  const type = safeErrorType(error)
  const reason = type === 'UpstreamMcp' && Predicate.isObject(error) && 'reason' in error ? error.reason : undefined
  const upstream = Predicate.isString(reason) ? safeFailureCode(`${type}:${reason}`) : 'error'
  if (upstream !== 'error') return upstream
  return safeFailureCode(type === 'InvalidArguments' ? 'invalid_arguments' : type)
}

/** Full private error descriptions above are for tool results; these fixed summaries alone enter telemetry. */
export const failureAttributes = (error: unknown): RunAttributes => ({
  [RunAttribute.errorType]: outcomeOf(error),
  [RunAttribute.error]: failureSummary(outcomeOf(error)),
})
