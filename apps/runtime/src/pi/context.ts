import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { ConversationId, EntryId, Harness, SubmissionId } from '@earendil-works/pi-durable'

/** The context every pi-durable call takes: cancellation plus keyed values (chord's `Context`). */
export type PiContext = Parameters<Harness['close']>[0]

/** Chord's background context, for calls made outside a Pi task: no values, never cancelled. */
export const BACKGROUND: PiContext = BACKGROUND_CONTEXT

/**
 * The checkpoint policy of goblin's own Pi documents, which Pi asks every definition for: a whole copy every 32 stored
 * changes, so reading one replays at most 32 deltas.
 */
export const boundedReplay = (_value: unknown, _ops: unknown, info: { readonly deltasSinceBase: number }): boolean =>
  info.deltasSinceBase >= 32

/** A Pi entry id from its number. SAFETY: Pi ids are plain integers at runtime; the brand only types them. */
export const entryId = (id: number): EntryId => id as EntryId

/** A validated submission id. SAFETY: positive safe integer ids are validated by the owner queue codec. */
export const submissionId = (id: number): SubmissionId => id as SubmissionId

/** A Pi conversation id from a session id. SAFETY: PiHarness session ids are Pi's integer ids as strings. */
export const conversationId = (session: string): ConversationId => Number(session) as ConversationId
