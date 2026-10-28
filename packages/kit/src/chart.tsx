import { mount, register } from 'pele/core'
import pie from 'pele/diagrams/pie'
import xychart from 'pele/diagrams/xychart'
import { type ReactNode, useState } from 'react'
import { type PeleMount, PeleDrawing } from './pele-drawing.tsx'
import { DIAGRAM_OPTIONS } from './pele-options.ts'
import type { ChartSpec } from './specs.ts'

// A chart is only ever an xychart or a pie, so those two renderers are all this chunk carries.
register(xychart, pie)
const mountChart: PeleMount = (element, text, options) => Promise.resolve(mount(element, text, options))

/** A chart's source can be longer than a diagram's (500 rows of five series); Pele still bounds it. */
const CHART_OPTIONS = { ...DIAGRAM_OPTIONS, limit: 100_000 } as const

/** A label in Mermaid's quotes: a quote mark as its entity, whitespace as one space. */
const quoted = (text: string): string => `"${text.replaceAll('"', '#quot;').replaceAll(/\s+/gu, ' ').trim()}"`

/** Plain decimals: Mermaid's chart grammar refuses exponents (`1e-7`). */
const DECIMAL = new Intl.NumberFormat('en-US', { useGrouping: false, maximumFractionDigits: 20 })

/** A cell as a number: a finite number or a numeric string, else 0, since a chart's series has a value at every row. */
function value(cell: string | number | null | undefined): number {
  const number = typeof cell === 'string' ? Number(cell) : (cell ?? 0)
  return Number.isFinite(number) ? number : 0
}

const category = (spec: ChartSpec, row: ChartSpec['data'][number]): string => quoted(String(row[spec.x] ?? ''))

/**
 * The Mermaid source Pele draws a chart spec as (ADR 0130): a pie of the first series' positive values by category,
 * or an xychart of each series as bars or a line, named for the legend, with the unit as the value axis' title.
 */
export function chartSource(spec: ChartSpec): string {
  if (spec.type === 'pie') {
    const key = spec.series[0]?.key ?? ''
    const slices = spec.data.flatMap((row) =>
      value(row[key]) > 0 ? [`  ${category(spec, row)} : ${DECIMAL.format(value(row[key]))}`] : [],
    )
    return ['pie', ...slices].join('\n')
  }
  return [
    'xychart-beta',
    `  x-axis [${spec.data.map((row) => category(spec, row)).join(', ')}]`,
    ...(spec.unit === undefined ? [] : [`  y-axis ${quoted(spec.unit)}`]),
    ...spec.series.map(
      (series) =>
        `  ${spec.type} ${quoted(series.label ?? series.key)} [${spec.data.map((row) => DECIMAL.format(value(row[series.key]))).join(', ')}]`,
    ),
  ].join('\n')
}

/**
 * A chart drawn from a spec by Pele, through the diagrams' allowlist, in goblin's chart colours (`--pele-series-*` in
 * `kit.css`); one Pele does not draw shows `fallback`.
 */
export function Chart({ spec, fallback = null }: { readonly spec: ChartSpec; readonly fallback?: ReactNode }) {
  const source = chartSource(spec)
  const [failed, setFailed] = useState<string>()
  if (failed === source) return fallback
  return (
    <figure className="kit-chart">
      {spec.title !== undefined && <figcaption>{spec.title}</figcaption>}
      <PeleDrawing
        source={source}
        label={spec.title === undefined ? `Chart (${spec.type})` : `Chart: ${spec.title}`}
        className="kit-chart-drawing"
        options={CHART_OPTIONS}
        mount={mountChart}
        onFail={() => setFailed(source)}
      />
    </figure>
  )
}
