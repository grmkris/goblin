// The skill learner: after a final answer that followed a correction or a request to remember how something was done,
// a cheap model decides whether the exchange teaches a reusable procedure, and if so the agent writes a draft to the
// owner's files (`/agent/skills/drafts/<name>.md`) and tells them with a notice in the chat it learned from, which
// Activity lists. What becomes of a draft is the owner's choice; nothing here publishes a skill. Facts about the owner
// stay in memory and are not skills. Drafts are capped per day, the same draft is never written twice, and a draft still
// in the owner's files is never written over.
import type { ConversationId } from '@earendil-works/pi-durable'
import * as Clock from 'effect/Clock'
import type * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import { Chats, type Conversations } from '../chats/service.ts'
import { Files } from '../files/service.ts'
import { OWNER_VIEW } from '../files/folders.ts'
import type { CheapModel } from '../memory/model.ts'
import { Notices } from '../notices/service.ts'
import { writeLine } from '../observability/logger.ts'
import { reportAndRecover } from '../observability/report.ts'
import { SingleFlight } from '../observability/single-flight.ts'
import { PiSessions } from '../pi/sessions.ts'
import { type TranscriptMessage, recentMessages } from '../pi/transcript.ts'
import { writeNotice } from '../routines/notices.ts'
import type { Changes } from '../runtime/changes.ts'
import { Learner, type Skills } from './service.ts'
import type { DraftLog, SkillState } from './store.ts'
import { digestOf } from './verify.ts'

/** Where the learner writes its drafts, one Markdown file per skill. */
const DRAFTS = '/agent/skills/drafts'

const DRAFTS_PER_DAY = 5
const DAY_MS = 86_400_000
const MAX_TRANSCRIPT = 12_000
const MAX_BODY = 20_000

/** A correction, a standing instruction, or a request to keep how something was done. */
const SIGNAL =
  /\b(no[,.!]|wrong|instead|actually|not what|should(?:n't| not)? have|next time|from now on|always|never|don't|do not|remember|you missed|you forgot|forgot to)\b|\b(save|turn|make|keep|update)\b.{0,40}\b(skill|procedure|playbook|how we did)\b/iu

const SYSTEM = [
  'You maintain reusable skills for a personal AI agent. A skill is a procedure: how to do a kind of task, as steps,',
  'checks and pitfalls. Given the latest exchange and the skills the agent used, decide whether it teaches a reusable',
  'procedure. Facts about the owner (preferences, people, dates, accounts) are not skills: answer none for those. Most',
  'exchanges teach nothing: then answer none. When the owner corrected how a used skill works, answer improve with the',
  'whole new body. Write procedures generally: never include names of people, email addresses, account ids, secrets,',
  'or quotes of private content.',
  'Answer with exactly one JSON object and nothing else:',
  '{"action":"none"}',
  '{"action":"new","name":"kebab-case-name","description":"one sentence: when to use it","body":"markdown steps","evidence":"one sentence on what taught this, with no private details"}',
  '{"action":"improve","skill":"<handle of the used skill>","description":"…","body":"…","evidence":"…"}',
].join('\n')

const Decision = Schema.Union([
  Schema.Struct({ action: Schema.Literal('none') }),
  Schema.Struct({
    action: Schema.Literal('new'),
    name: Schema.String.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u), Schema.isMaxLength(64)),
    description: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(300)),
    body: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(MAX_BODY)),
    evidence: Schema.String.check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    action: Schema.Literal('improve'),
    skill: Schema.String,
    description: Schema.String.check(Schema.isMinLength(10), Schema.isMaxLength(300)),
    body: Schema.String.check(Schema.isMinLength(20), Schema.isMaxLength(MAX_BODY)),
    evidence: Schema.String.check(Schema.isMaxLength(500)),
  }),
])
type Decision = typeof Decision.Type
const decodeDecision = Schema.decodeUnknownSync(Schema.fromJsonString(Decision))

/** Secret-shaped strings never leave in a draft, whatever the model wrote. */
const scrub = (text: string) =>
  text
    .replaceAll(/[\w.+-]+@[\w-]+\.[\w.-]+/gu, '[email]')
    .replaceAll(/\b(?:sk|pk|ghp|gho|xox[abp])[-_][\w-]{10,}\b/gu, '[secret]')
    .replaceAll(/\b[A-Za-z0-9_-]{32,}\b/gu, '[redacted]')

/** The first JSON object in a model answer. */
const jsonObject = (text: string): string | undefined => {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start === -1 || end <= start ? undefined : text.slice(start, end + 1)
}

const transcriptText = (messages: readonly TranscriptMessage[]): string =>
  messages
    .map((message) => `${message.role === 'user' ? (message.author ?? 'owner') : 'agent'}: ${message.text}`)
    .join('\n\n')
    .slice(-MAX_TRANSCRIPT)

const yamlString = (value: string) => JSON.stringify(value.replaceAll(/\s+/gu, ' ').trim())

export type LearnOutcome = 'skipped' | 'none' | 'duplicate' | 'drafted' | 'failed'

/** Log only the bounded learner outcome; transcript, skill body and draft content never enter this line. */
export const logLearnOutcome = (conversation: ConversationId, outcome: LearnOutcome): void => {
  writeLine('info', {
    event: 'skill-learner',
    conversation: String(conversation),
    kind: outcome,
  })
}

/** What the learner keeps and asks: its draft log, the skills state and library, and the cheap model. */
export type LearnerDeps = {
  readonly drafts: DraftLog
  readonly state: SkillState
  readonly skills: Skills['Service']
  readonly model: CheapModel
}

/** What a notice of a draft is written with: the chat the lesson came from, and the notices (ADR 0041). */
type Told = Chats | Notices | Conversations | Changes

/** What the learner's steps share: its own parts, the owner's files and what it tells the owner with. */
type Teacher = LearnerDeps & {
  readonly files: Files['Service']
  readonly told: Context.Context<Told>
}

/** A lesson the model drew: a new skill, or an improvement of one the conversation used. */
type Lesson = Exclude<Decision, { action: 'none' }>

/** The skills the conversation used, newest first. */
type Used = ReturnType<SkillState['activations']>

/** A skill's name as a file name: lower-case letters and digits in words joined by `-`, at most 64 characters. */
const fileName = (name: string): string => {
  const slug = name
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .slice(0, 64)
    .replaceAll(/^-+|-+$/gu, '')
  return slug === '' ? 'skill' : slug
}

/**
 * The skill a draft names, and the skill it improves with its server; `undefined` when an improvement names no skill the
 * conversation used.
 */
const targetOf = (decision: Lesson, used: Used) => {
  if (decision.action === 'new') return { name: decision.name, base: undefined }
  const base = used.find((item) => `${item.connectionId}:${String(item.entry.frontmatter['name'])}` === decision.skill)
  if (base === undefined) return undefined
  const name = fileName(String(base.entry.frontmatter['name']))
  return { name, base: { connectionId: base.connectionId, uri: base.entry.uri } }
}

/** Whether the owner's files hold `path` still: a draft there waits for them. */
const waiting = (teacher: Teacher, path: string) =>
  teacher.files.stat(OWNER_VIEW, path).pipe(
    Effect.as(true),
    // expected: no file there, so the draft is not waiting
    Effect.catchTag('NotFound', () => Effect.succeed(false)),
  )

/**
 * The owner's notice of a draft, in the chat the lesson came from (Activity lists it): where the file is and, as its
 * body, what taught it. A chat that is gone gets none, and a notice that fails never fails the draft.
 */
const tell = (
  teacher: Teacher,
  session: string,
  draft: { readonly key: string; readonly name: string; readonly path: string; readonly improves: boolean },
  evidence: string,
) =>
  Effect.gen(function* () {
    const chat = Option.getOrUndefined(yield* (yield* Chats).chatOf(session))
    if (chat === undefined) return
    const id = `notice:skill-draft:${draft.key}`
    const now = yield* Clock.currentTimeMillis
    const what = draft.improves ? `an improvement to the skill "${draft.name}"` : `a new skill, "${draft.name}"`
    const claim = yield* (yield* Notices).claim(
      {
        id,
        routineId: 'skill-learner',
        source: 'event',
        chatId: chat,
        entryRequestId: id,
        connectionId: null,
        label: 'Skill learner',
        title: `Drafted ${what}, for you to review: ${draft.path}`,
        body: evidence === '' ? null : evidence,
        url: null,
        at: now,
        createdAt: now,
      },
      false,
    )
    if (claim.posted) yield* writeNotice(id)
  }).pipe(Effect.provideContext(teacher.told), reportAndRecover('skills.draftNotice', undefined))

/**
 * Writes `decision` as a draft to the owner's files and tells them, unless the same draft was written before or a draft
 * of the same skill still waits there.
 */
const draft = (teacher: Teacher, session: string, decision: Lesson, used: Used) =>
  Effect.gen(function* () {
    const { drafts, files } = teacher
    const target = targetOf(decision, used)
    if (target === undefined) return 'failed'
    const { name, base } = target
    const text = `---\nname: ${name}\ndescription: ${yamlString(scrub(decision.description))}\n---\n\n${scrub(decision.body).trim()}\n`
    const contentHash = yield* Effect.tryPromise(() =>
      digestOf(new TextEncoder().encode(`${base?.uri ?? ''}\n${text}`)),
    )
    const path = `${DRAFTS}/${name}.md`
    if (drafts.known(contentHash) || (yield* waiting(teacher, path))) return 'duplicate'
    const now = yield* Clock.currentTimeMillis
    yield* Effect.sync(() => drafts.add({ contentHash, name, base }, now))
    const bytes = new TextEncoder().encode(text)
    // A draft is goblin's own keeping, in the Shared folder the owner reviews it from (ADR 0115).
    const written = yield* files.write(OWNER_VIEW, path, text, 'text/markdown; charset=utf-8', bytes.byteLength).pipe(
      Effect.as(true),
      // expected: a draft that was not written is forgotten, so it does not block the next one; the outcome is `failed`
      Effect.catch(() => Effect.succeed(false)),
    )
    if (!written) {
      yield* Effect.sync(() => drafts.forget(contentHash))
      return 'failed'
    }
    const key = contentHash.slice('sha256:'.length, 'sha256:'.length + 32)
    yield* tell(teacher, session, { key, name, path, improves: base !== undefined }, scrub(decision.evidence))
    return 'drafted'
  })

/** The conversation's latest messages, when the owner's last one corrects or asks to keep something; else none. */
const lesson = (sessionId: string) =>
  Effect.gen(function* () {
    const conversation = yield* PiSessions.use((sessions) => sessions.conversation(sessionId))
    if (Option.isNone(conversation)) return undefined
    const messages = yield* Effect.tryPromise(() => recentMessages(conversation.value, 8))
    const lastUser = messages.findLast((message) => message.role === 'user')
    return lastUser !== undefined && SIGNAL.test(lastUser.text) ? messages : undefined
  })

/** The cheap model's decision on the exchange, given the skills used; `undefined` when it answered no JSON. */
const decide = (
  teacher: Teacher,
  messages: readonly TranscriptMessage[],
  used: Used,
  signal: AbortSignal | undefined,
) =>
  Effect.gen(function* () {
    const usedSkills = used
      .map((item) => `- ${item.connectionId}:${String(item.entry.frontmatter['name'])} (${item.entry.uri})`)
      .join('\n')
    const prompt = `Skills used in this conversation:\n${usedSkills || '(none)'}\n\nLatest exchange:\n${transcriptText(messages)}`
    const answer = yield* Effect.tryPromise(() => teacher.model.complete(SYSTEM, prompt, 2000, signal))
    const json = jsonObject(answer)
    if (json === undefined) return undefined
    return yield* Effect.try(() => decodeDecision(json))
  })

/**
 * Considers the newest exchange of a conversation (never an installed app's, which its hook leaves out, ADR 0115).
 * Cheap checks first: skills on for some server (the learner is part of using skills), today's cap, a signal in the
 * owner's last message. Only then the model, and only an actual procedure becomes a draft.
 */
const considered = (teacher: Teacher, id: ConversationId, signal: AbortSignal | undefined) =>
  Effect.gen(function* () {
    const sessionId = String(id)
    const now = yield* Clock.currentTimeMillis
    const capped = teacher.drafts.countSince(now - DAY_MS) >= DRAFTS_PER_DAY
    if (capped || (yield* teacher.skills.sources()).length === 0) return 'skipped'
    const messages = yield* lesson(sessionId)
    if (messages === undefined) return 'skipped'
    const used = teacher.state
      .activations(sessionId)
      .toSorted((a, b) => b.activatedAt - a.activatedAt)
      .slice(0, 3)
    const decision = yield* decide(teacher, messages, used, signal)
    if (decision === undefined) return 'failed'
    if (decision.action === 'none') return 'none'
    return yield* draft(teacher, sessionId, decision, used)
  })

/**
 * The skill learner over the owner's files and notices: no server is asked to take a draft. One consideration per
 * conversation runs at a time; another asked meanwhile is `skipped`. Any failure is the `failed` outcome, which the
 * outcome line records.
 */
export const makeLearner = Effect.fnUntraced(function* (deps: LearnerDeps) {
  const teacher: Teacher = { ...deps, files: yield* Files, told: yield* Effect.context<Told>() }
  const sessions = yield* PiSessions
  const flights = yield* SingleFlight
  return Learner.of({
    consider: Effect.fn('Learner.consider')(function* (conversation: ConversationId, signal?: AbortSignal) {
      const outcome = yield* flights.skip(
        `skills.learn:${String(conversation)}`,
        considered(teacher, conversation, signal).pipe(
          Effect.map((done): LearnOutcome => done),
          // expected: any failure is the `failed` outcome, which the outcome line records
          Effect.catch(() => Effect.succeed<LearnOutcome>('failed')),
          Effect.provideService(PiSessions, sessions),
        ),
      )
      return Option.getOrElse(outcome, (): LearnOutcome => 'skipped')
    }),
  })
})
