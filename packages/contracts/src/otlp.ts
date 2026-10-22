import * as Schema from 'effect/Schema'

/**
 * OpenTelemetry's OTLP/JSON traces data (`ExportTraceServiceRequest`), as Effect's `effect/observability/OtlpTracer`
 * `TraceData` types it: what `inspect_turn` answers for `format=otlp` (ADR 0107), and what any OTLP receiver takes at
 * `/v1/traces`. Byte values are left out: a turn's trace carries none.
 */
export interface OtlpAnyValue {
  readonly stringValue?: string | null | undefined
  readonly boolValue?: boolean | null | undefined
  readonly intValue?: string | number | null | undefined
  readonly doubleValue?: number | null | undefined
  readonly arrayValue?: { readonly values: readonly OtlpAnyValue[] } | undefined
  readonly kvlistValue?: { readonly values: readonly OtlpKeyValue[] } | undefined
}
export interface OtlpKeyValue {
  readonly key: string
  readonly value: OtlpAnyValue
}

export const OtlpAnyValue = Schema.Struct({
  stringValue: Schema.optional(Schema.NullOr(Schema.String)),
  boolValue: Schema.optional(Schema.NullOr(Schema.Boolean)),
  intValue: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  doubleValue: Schema.optional(Schema.NullOr(Schema.Number)),
  arrayValue: Schema.optional(
    Schema.Struct({ values: Schema.Array(Schema.suspend((): Schema.Codec<OtlpAnyValue> => OtlpAnyValue)) }),
  ),
  kvlistValue: Schema.optional(
    Schema.Struct({ values: Schema.Array(Schema.suspend((): Schema.Codec<OtlpKeyValue> => OtlpKeyValue)) }),
  ),
})
export const OtlpKeyValue = Schema.Struct({ key: Schema.String, value: OtlpAnyValue })

const Attributes = Schema.Array(OtlpKeyValue)
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
/** Nanoseconds since the epoch, as a decimal string (OTLP/JSON's 64-bit integers). */
const UnixNano = Schema.String.check(Schema.isPattern(/^\d{1,20}$/u))

/** One span: ids as lowercase hex, its kind (0 unspecified to 5 consumer) and status (0 unset, 1 ok, 2 error). */
export const OtlpSpan = Schema.Struct({
  traceId: Schema.String,
  spanId: Schema.String,
  parentSpanId: Schema.optional(Schema.String),
  name: Schema.String,
  kind: Schema.Int,
  startTimeUnixNano: UnixNano,
  endTimeUnixNano: UnixNano,
  attributes: Attributes,
  droppedAttributesCount: Count,
  events: Schema.Array(
    Schema.Struct({
      attributes: Attributes,
      name: Schema.String,
      timeUnixNano: UnixNano,
      droppedAttributesCount: Count,
    }),
  ),
  droppedEventsCount: Count,
  status: Schema.Struct({ code: Schema.Literals([0, 1, 2]), message: Schema.optional(Schema.String) }),
  links: Schema.Array(
    Schema.Struct({
      attributes: Attributes,
      spanId: Schema.String,
      traceId: Schema.String,
      droppedAttributesCount: Count,
    }),
  ),
  droppedLinksCount: Count,
})

export const OtlpTraceData = Schema.Struct({
  resourceSpans: Schema.Array(
    Schema.Struct({
      resource: Schema.Struct({ attributes: Attributes, droppedAttributesCount: Count }),
      scopeSpans: Schema.Array(
        Schema.Struct({
          scope: Schema.Struct({ name: Schema.String, version: Schema.optional(Schema.String) }),
          spans: Schema.Array(OtlpSpan),
          schemaUrl: Schema.optional(Schema.String),
        }),
      ),
      schemaUrl: Schema.optional(Schema.String),
    }),
  ),
})
export type OtlpTraceData = typeof OtlpTraceData.Type
