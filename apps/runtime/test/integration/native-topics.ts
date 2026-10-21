import { Attention, PRIMARY_CHAT } from '@goblin/contracts'
import { Effect, Result, Schema } from 'effect'
import { expect } from 'vitest'
import { type AgentFetch, asOwner, callOwner, workspaceSnapshot } from '../owner-client.ts'
import { ModelRequest, requestTurns } from './conversation-checks.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Probes, type ProbeStub, inWorker } from './probe.ts'
import {
  exchange,
  linesOf,
  ownerCreate,
  ownerResult,
  snapshotOf,
  transcript,
  workspaceConversations,
} from './probe-reads.ts'
import { until } from './until.ts'

const status = async (agent: AgentFetch, chat: string) => {
  const result = await ownerResult(agent, (api) => api.memory.status({ query: { chat } }))
  return result.ok ? result.value : { messages: -1, summarized: -1 }
}

/** A new Topic through the owner API, or the failure it answered (which the run's decode then shows). */
const createTopic = (agent: AgentFetch, name: string, operationId: string) =>
  callOwner(agent, (api) => Effect.result(api.topics.create({ payload: { name, operationId } })))

/**
 * Two Topics remember apart (ADR 0032): a new Topic's Conversation gets its own memory, its builder places the view
 * only there, Personal's memory holds only Personal's messages, and a thread reports its Conversation's memory.
 */
async function topicMemorySequence(agent: ProbeStub) {
  const created = await createTopic(agent, 'Garden', 'topic-memory')
  if (Result.isFailure(created)) return { created: created.failure }
  const garden = created.success.conversation
  await exchange(agent, garden, 'garden alpha', 'topic-memory-1')
  await exchange(agent, garden, 'garden beta', 'topic-memory-2')
  await exchange(agent, PRIMARY_CHAT, 'personal gamma', 'topic-memory-3')
  const remembered = await until(
    async () => status(agent, garden),
    ({ summarized }) => summarized >= 2,
  )
  await exchange(agent, garden, 'what grows here?', 'topic-memory-4')
  const thread = await ownerCreate(agent, { topic: created.success.id })
  return {
    garden: remembered,
    personal: await status(agent, PRIMARY_CHAT),
    thread: thread.ok ? await status(agent, thread.value.id) : null,
    request: await agent.requestFor('what grows here?'),
    view: (await snapshotOf(agent, garden)).entries?.[0]?.kind,
    personalLines: await transcript(agent, PRIMARY_CHAT),
    gardenLines: linesOf((await snapshotOf(agent, garden)).entries ?? []),
  }
}

/**
 * A routine the agent proposes in a Topic's Conversation belongs to that Topic (ADR 0032): its run sits under that
 * Conversation and its report lands there, never in Personal.
 */
async function topicRoutineSequence(agent: ProbeStub) {
  const created = await createTopic(agent, 'Errands', 'topic-routine')
  if (Result.isFailure(created)) return { created: created.failure }
  const errands = created.success.conversation
  const attentionOf = async () => {
    const views = await workspaceConversations(agent)
    return views.find((view) => view.id === errands)?.attention ?? []
  }
  const question = { questions: [{ id: 'day', prompt: 'Which day suits you?', kind: 'text' }] }
  await exchange(agent, errands, `call ask_user ${JSON.stringify(question)}`, 'topic-ask')
  const asked = await attentionOf()
  await exchange(agent, errands, 'Tuesday', 'topic-answer')
  const answered = await attentionOf()
  const definition = {
    title: 'Errand check',
    timezone: 'UTC',
    trigger: { kind: 'once', at: new Date(Date.now() + 3_600_000).toISOString() },
    tellMe: { on: false, copy: false },
    handTo: {
      kind: 'goblin',
      instruction: 'Return a short reminder.',
      allowedTools: [],
      budget: { tokensPerRun: 1000, tokensPerDay: 2000, runtimeSeconds: 60 },
    },
  }
  await exchange(agent, errands, `call routine_propose ${JSON.stringify(definition)}`, 'topic-routine-propose')
  const listed = await ownerResult(agent, (api) => api.routines.list())
  const routine = listed.ok ? listed.value.routines.find((each) => each.definition.title === 'Errand check') : undefined
  if (routine === undefined) return { listed }
  const confirm = { revision: 1, operationId: 'topic-routine-confirm' }
  await ownerResult(agent, (api) => api.routines.confirm({ params: { id: routine.id }, payload: confirm }))
  const manual = { revision: 1, operationId: 'topic-routine-run', confirmRun: true } as const
  await ownerResult(agent, (api) => api.routines.run({ params: { id: routine.id }, payload: manual }))
  const runs = async () => {
    const page = await ownerResult(agent, (api) => api.routines.runs({ params: { id: routine.id } }))
    return page.ok ? page.value.runs : []
  }
  await until(runs, (each) => each.some((run) => run.state === 'completed'))
  await agent.routinesWake()
  const reported = await until(runs, (each) => each.some((run) => run.reportAcceptedAt !== null))
  const views = await workspaceConversations(agent)
  return {
    topic: created.success.id,
    errands,
    asked,
    answered,
    reported: reported.some((run) => run.reportAcceptedAt !== null),
    runChat: views.find((view) => view.title === 'Errand check') ?? null,
    errandsLines: await transcript(agent, errands),
    personalLines: await transcript(agent, PRIMARY_CHAT),
  }
}

/** Current channel guidance reaches real model requests, survives updates, and follows a thread. */
async function guidanceSequence(agent: ProbeStub) {
  const created = await callOwner(agent, (api) =>
    api.topics.create({
      payload: {
        name: 'Guidance',
        description: 'Plan the garden',
        instructions: 'Use metric units.',
        operationId: 'guidance-topic',
      },
    }),
  )
  const chat = created.conversation
  await exchange(agent, chat, 'guidance before', 'guidance-before')
  const before = await agent.requestFor('guidance before')
  await callOwner(agent, (api) =>
    api.topics.update({
      params: { id: created.id },
      payload: {
        instructions: 'Keep a planting calendar.',
        expectedRevision: created.revision,
      },
    }),
  )
  await exchange(agent, chat, 'guidance after', 'guidance-after')
  const after = await agent.requestFor('guidance after')
  const thread = await ownerCreate(agent, { topic: created.id })
  if (!thread.ok) return { thread }
  await exchange(agent, thread.value.id, 'guidance thread', 'guidance-thread')
  await exchange(agent, PRIMARY_CHAT, 'guidance separate', 'guidance-separate')
  return {
    before: before?.context,
    after: after?.context,
    thread: (await agent.requestFor('guidance thread'))?.context,
    separate: (await agent.requestFor('guidance separate'))?.context,
  }
}

/**
 * Start's kickoff (ADR 0079) in one call: a channel with the goal as its description, the goal sent there with the
 * reminder to begin useful work, Start done. A retry replays it, and a taken name is refused before anything is made.
 */
async function kickoffSequence(agent: ProbeStub) {
  const kickoff = { goal: 'Plan a balcony garden for spring', channel: 'Balcony garden', operationId: 'kickoff' }
  const first = await callOwner(agent, (api) => api.onboarding.kickoff({ payload: kickoff }))
  const chat = first.topic.conversation
  await agent.settle(chat, 'kickoff:message')
  // A response can be lost after acceptance. Current admission must not strand that completed kickoff's retry.
  await callOwner(agent, (api) => api.topics.update({ params: { id: first.topic.id }, payload: { archived: true } }))
  const replay = await callOwner(agent, (api) => api.onboarding.kickoff({ payload: kickoff }))
  await callOwner(agent, (api) => api.topics.update({ params: { id: first.topic.id }, payload: { archived: false } }))
  const taken = await callOwner(agent, (api) =>
    Effect.result(api.onboarding.kickoff({ payload: { ...kickoff, operationId: 'kickoff-again' } })),
  )
  const { topics } = await workspaceSnapshot(
    await agent.fetch(new Request('https://agent/api/workspace/events', asOwner())),
  )
  return {
    description: first.topic.description ?? '',
    status: first.view.status,
    kicked: first.view.kickoff,
    replayed: replay.topic.id === first.topic.id,
    replayedArchived: replay.topic.archivedAt !== undefined,
    taken: Result.isFailure(taken) ? taken.failure._tag : 'made',
    named: (topics ?? []).filter((topic) => topic.name === kickoff.channel).length,
    context: (await agent.requestFor(kickoff.goal))?.context ?? '',
    lines: await transcript(agent, chat),
  }
}

export const probes: Probes = {
  'onboarding-kickoff': inWorker(({ agent }) => kickoffSequence(agent)),
  'topic-guidance': inWorker(({ agent }) => guidanceSequence(agent)),
  'topic-memory': inWorker(({ agent }) => topicMemorySequence(agent)),
  'topic-routine': inWorker(({ agent }) => topicRoutineSequence(agent)),
}

const Status = Schema.Struct({ messages: Schema.Number, summarized: Schema.Number })
const TopicMemoryRun = Schema.Struct({
  garden: Status,
  personal: Status,
  thread: Status,
  request: ModelRequest,
  view: Schema.String,
  personalLines: Schema.Array(Schema.String),
  gardenLines: Schema.Array(Schema.String),
})

const TopicRoutineRun = Schema.Struct({
  topic: Schema.Number,
  errands: Schema.String,
  asked: Schema.Array(Attention),
  answered: Schema.Array(Attention),
  reported: Schema.Boolean,
  runChat: Schema.Struct({ parent: Schema.optional(Schema.String), topic: Schema.optional(Schema.Number) }),
  errandsLines: Schema.Array(Schema.String),
  personalLines: Schema.Array(Schema.String),
})

/** The native Topic cases: two Topics remember apart, and a Topic's routine reports to its own Conversation. */
async function topicChecks(base: string): Promise<void> {
  const kickoff = await probeOf(
    base,
    'onboarding-kickoff',
    Schema.Struct({
      description: Schema.String,
      status: Schema.String,
      kicked: Schema.Boolean,
      replayed: Schema.Boolean,
      replayedArchived: Schema.Boolean,
      taken: Schema.String,
      named: Schema.Number,
      context: Schema.String,
      lines: Schema.Array(Schema.String),
    }),
  )
  expect(kickoff).toMatchObject({
    description: 'Plan a balcony garden for spring',
    status: 'done',
    kicked: true,
    replayed: true,
    replayedArchived: true,
    taken: 'Conflict',
    named: 1,
  })
  expect(kickoff.context).toContain('Begin by doing one useful piece')
  // The goal went once, however often the kickoff was asked.
  expect(kickoff.lines.filter((line) => line.startsWith('pi.user') && line.includes('balcony garden'))).toHaveLength(1)
  const guidance = await probeOf(
    base,
    'topic-guidance',
    Schema.Struct({ before: Schema.String, after: Schema.String, thread: Schema.String, separate: Schema.String }),
  )
  expect(guidance.before).toContain('Use metric units.')
  expect(guidance.after).toContain('Keep a planting calendar.')
  expect(guidance.after).not.toContain('Use metric units.')
  expect(guidance.thread).toContain('Plan the garden')
  expect(guidance.thread).toContain('Keep a planting calendar.')
  expect(guidance.separate).not.toContain('Keep a planting calendar.')
  const result = await probeOf(base, 'topic-memory', TopicMemoryRun)
  expect(result.garden.summarized).toBeGreaterThanOrEqual(2)
  expect(result.thread.messages).toBeGreaterThanOrEqual(result.garden.messages)
  expect(requestTurns(result.request)).toEqual([
    '<memory>\n0+1|user: garden alpha\n1+1|talk: echo: garden alpha\n</memory>',
    'garden beta',
    'echo: garden beta',
    'what grows here?',
  ])
  expect(result.view).toBe('app.memory')
  // Personal remembers only its own exchange, and no view of the Garden reaches it.
  expect(result.personal).toEqual({ messages: 2, summarized: 0 })
  expect(result.personalLines.join('\n')).not.toContain('garden')
  expect(result.personalLines.some((line) => line.startsWith('app.memory'))).toBe(false)
  expect(result.gardenLines.join('\n')).not.toContain('personal gamma')
  const routine = await probeOf(base, 'topic-routine', TopicRoutineRun)
  // A question waits on the owner in its chat's attention until their next message answers it.
  expect(routine.asked).toEqual([
    { kind: 'question', since: expect.any(Number), entry: expect.any(Number), label: 'Which day suits you?' },
  ])
  expect(routine.answered).toEqual([])
  expect(routine.reported).toBe(true)
  expect(routine.runChat).toMatchObject({ parent: routine.errands, topic: routine.topic })
  expect(routine.errandsLines.some((line) => line.startsWith('app.routine'))).toBe(true)
  expect(routine.personalLines.some((line) => line.startsWith('app.routine'))).toBe(false)
}

export const cases: readonly NativeCase[] = [
  {
    title: 'each Topic Conversation remembers apart, with its view only there, and its routines report there',
    run: topicChecks,
  },
]
