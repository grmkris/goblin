import {
  PERSONAL_TOPIC,
  type RoutineDefinition,
  type RoutineHandTo,
  type AskedRoutine,
  type RoutineEdit,
  type RoutineRevision,
  type RoutineSettings,
} from '@goblin/contracts'
import * as Clock from 'effect/Clock'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import { nextInt } from 'effect/Random'
import { Chats } from '../chats/service.ts'
import { personaNamed } from '../personas/program.ts'
import { topicNamed } from '../topics/program.ts'
import { RoutineControl, Routines } from './service.ts'

export const routinesList = Effect.gen(function* () {
  const store = yield* Routines
  return { routines: yield* store.list() }
})
/** Prepare a local proposal write without persisting it; the caller commits it in a short SQLite transaction. */
export const prepareRoutine = Effect.fn('routines.prepare')(function* (
  definition: RoutineDefinition,
  operationId: string,
  topic: number,
) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  const suffix = yield* nextInt
  return yield* store.prepare(definition, operationId, `rt_${at}_${Math.abs(suffix)}`, at, topic)
})

/** A draft routine, owned by Topic `topic`: the one the owner named, or the Topic of the chat that proposed it. */
export const proposeRoutine = Effect.fn('routines.propose')(function* (
  definition: RoutineDefinition,
  operationId: string,
  topic: number,
) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  const suffix = yield* nextInt
  const id = `rt_${at}_${Math.abs(suffix)}`
  return (yield* store.propose(definition, operationId, id, at, topic)).routine
})

/** The Topic of a Pi session's chat, or Personal when it has no chat. */
const topicFromSession = (session: string) =>
  Effect.gen(function* () {
    const chats = yield* Chats
    const chat = yield* chats.chatOf(session)
    return Option.isNone(chat) ? PERSONAL_TOPIC : yield* chats.topicOf(chat.value)
  })

/** The hand-over `asked` names, with a Persona's name resolved to it at its revision now. */
const handToOf = (asked: AskedRoutine['handTo']) =>
  Effect.gen(function* () {
    if (asked.kind !== 'persona') return asked
    const persona = yield* personaNamed(asked.persona)
    return { ...asked, persona: persona.id, revision: persona.revision } satisfies RoutineHandTo
  })

/** Resolve the Topic and pin the Persona once, for individual and composed proposals alike. */
export const resolveAskedRoutine = Effect.fn('routines.resolveAsked')(function* (asked: AskedRoutine, session: string) {
  const { topic: topicName, handTo, ...rest } = asked
  const definition = { ...rest, handTo: yield* handToOf(handTo) }
  const topic = topicName === undefined ? yield* topicFromSession(session) : (yield* topicNamed(topicName)).id
  return { definition, topic }
})

/** A draft routine using the canonical name resolver; the owner still reviews it before it runs. */
export const proposeAsked = Effect.fn('routines.proposeAsked')(function* (
  asked: AskedRoutine,
  operationId: string,
  session: string,
) {
  const { definition, topic } = yield* resolveAskedRoutine(asked, session)
  return yield* proposeRoutine(definition, operationId, topic)
})

export const editRoutine = Effect.fn('routines.edit')(function* (id: string, input: RoutineEdit) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store.edit(id, input, at)).routine
})
/** What the owner does to one revision of a routine; "confirm again" repins its Persona first (ADR 0041). */
type RoutineAction = 'confirm' | 'confirmAgain' | 'pause' | 'archive'

/** The owner changes one revision of routine `id`. */
export const changeRoutine = Effect.fn('routines.changeRevision')(function* (
  id: string,
  input: RoutineRevision,
  action: RoutineAction,
) {
  const store = yield* Routines
  const at = yield* Clock.currentTimeMillis
  return (yield* store[action](id, input.revision, input.operationId, at)).routine
})

export const setRoutineSettings = Effect.fn('routines.setSettings')(function* (settings: RoutineSettings) {
  const store = yield* Routines
  yield* store.updateSettings(settings.timezone, settings.maxActive, settings.maxRunning)
  return yield* store.settings
})

/**
 * The owner confirms (or confirms again), pauses or archives a routine: a confirm subscribes an event routine, archive
 * stops its runs.
 */
export const routineChange = Effect.fn('routines.change')(function* (
  id: string,
  input: RoutineRevision,
  action: RoutineAction,
) {
  const changed = yield* changeRoutine(id, input, action)
  const control = yield* RoutineControl
  if (action === 'confirm' || action === 'confirmAgain') yield* control.confirmEvents(changed.id, changed.revision)
  if (action === 'archive') yield* control.archive(id)
  yield* control.reconcile
  return yield* (yield* Routines).view(id)
})
