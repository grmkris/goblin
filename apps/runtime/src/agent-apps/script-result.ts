import * as Schema from 'effect/Schema'

/** What code_run returns from either backend. */
export const ScriptResult = Schema.Struct({
  ok: Schema.Boolean,
  value: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
  logs: Schema.Array(Schema.String),
})
export type ScriptResult = typeof ScriptResult.Type
