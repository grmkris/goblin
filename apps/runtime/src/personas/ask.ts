import type { TextContent } from '@earendil-works/pi-ai'
import { type PersonaAskData, type PersonaRevisionView, type PersonaSetup, authorOf } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { useRoomTools } from '../agent-model.ts'
import { epochSeconds } from '../clock.ts'
import { ChatOperations, Chats, Conversations } from '../chats/service.ts'
import { InvalidInput, NotFound, attempt, attemptSync, toAppError } from '../http/errors.ts'
import { requestKey } from '../keys/policy.ts'
import { roomOf } from '../keys/reach.ts'
import { conversationId } from '../pi/context.ts'
import { PiSessions } from '../pi/sessions.ts'
import type { FrozenPersona } from '../pi/persona-turn.ts'
import { Db } from '../runtime/db.ts'
import { AgentInput } from '../runtime/input.ts'
import { Invocations, Personas } from './service.ts'

/**
 * The owner's content with the Personas it went to named in front, as the model of the chat reads it. A message from
 * elsewhere (Source) keeps its author's block first; the words after it are addressed.
 */
export function addressedTo(names: readonly string[], content: string | TextContent[]): string | TextContent[] {
  const tag = `[to ${names.map((name) => `@${name}`).join(', ')}] `
  if (typeof content === 'string') return `${tag}${content}`
  const [first, ...rest] = content
  if (first === undefined) return [{ type: 'text', text: tag.trimEnd() }]
  if (authorOf(first.text) !== undefined && rest.length > 0) return [first, ...addressedBlocks(tag, rest)]
  return addressedBlocks(tag, content)
}

/** `blocks` with `tag` in front of the first one's words. */
const addressedBlocks = (tag: string, blocks: readonly TextContent[]): TextContent[] => {
  const [first, ...rest] = blocks
  return first === undefined ? [] : [{ ...first, text: `${tag}${first.text}` }, ...rest]
}

/** What freezing keeps of a Persona's definition at its revision, with its own model for the Topic (`own`). */
const frozenOf = (
  id: number,
  revision: number,
  definition: Pick<PersonaRevisionView, 'name' | 'avatar' | 'role' | 'instructions' | 'setup' | 'thinking' | 'tools'>,
  own: string | undefined,
): FrozenPersona & { readonly setup: PersonaSetup } => ({
  id,
  name: definition.name,
  revision,
  avatar: definition.avatar,
  role: definition.role,
  instructions: definition.instructions,
  setup: definition.setup,
  ...(own === undefined ? {} : { model: own }),
  ...(definition.thinking === undefined ? {} : { thinking: definition.thinking }),
  ...(definition.tools === undefined ? {} : { tools: definition.tools }),
})

/**
 * Persona `id` at `revision`, frozen for a turn in Topic `topic`: its words, its setup, its own model
 * (`Personas.ownModel`), how hard it thinks (ADR 0100) and how it reaches its tools (ADR 0102).
 */
export const frozenAt = (id: number, revision: number, topic: number) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const definition = yield* personas.revision(id, revision)
    return frozenOf(id, revision, definition, yield* personas.ownModel(definition.model, topic))
  })

/**
 * The tagged Personas as they are now, each at its current revision, for a turn in Topic `topic`; one that is gone or
 * archived refuses the send.
 */
const freeze = (ids: readonly number[], topic: number) =>
  Effect.gen(function* () {
    const personas = yield* Personas
    const active = yield* personas.active
    return yield* Effect.forEach([...new Set(ids)], (id) =>
      Effect.gen(function* () {
        const persona = active.find((each) => each.id === id)
        if (persona === undefined) return yield* new InvalidInput({ reason: `composer:persona:${String(id)}` })
        return frozenOf(id, persona.revision, persona, yield* personas.ownModel(persona.model, topic))
      }),
    )
  })

type Ask = {
  readonly thread: string
  readonly operationId: string
}

/** The passive `app.persona_ask` entry: the owner's message, addressed to the Personas it went to. */
const askEntry = (
  frozen: readonly FrozenPersona[],
  order: 'parallel' | 'sequence',
  content: string | TextContent[],
  now: number,
) => {
  const data = {
    personas: frozen.map(({ id, name, revision }) => ({ id, name, revision })),
    order,
  } satisfies PersonaAskData
  const names = frozen.map(({ name }) => name)
  return {
    kind: 'app.persona_ask',
    data,
    model: [{ role: 'user' as const, content: addressedTo(names, content), timestamp: now * 1000 }],
  }
}

/**
 * The owner tagged Personas (in the app, or through a Source route that a Persona answers, `from`): each
 * answers once, attributed, in this chat, and Goblin does not (ADR 0033). Admitted once per operation
 * (`ChatOperations.admit`, under the chat's lock): record who was asked, put the chat's tool filter right (its first
 * turn in this lifetime, ADR 0108; a fork copies it), write the ask into the chat as a passive `app.persona_ask` entry
 * (no run starts) and create one Persona turn per Persona, each told in a room which tools a room does not offer.
 * Nothing here waits for a model.
 */
export const askPersonas = (
  input: Ask,
  ids: readonly number[],
  order: 'parallel' | 'sequence',
  content: string | TextContent[],
  from: { readonly via: 'app' | 'mcp' } = { via: 'app' },
) =>
  Effect.gen(function* () {
    const invocations = yield* Invocations
    const { personas, toolSets, retooled } = yield* AgentInput
    const pi = yield* PiSessions
    const db = yield* Db
    const now = yield* epochSeconds
    const topic = yield* (yield* Chats).topicOf(input.thread)
    const frozen = yield* freeze(ids, topic)
    const room = (yield* attemptSync(() => roomOf(db, topic))) ? toolSets.room.map((tool) => tool.name) : undefined
    if (frozen.length > 8) return yield* new InvalidInput({ reason: 'persona_count' })
    const admission = {
      chat: input.thread,
      operationId: input.operationId,
      receipt: {
        kind: 'persona_ask',
        origin: from.via === 'mcp' ? 'source' : (yield* requestKey) === undefined ? 'owner' : 'key',
      },
      flow: { flow: 'persona_ask', via: from.via, actor: 'owner', count: frozen.length, personaOrder: order },
    } as const
    return yield* (yield* ChatOperations).admit(admission, (admitted) =>
      Effect.gen(function* () {
        const asked = frozen.map((persona, index) => ({
          operationId: input.operationId,
          persona: persona.id,
          revision: persona.revision,
          chat: input.thread,
          order: index,
        }))
        yield* invocations.insert(asked, now)
        yield* useRoomTools({ pi, db, toolSets, retooled }, input.thread, admitted.session)
        const write = { requestId: input.operationId, entry: askEntry(frozen, order, content, now) }
        const harness = yield* Effect.andThen(pi.write(admitted.session, write), pi.pi).pipe(
          Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
        )
        const parent = conversationId(admitted.session)
        yield* attempt(() =>
          personas.start(harness, {
            operationId: input.operationId,
            chat: input.thread,
            parent,
            personas: frozen,
            order,
            ...(room === undefined ? {} : { room }),
          }),
        )
        return { session: admitted.session, operationId: input.operationId, accepted: true }
      }),
    )
  })

/**
 * The owner's reply to a Persona's hold (ADR 0041): its decision on a held call, or that they allowed the tool it asked
 * for. The Persona goes on in its fork at the revision it answered with, and writes its next answer, recorded as its
 * own invocation, into the chat it was asked in; that chat must still be open. Once per operation.
 */
export const resumePersona = Effect.fn('personas.resume')(function* (fork: string, operationId: string, text: string) {
  const chats = yield* Chats
  const found = Option.getOrUndefined(yield* chats.personaFork(fork))
  if (found === undefined) return yield* new NotFound({ what: 'persona fork' })
  yield* (yield* Conversations).requireActing(fork)
  // The reply's receipt keeps who sent it, so the resumed fork's tools tell a member's reply (ADR 0099).
  yield* (yield* ChatOperations).record(found.parent, operationId, { kind: 'persona_reply', origin: 'owner' })
  const persona = yield* frozenAt(found.persona, found.revision, yield* chats.topicOf(found.parent))
  const invocations = yield* Invocations
  const asked = { operationId, persona: persona.id, revision: persona.revision, chat: found.parent, order: 0 }
  yield* invocations.insert([asked], yield* epochSeconds)
  yield* invocations.running(operationId, persona.id, fork)
  const parent = conversationId(yield* chats.session(found.parent))
  const forked = conversationId(yield* chats.session(fork))
  const harness = yield* (yield* PiSessions).pi.pipe(
    Effect.catchTag('PiFailure', (failure) => Effect.fail(toAppError(failure.cause))),
  )
  const { personas } = yield* AgentInput
  yield* attempt(() =>
    personas.resume(harness, { operationId, chat: found.parent, parent, fork: forked, persona, text }),
  )
})
