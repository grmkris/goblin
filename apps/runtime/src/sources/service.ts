import type {
  SourcePage,
  SourceProposal,
  SourceRoutePick,
  SourceRouteView,
  SourceRoutes,
  SourceView,
} from '@goblin/contracts'
import * as Context from 'effect/Context'
import type * as Effect from 'effect/Effect'
import type { AppError } from '../http/errors.ts'
import type { RouteProvenance } from './program.ts'

/**
 * The owner's Sources (ADR 0066): MCP connections whose events carry the owner's own messages into goblin and its
 * answers back, each by a setup the owner confirmed at an exact revision. Built once, after the routines
 * (`layers/sources.ts`), which registers the Sources' handler with Events before the agent runs anything.
 */
export class Sources extends Context.Service<
  Sources,
  {
    /** Every Source, the newest first, with the conversations waiting for a route. */
    readonly list: Effect.Effect<SourcePage, AppError>
    /** A Source and every conversation it has seen. */
    readonly routes: (id: string) => Effect.Effect<SourceRoutes, AppError>
    /** A proposal (the agent's `source_propose`, ADR 0068); the same operation finds the same one. */
    readonly propose: (
      proposal: SourceProposal,
      by: { readonly actor: 'owner' | 'agent'; readonly chat?: string },
    ) => Effect.Effect<SourceView, AppError>
    /** The owner confirms the exact revision: its event and tools are granted, it is subscribed and bound. */
    readonly confirm: (id: string, revision: number) => Effect.Effect<SourceView, AppError>
    /** The owner refuses the exact revision. */
    readonly refuse: (id: string, revision: number) => Effect.Effect<SourceView, AppError>
    /** Sets where one conversation goes and delivers what it held, with an organizing receipt; the route after. */
    readonly route: (
      id: string,
      pick: SourceRoutePick,
      by: RouteProvenance,
    ) => Effect.Effect<{ readonly view: SourceRouteView; readonly summary: string }, AppError>
    /** Undoes a `source.route` receipt: the route goes back to what it was before, with no delivery. */
    readonly undo: (receipt: {
      readonly target: string
      readonly before: unknown
      readonly afterRevision: number
    }) => Effect.Effect<void, AppError>
    readonly pause: (id: string) => Effect.Effect<SourceView, AppError>
    /** Binds it again to the connection's endpoint and grants as they are now. */
    readonly resume: (id: string) => Effect.Effect<SourceView, AppError>
    /** Ends its subscription and forgets it, its routes, what it held and the answers it owed. */
    readonly remove: (id: string) => Effect.Effect<null, AppError>
    /** The Sources' alarm: each Source tended and the answers due sent; the seconds until the next, none when idle. */
    readonly wake: Effect.Effect<number | undefined, AppError>
  }
>()('goblin/sources/Sources') {}
