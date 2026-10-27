import * as Effect from 'effect/Effect'
import * as Match from 'effect/Match'
import * as Predicate from 'effect/Predicate'
import * as Schema from 'effect/Schema'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as SchemaParser from 'effect/SchemaParser'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import * as HttpApiSchema from 'effect/http-api/HttpApiSchema'
import { Missing, widenUrl } from '../grants.ts'

/**
 * The reference a typed API answer quotes for its failure (the request's cf-ray), so the owner can name it and an
 * operator can find it in the logs. Only the HTTP API stamps it; Durable Object RPC never sets it, so the encoded shape
 * RPC carries is unchanged.
 */
const ref = Schema.optionalKey(Schema.String)

/**
 * The runtime's failure vocabulary. The owner API answers each one in the error envelope below; Durable Object RPC
 * carries them encoded because Workers RPC does not preserve error classes.
 */
/** `retryAfter`: for a credential over its rate limit, the seconds until it may call again (ADRs 0085, 0120). */
export class Unauthenticated extends Schema.TaggedError<Unauthenticated>()('Unauthenticated', {
  reason: Schema.String,
  retryAfter: Schema.optionalKey(Schema.Number),
  ref,
}) {}
export class Forbidden extends Schema.TaggedError<Forbidden>()('Forbidden', { reason: Schema.String, ref }) {}
/**
 * A credential's grant does not cover the call (myapps ADR 0015): `missing` is what it lacks (a level, an extra, a
 * reach item as `<workspace>/<kind>/<id>`, or creating something) and `widenUrl` the page where the owner can allow
 * it. Its copy is fixed; what is missing travels only in these fields. `Forbidden` stays for a person's role, a
 * boundary and a credential that may never call.
 */
export class AccessInsufficient extends Schema.TaggedError<AccessInsufficient>()('AccessInsufficient', {
  missing: Missing,
  widenUrl: Schema.String,
  ref,
}) {}
export class GrantDenied extends Schema.TaggedError<GrantDenied>()('GrantDenied', {
  connectionId: Schema.String,
  name: Schema.String,
  ref,
}) {}
export class NotFound extends Schema.TaggedError<NotFound>()('NotFound', { what: Schema.String, ref }) {}
export class Conflict extends Schema.TaggedError<Conflict>()('Conflict', { reason: Schema.String, ref }) {}
export class InvalidInput extends Schema.TaggedError<InvalidInput>()('InvalidInput', { reason: Schema.String, ref }) {}
/**
 * A tool call whose arguments do not fit the remote tool's input schema, refused before it is sent (ADR 0092): `name`
 * is the tool, `problems` what is wrong, each `<path>: <problem>` on one bounded line.
 */
export class InvalidArguments extends Schema.TaggedError<InvalidArguments>()('InvalidArguments', {
  connectionId: Schema.String,
  name: Schema.String,
  problems: Schema.Array(Schema.String),
  ref,
}) {}
export class PayloadTooLarge extends Schema.TaggedError<PayloadTooLarge>()('PayloadTooLarge', {
  limit: Schema.Number,
  ref,
}) {}
export class ResidentInactive extends Schema.TaggedError<ResidentInactive>()('ResidentInactive', {
  state: Schema.String,
  ref,
}) {}
export class BudgetExhausted extends Schema.TaggedError<BudgetExhausted>()('BudgetExhausted', {
  limit: Schema.Number,
  resetsAt: Schema.Number,
  ref,
}) {}
/**
 * A model call with nowhere to go (ADR 0064): the deployment has no model endpoint of its own and the owner has not
 * brought theirs yet.
 */
export class NoModelEndpoint extends Schema.TaggedError<NoModelEndpoint>()('NoModelEndpoint', { ref }) {}
export class NeedsAuthorization extends Schema.TaggedError<NeedsAuthorization>()('NeedsAuthorization', {
  connectionId: Schema.String,
  ref,
}) {}
/**
 * A call needs a permission the connection's sign-in was not granted (an MCP server's 403 `insufficient_scope`,
 * ADR 0042): the owner signs it in again with more access. `scope` is what the server says is needed, as scope tokens.
 */
export class ScopeRequired extends Schema.TaggedError<ScopeRequired>()('ScopeRequired', {
  connectionId: Schema.String,
  scope: Schema.String,
  ref,
}) {}
export const UpstreamReason = Schema.Literals([
  'unauthorized',
  'remote-rpc',
  'transport',
  'timeout',
  'cancelled',
  'unsupported',
  'content-limit',
])
/**
 * `code` is the remote server's JSON-RPC error code; `serverMessage` its message, one bounded line in the server's own
 * words (ADR 0092), which the model reads as the server's and which never crosses the API's envelope or enters telemetry.
 */
export class UpstreamMcp extends Schema.TaggedError<UpstreamMcp>()('UpstreamMcp', {
  connectionId: Schema.String,
  reason: UpstreamReason,
  code: Schema.optional(Schema.Number),
  serverMessage: Schema.optional(Schema.String),
  ref,
}) {}
export class Internal extends Schema.TaggedError<Internal>()('Internal', { reason: Schema.String, ref }) {}

export const AppError = Schema.Union([
  Unauthenticated,
  Forbidden,
  AccessInsufficient,
  GrantDenied,
  NotFound,
  Conflict,
  InvalidInput,
  InvalidArguments,
  PayloadTooLarge,
  ResidentInactive,
  BudgetExhausted,
  NoModelEndpoint,
  NeedsAuthorization,
  ScopeRequired,
  UpstreamMcp,
  Internal,
])
export type AppError = typeof AppError.Type
export type AppErrorTag = AppError['_tag']

/**
 * Each failure's public face on the wire besides its `code` (`codeOf`): a fixed `message` that never carries runtime
 * text, and what to do next when there is something to do.
 */
export const ERROR_COPY = {
  Unauthenticated: { message: 'Your session has ended.', recovery: 'Sign in again.' },
  Forbidden: { message: 'This request is not allowed.' },
  AccessInsufficient: {
    message: 'This credential needs more access.',
    recovery: 'The owner can allow it at the widening link.',
  },
  GrantDenied: { message: 'That tool is not enabled.', recovery: 'Turn it on under Connections.' },
  NotFound: { message: 'That does not exist.' },
  Conflict: { message: 'That clashes with something that is already there.', recovery: 'Refresh and try again.' },
  InvalidInput: { message: 'The request was not valid.' },
  InvalidArguments: {
    message: "The arguments do not match the tool's input schema.",
    recovery: 'Fix them and call again.',
  },
  PayloadTooLarge: { message: 'That is too large.' },
  ResidentInactive: { message: 'Resident authority is off.', recovery: 'Re-enable it in Settings.' },
  BudgetExhausted: { message: "You have used today's model budget.", recovery: 'It resets at 00:00 UTC.' },
  NoModelEndpoint: {
    message: 'This deployment has no model endpoint.',
    recovery: 'Bring your own model key in Settings.',
  },
  NeedsAuthorization: { message: 'This server needs to be connected again.' },
  ScopeRequired: {
    message: 'This connection needs more access.',
    recovery: 'Sign in to it again with more access.',
  },
  UpstreamMcp: { message: 'The MCP server did not respond as expected.' },
  Internal: { message: 'Something went wrong on our side.', recovery: 'Try again.' },
} as const satisfies Record<AppErrorTag, { readonly message: string; readonly recovery?: string }>

/** What an `UpstreamMcp` says when the server was not reached at all (a network failure, a timeout): try again. */
const UNREACHED_COPY = { message: 'The MCP server could not be reached. Try again in a minute.' } as const
const unreached = (error: AppError | typeof AppError.Encoded): boolean =>
  Predicate.isTagged(error, 'UpstreamMcp') && (error.reason === 'transport' || error.reason === 'timeout')

/** `Tag` in lower_snake_case, as `codeOf` spells it; any string for a tag the type does not know. */
type SnakeCase<Tag extends string, Done extends string = ''> = string extends Tag
  ? string
  : Tag extends `${infer Head}${infer Rest}`
    ? SnakeCase<
        Rest,
        `${Done}${Head extends Lowercase<Head> ? Head : `${Done extends '' ? '' : '_'}${Lowercase<Head>}`}`
      >
    : Done

/** A failure's wire code: its tag in lower_snake_case (`NotFound` is `not_found`). */
export type ApiCode = SnakeCase<AppErrorTag>

/** The HTTP status of each failure, wherever the agent or the Worker answers one. */
export const statusOf = (error: AppError | typeof AppError.Encoded): number =>
  Match.value(error).pipe(
    Match.tagsExhaustive({
      Unauthenticated: () => 401,
      Forbidden: () => 403,
      AccessInsufficient: () => 403,
      GrantDenied: () => 403,
      NotFound: () => 404,
      Conflict: () => 409,
      InvalidInput: () => 400,
      InvalidArguments: () => 400,
      PayloadTooLarge: () => 413,
      ResidentInactive: () => 409,
      BudgetExhausted: () => 429,
      NoModelEndpoint: () => 409,
      NeedsAuthorization: () => 409,
      ScopeRequired: () => 403,
      UpstreamMcp: (upstream) => (upstream.reason === 'timeout' ? 504 : 502),
      Internal: () => 500,
    }),
  )

/**
 * The safe detail fields the classes carry, as they cross the wire. UpstreamMcp's numeric `code` (the remote server's
 * JSON-RPC code) crosses as `rpcCode`, because `code` is the envelope's own; its `serverMessage` stays behind (`toWire`),
 * so a caller never reads a remote server's words, while `problems` (InvalidArguments) are goblin's account of the
 * caller's own arguments, and `missing` and `widenUrl` (AccessInsufficient) what the caller's own grant lacks.
 */
const DETAIL_FIELDS = {
  recovery: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  what: Schema.optionalKey(Schema.String),
  connectionId: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  resetsAt: Schema.optionalKey(Schema.Number),
  retryAfter: Schema.optionalKey(Schema.Number),
  rpcCode: Schema.optionalKey(Schema.Number),
  scope: Schema.optionalKey(Schema.String),
  problems: Schema.optionalKey(Schema.Array(Schema.String)),
  missing: Schema.optionalKey(Missing),
  widenUrl: Schema.optionalKey(Schema.String),
  ref,
}

/** Any failure body the API answers: `{ error: { code, message, recovery?, …safe fields, ref? } }`. */
export const ErrorEnvelope = Schema.Struct({
  error: Schema.Struct({ code: Schema.String, message: Schema.String, ...DETAIL_FIELDS }),
})
export type ErrorEnvelope = typeof ErrorEnvelope.Type

/** A tag's wire code: the tag in lower_snake_case (`NotFound` is `not_found`). */
export const codeOf = <const Tag extends string>(tag: Tag): SnakeCase<Tag> =>
  // SAFETY: an underscore before each capital but the first, then lower case, is what `SnakeCase` spells.
  tag.replaceAll(/(?<=.)(?=[A-Z])/gu, '_').toLowerCase() as SnakeCase<Tag>
const TAG_OF_CODE: ReadonlyMap<string, string> = new Map(Object.keys(ERROR_COPY).map((tag) => [codeOf(tag), tag]))

/**
 * A failure's fixed copy, as the API answers it and the web shows it: its tag's, or, for an MCP server that was not
 * reached, that it was not.
 */
export const failureCopy = (
  error: AppError | typeof AppError.Encoded,
): { readonly message: string; readonly recovery?: string } =>
  unreached(error) ? UNREACHED_COPY : ERROR_COPY[error._tag]

/** The envelope body of an encoded failure: its code and fixed copy, then its own safe fields, never a server's words. */
const toWire = (encoded: typeof AppError.Encoded): ErrorEnvelope => {
  const { _tag, ...fields } = encoded
  const rpc = Predicate.hasProperty(fields, 'code') && Predicate.isNumber(fields.code) ? { rpcCode: fields.code } : {}
  const { serverMessage: _server, ...safe } =
    'serverMessage' in fields ? fields : { ...fields, serverMessage: undefined }
  return { error: { ...safe, ...rpc, code: codeOf(_tag), ...failureCopy(encoded) } }
}

/** The class's encoded form from a wire detail; the target schema validates it right after. */
const fromWire = ({ code, message: _message, recovery: _recovery, rpcCode, ...fields }: ErrorEnvelope['error']) => ({
  ...fields,
  _tag: TAG_OF_CODE.get(code),
  ...(rpcCode === undefined ? {} : { code: rpcCode }),
})

/**
 * The envelope of the failures one HTTP status answers (myapps' `envelope`): `{ error: { code, message, … } }` on the
 * wire, `target` on either side. `toWire` is the body of a value this status answers and `undefined` for one another
 * status answers, so a union of envelopes picks the right one; `fromWire` is the target's encoded form of a body,
 * which the target validates right after.
 */
export const statusEnvelope = <Target extends Schema.Codec<unknown, unknown>>(
  status: number,
  identifier: string,
  codes: readonly string[],
  target: Target,
  wire: {
    readonly toWire: (encoded: Target['Encoded']) => ErrorEnvelope | undefined
    readonly fromWire: (detail: ErrorEnvelope['error']) => unknown
  },
) => {
  const Wire = Schema.Struct({
    error: Schema.Struct({ code: Schema.Literals(codes), message: Schema.String, ...DETAIL_FIELDS }),
  }).annotate({ identifier })
  const decodeTarget = SchemaParser.decodeUnknownEffect(Schema.toEncoded(target))
  return Wire.pipe(
    Schema.decodeTo(
      target,
      SchemaTransformation.transformEffect({
        decode: ({ error }) => decodeTarget(wire.fromWire(error)),
        encode: (encoded, options) => {
          const body = wire.toWire(encoded)
          return body === undefined
            ? Effect.fail(new SchemaIssue.InvalidValue({ message: `Not a ${status} failure.` }, encoded, options))
            : Effect.succeed(body)
        },
      }),
    ),
    HttpApiSchema.status(status),
  )
}

type AppErrorClass = (typeof AppError.members)[number]

/** The envelope of the `AppError`s `status` answers: it encodes only a failure whose `statusOf` is `status`. */
const envelope = <const Members extends readonly [AppErrorClass, ...AppErrorClass[]]>(
  status: number,
  members: Members,
) =>
  statusEnvelope(
    status,
    `GoblinError${status}`,
    members.map((member) => codeOf(member.identifier)),
    Schema.Union(members),
    { toWire: (encoded) => (statusOf(encoded) === status ? toWire(encoded) : undefined), fromWire },
  )

/** One envelope per status the API answers a failure with. */
export const ApiErrors = {
  invalidInput: envelope(400, [InvalidInput, InvalidArguments]),
  unauthenticated: envelope(401, [Unauthenticated]),
  forbidden: envelope(403, [Forbidden, AccessInsufficient, GrantDenied, ScopeRequired]),
  notFound: envelope(404, [NotFound]),
  conflict: envelope(409, [Conflict, ResidentInactive, NeedsAuthorization, NoModelEndpoint]),
  payloadTooLarge: envelope(413, [PayloadTooLarge]),
  budgetExhausted: envelope(429, [BudgetExhausted]),
  internal: envelope(500, [Internal]),
  upstream: envelope(502, [UpstreamMcp]),
  upstreamTimeout: envelope(504, [UpstreamMcp]),
}

/** Every envelope: owner admission's error schema, so any owner endpoint can answer any `AppError`. */
export const API_ERRORS = [
  ApiErrors.invalidInput,
  ApiErrors.unauthenticated,
  ApiErrors.forbidden,
  ApiErrors.notFound,
  ApiErrors.conflict,
  ApiErrors.payloadTooLarge,
  ApiErrors.budgetExhausted,
  ApiErrors.internal,
  ApiErrors.upstream,
  ApiErrors.upstreamTimeout,
] as const

/**
 * The refusal of a call that grant `grantId` does not cover, linking to the widening page under `appUrl` (trusted
 * configuration) that asks for `missing`.
 */
export const accessInsufficient = (appUrl: string, grantId: string, missing: Missing): AccessInsufficient =>
  new AccessInsufficient({ missing, widenUrl: widenUrl(appUrl, grantId, missing) })

/** The envelope body of `error`, for a failure answered outside HttpApi's own encoding. */
export const envelopeOf = (error: AppError): ErrorEnvelope => toWire(Schema.encodeSync(AppError)(error))

/** `error` carrying the reference the API answers it under. */
export const withRef =
  (reference: string) =>
  (error: AppError): Effect.Effect<AppError> =>
    Schema.encodeEffect(AppError)(error).pipe(
      Effect.flatMap((encoded) => Schema.decodeEffect(AppError)({ ...encoded, ref: reference })),
      Effect.orDie,
    )
