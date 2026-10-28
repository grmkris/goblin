import { describe, expect, it } from 'vitest'
import { chartSource } from '../src/chart.tsx'
import { diagramLinks } from '../src/diagram-graph.ts'
import { diagramSvg } from '../src/diagram-render.ts'
import { mapPoints } from '../src/specs.ts'
import { chartSpec, mapSpec } from '../src/index.ts'

describe('chart specs', () => {
  it('read a bar chart with its series and rows', () => {
    const spec = chartSpec(
      JSON.stringify({
        type: 'bar',
        title: 'Sales',
        x: 'month',
        series: [{ key: 'eu', label: 'Europe' }, { key: 'us' }],
        data: [
          { month: 'Jan', eu: 3, us: 4 },
          { month: 'Feb', eu: 5, us: null },
        ],
      }),
    )
    expect(spec?.series.map((series) => series.key)).toEqual(['eu', 'us'])
    expect(spec?.data).toHaveLength(2)
  })
  it('refuse what is not one: bad JSON, an unknown type, no series, too many series or a non-finite value', () => {
    const base = { type: 'line', x: 'day', series: [{ key: 'v' }], data: [{ day: 'Mon', v: 1 }] }
    expect(chartSpec('{"type":')).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, type: 'radar' }))).toBeUndefined()
    // Pele draws charts (ADR 0130): Mermaid's chart grammar has no area or stacked series.
    expect(chartSpec(JSON.stringify({ ...base, type: 'area' }))).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, stacked: true }))?.type).toBe('line')
    expect(chartSpec(JSON.stringify({ ...base, series: [] }))).toBeUndefined()
    expect(
      chartSpec(JSON.stringify({ ...base, series: Array.from({ length: 6 }, (_, n) => ({ key: `s${n}` })) })),
    ).toBeUndefined()
    expect(chartSpec(JSON.stringify({ ...base, data: [{ day: 'Mon', v: { nested: true } }] }))).toBeUndefined()
    expect(chartSpec(`{"pad":"${'x'.repeat(200_001)}"}`)).toBeUndefined()
  })
})

describe('map specs', () => {
  it('read markers and lines and list every point to fit', () => {
    const spec = mapSpec(
      JSON.stringify({
        markers: [{ lat: 46.37, lng: 14.11, label: 'Bled' }],
        lines: [
          {
            points: [
              [46.05, 14.5],
              [46.37, 14.11],
            ],
          },
        ],
      }),
    )
    expect(spec === undefined ? [] : mapPoints(spec)).toEqual([
      [46.37, 14.11],
      [46.05, 14.5],
      [46.37, 14.11],
    ])
  })
  it('refuse an empty map, coordinates off the globe and a fractional zoom', () => {
    expect(mapSpec('{}')).toBeUndefined()
    expect(mapSpec(JSON.stringify({ markers: [{ lat: 91, lng: 0 }] }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [0, 181] }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [46, 14], zoom: 2.5 }))).toBeUndefined()
    expect(mapSpec(JSON.stringify({ center: [46, 14], zoom: 9 }))).toEqual({ center: [46, 14], zoom: 9 })
  })
})

describe('diagrams', () => {
  it('draw every kind Pele knows, themed by its variables, with nothing to fetch or follow', async () => {
    const flow = await diagramSvg('graph LR\n  Draft --> Review --> Ship\n  click Draft "https://example.invalid"')
    expect(flow?.startsWith('<svg')).toBe(true)
    expect(flow).toContain('Review')
    expect(flow).toContain('var(--pele-fg')
    expect(flow).not.toContain('example.invalid')
    expect(flow).not.toContain('<a')
    for (const source of [
      'pie title Pets\n "Dogs" : 40\n "Cats" : 30',
      'gantt\n dateFormat YYYY-MM-DD\n section A\n Task :a1, 2026-01-01, 3d',
      'mindmap\n  root((goblin))\n    Topics',
      'xychart-beta\n x-axis [Jan, Feb]\n y-axis 0 --> 10\n bar [3, 7]',
    ])
      expect((await diagramSvg(source))?.startsWith('<svg')).toBe(true)
  })
  it('give nothing for what is not a diagram it can draw', async () => {
    expect(await diagramSvg('not a diagram at all')).toBeUndefined()
    expect(await diagramSvg('graph LR\n A -->')).toBeUndefined()
    expect(await diagramSvg(`graph LR\n${'  A --> B\n'.repeat(3000)}`)).toBeUndefined()
  })
  it("name a graph's edges by the ids Pele draws them with, and its nodes as drawn", async () => {
    expect(await diagramLinks('graph LR\n A --> B\n B --> C')).toEqual([
      { id: 'L_A_B_0', from: 'A', to: 'B' },
      { id: 'L_B_C_0', from: 'B', to: 'C' },
    ])
    expect(await diagramLinks('stateDiagram-v2\n [*] --> Idle\n Idle --> Running')).toEqual([
      { id: 'edge0', from: 'root_start', to: 'Idle' },
      { id: 'edge1', from: 'Idle', to: 'Running' },
    ])
    expect(await diagramLinks('sequenceDiagram\n A->>B: one\n Note over A: n\n B->>A: two')).toEqual([
      { id: 'i0', from: 'A', to: 'B' },
      { id: 'i2', from: 'B', to: 'A' },
    ])
    expect(await diagramLinks('classDiagram\n Animal <|-- Dog\n Dog --> Bone')).toEqual([
      { id: 'id_Animal_Dog_1', from: 'Animal', to: 'Dog' },
      { id: 'id_Dog_Bone_2', from: 'Dog', to: 'Bone' },
    ])
    expect(await diagramLinks('erDiagram\n PERSON ||--o{ ORDER : places')).toEqual([
      { id: 'id_entity-PERSON-0_entity-ORDER-1_0', from: 'PERSON', to: 'ORDER' },
    ])
    expect(await diagramLinks('pie title Pets\n "Dogs" : 40')).toBeUndefined()
    expect(await diagramLinks('not a diagram at all')).toBeUndefined()
  })
})

describe('charts drawn by Pele', () => {
  const sales = {
    type: 'bar' as const,
    x: 'month',
    unit: 'k€',
    series: [{ key: 'eu', label: 'Europe "EU"' }, { key: 'us' }],
    data: [
      { month: 'Jan, early', eu: 3, us: 4 },
      { month: 'Feb', eu: '5', us: null },
      { month: 'Mar', eu: 0.0000001, us: -2 },
    ],
  }
  it('write a spec as Mermaid: quoted categories and names, the unit on the value axis, plain decimals', () => {
    expect(chartSource(sales)).toBe(
      [
        'xychart-beta',
        '  x-axis ["Jan, early", "Feb", "Mar"]',
        '  y-axis "k€"',
        '  bar "Europe #quot;EU#quot;" [3, 5, 0.0000001]',
        '  bar "us" [4, 0, -2]',
      ].join('\n'),
    )
    expect(chartSource({ ...sales, type: 'pie' })).toBe(
      ['pie', '  "Jan, early" : 3', '  "Feb" : 5', '  "Mar" : 0.0000001'].join('\n'),
    )
  })
  it('draw every kind it writes, named series in a legend', async () => {
    for (const type of ['bar', 'line', 'pie'] as const) {
      const svg = await diagramSvg(chartSource({ ...sales, type }))
      expect(svg?.startsWith('<svg')).toBe(true)
      expect(svg).toContain(type === 'pie' ? 'Jan, early' : 'Europe')
    }
  })
})
