import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { detectType, load, parse } from 'pele/lazy'
import { DIAGRAM_OPTIONS } from './diagram-render.ts'

/** One drawn edge: the `data-id` Pele gives its `.pele-edge` and label, and the ids of the two nodes it joins. */
export type DiagramLink = { readonly id: string; readonly from: string; readonly to: string }

const Ends = Schema.Struct({ id: Schema.String, start: Schema.String, end: Schema.String })
const Flowchart = Schema.Struct({ type: Schema.Literal('flowchart'), edges: Schema.Array(Ends) })
const State = Schema.Struct({ type: Schema.Literal('state'), graph: Schema.Struct({ edges: Schema.Array(Ends) }) })
const Sequence = Schema.Struct({
  type: Schema.Literal('sequence'),
  messages: Schema.Array(
    Schema.Struct({ id: Schema.String, from: Schema.optional(Schema.String), to: Schema.optional(Schema.String) }),
  ),
})
const Class = Schema.Struct({
  type: Schema.Literal('class'),
  relations: Schema.Array(Schema.Struct({ id1: Schema.String, id2: Schema.String })),
})
const Er = Schema.Struct({
  type: Schema.Literal('er'),
  entities: Schema.ReadonlyMap(Schema.String, Schema.Struct({ id: Schema.String })),
  relationships: Schema.Array(Schema.Struct({ entityA: Schema.String, entityB: Schema.String })),
})
const Graph = Schema.Union([Flowchart, State, Sequence, Class, Er])
const decodeGraph = Schema.decodeUnknownOption(Graph)

/**
 * How each graph kind's model names its edges, as Pele draws them: flowchart and state edges carry their own ids,
 * sequence messages are `i<id>`, class and ER relations are numbered in order. ER relations name entities by their
 * internal id, which the drawing's nodes do not use, so they are named back.
 */
function linksOf(graph: typeof Graph.Type): readonly DiagramLink[] {
  switch (graph.type) {
    case 'flowchart':
      return graph.edges.map(({ id, start, end }) => ({ id, from: start, to: end }))
    case 'state':
      return graph.graph.edges.map(({ id, start, end }) => ({ id, from: start, to: end }))
    case 'sequence':
      return graph.messages.flatMap(({ id, from, to }) =>
        from === undefined || to === undefined || from === to ? [] : [{ id: `i${id}`, from, to }],
      )
    case 'class':
      return graph.relations.map(({ id1, id2 }, index) => ({ id: `id_${id1}_${id2}_${index + 1}`, from: id1, to: id2 }))
    case 'er': {
      const names = new Map([...graph.entities].map(([name, entity]) => [entity.id, name]))
      return graph.relationships.map(({ entityA, entityB }, index) => ({
        id: `id_${entityA}_${entityB}_${index}`,
        from: names.get(entityA) ?? entityA,
        to: names.get(entityB) ?? entityB,
      }))
    }
  }
}

/**
 * The edges of a graph diagram (flowchart, state, sequence, class, ER) from Pele's model, for the explorer's
 * neighbours; nothing for any other kind, whose nodes are not selectable, or for a model whose shape this does not
 * know.
 */
export async function diagramLinks(source: string): Promise<readonly DiagramLink[] | undefined> {
  try {
    if (!(await load(detectType(source)))) return undefined
    return Option.getOrUndefined(Option.map(decodeGraph(parse(source, DIAGRAM_OPTIONS)), linksOf))
  } catch {
    // expected: a source that does not parse has no drawing to explore either
    return undefined
  }
}
