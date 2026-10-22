import { describe, expect, it } from '@effect/vitest'
import type { ModelEndpointView, ServerView } from '@goblin/contracts'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as TestClock from 'effect/testing/TestClock'
import { afterEach } from 'vitest'
import { Chats } from '../src/chats/service.ts'
import { Inference } from '../src/inference/service.ts'
import { OnboardingLive } from '../src/layers/onboarding.ts'
import { McpServers } from '../src/mcp/service.ts'
import {
  changeOnboarding,
  connectedFromStart,
  onboardingContext,
  onboardingView,
  startConnect,
} from '../src/onboarding/program.ts'
import { Onboarding } from '../src/onboarding/service.ts'
import { OnboardingStore } from '../src/onboarding/store.ts'
import { chatDatabase, durable, sqliteDb } from './chats-sqlite.ts'
import { stub } from './http/api/fixture.ts'

const DEPLOYMENT: ModelEndpointView = { source: 'deployment', deployment: true, models: ['house-model'] }
const OWN: ModelEndpointView = {
  source: 'owner',
  deployment: true,
  baseUrl: 'https://models.example/v1',
  keyHint: 'k3y9',
  models: ['own-model'],
}

/** A server as the owner's list shows it. */
const server = (connectionId: string, status: ServerView['status']): ServerView => ({
  connectionId,
  label: connectionId,
  endpoint: `https://${connectionId}.example/mcp`,
  status,
  live: status === 'connected',
  source: 'added',
})

const closes: (() => void)[] = []
afterEach(() => {
  for (const close of closes.splice(0)) close()
})

/**
 * Start over real SQLite, with the owner's servers and the model endpoint in use. `begun` records the sign-ins Start
 * begins, and `signIn` says whether a sign-in leaves for an authorization server or connects at once. No grant or
 * server status is reachable: Start reads and allows nothing on any server.
 */
const start = (
  servers: readonly ServerView[] = [],
  { model = DEPLOYMENT, signIn = true }: { readonly model?: ModelEndpointView; readonly signIn?: boolean } = {},
) => {
  const { db, close } = chatDatabase()
  closes.push(close)
  const begun: string[] = []
  const layer = OnboardingLive.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sqliteDb(db),
        stub(McpServers, {
          list: () => Effect.succeed(servers),
          beginConnect: (connectionId: string) =>
            Effect.sync(() => {
              begun.push(connectionId)
              return signIn ? { authorizationUrl: `https://auth.example/authorize?for=${connectionId}` } : {}
            }),
        }),
        stub(Inference, { view: Effect.succeed(model) }),
        // Main is session `s1`.
        // SAFETY: the setup note reads only main's chat id and its session from the directory.
        stub(Chats, { primary: '1', session: (chat: string) => Effect.succeed(chat === '1' ? 's1' : 's2') } as never),
      ),
    ),
  )
  return { layer, begun }
}

const kept = Onboarding.use((onboarding) => onboarding.read)
const done = (view: { readonly steps: readonly { readonly id: string; readonly done: boolean }[] }) =>
  view.steps.filter((step) => step.done).map((step) => step.id)

describe('first-run Start (ADR 0062)', () => {
  it.effect('is open on its welcome, every step to do, for an untouched account, and keeps nothing', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view).toEqual({
        status: 'open',
        steps: [
          { id: 'welcome', done: false },
          { id: 'model', done: false },
          { id: 'services', done: false },
          { id: 'goblin', done: false },
        ],
        model: DEPLOYMENT,
        connected: 1,
        kickoff: false,
      })
      expect(yield* kept).toBeUndefined()
    }).pipe(Effect.provide(start([server('notes', 'connected'), server('mail', 'needs_auth')]).layer)),
  )

  it.effect('counts the model step done once the owner brought their own endpoint, and nothing else for it', () =>
    Effect.gen(function* () {
      const view = yield* onboardingView
      expect(view.model).toEqual(OWN)
      expect(done(view)).toEqual(['model'])
      // Set up as it may be, Start is never done by itself: only the owner finishes or skips it.
      expect(view.status).toBe('open')
      expect(yield* kept).toBeUndefined()
    }).pipe(Effect.provide(start([server('notes', 'connected')], { model: OWN }).layer)),
  )

  it.effect('marks each step the owner goes through once, and going through every step leaves Start open', () =>
    Effect.gen(function* () {
      yield* changeOnboarding({ step: 'welcome' })
      yield* changeOnboarding({ step: 'welcome' })
      yield* changeOnboarding({ step: 'model' })
      const view = yield* changeOnboarding({ step: 'services' })
      expect(done(view)).toEqual(['welcome', 'model', 'services'])
      expect(view.status).toBe('open')
      expect((yield* kept)?.steps).toEqual(['welcome', 'model', 'services'])
    }).pipe(Effect.provide(start().layer)),
  )

  it.effect("keeps the owner's word: skipped, reopened, and finished with the first kickoff", () =>
    Effect.gen(function* () {
      const skipped = yield* changeOnboarding({ status: 'skipped', step: 'welcome' })
      expect(skipped.status).toBe('skipped')
      expect(done(skipped)).toEqual(['welcome'])
      // A step alone keeps the kept status; `open` forgets it.
      expect((yield* changeOnboarding({ step: 'model' })).status).toBe('skipped')
      expect((yield* changeOnboarding({ status: 'open' })).status).toBe('open')
      yield* Onboarding.use((onboarding) => onboarding.kickoff('2', 60))
      const finished = yield* changeOnboarding({ status: 'done' })
      expect(finished).toMatchObject({ status: 'done', kickoff: true })
      // The kickoff alone is the goblin step done.
      expect(done(finished)).toEqual(['welcome', 'model', 'goblin'])
      // A retried kickoff keeps the first one, its time and its channel.
      yield* Onboarding.use((onboarding) => onboarding.kickoff('3', 120))
      expect((yield* kept)?.kickoff).toEqual({ at: 60, chat: '2' })
    }).pipe(Effect.provide(start().layer)),
  )

  it('reads an older Start\'s row: the steps it no longer has are dropped, and its "open" is open', () => {
    const { db, sqlite, close } = chatDatabase()
    closes.push(close)
    const store = new OnboardingStore(durable(db))
    sqlite.exec(
      `INSERT INTO app_onboarding (id, status, steps, updated_at) VALUES (1, 'open', '["welcome","retired","unknown","goblin","goblin"]', 1000)`,
    )
    expect(store.get()).toEqual({ status: undefined, steps: ['welcome', 'goblin'], kickoff: undefined })
    sqlite.exec(`UPDATE app_onboarding SET steps = 'not json' WHERE id = 1`)
    expect(store.get()?.steps).toEqual([])
  })

  it('remembers where a sign-in Start began comes back to, once, not after an hour, and only to a step it has', () => {
    const { db, sqlite, close } = chatDatabase()
    closes.push(close)
    const store = new OnboardingStore(durable(db))
    store.noteConnect('notes', 'welcome', 1000)
    store.noteConnect('notes', 'services', 1100)
    expect(store.takeConnect('notes', 1200)).toBe('services')
    expect(store.takeConnect('notes', 1200)).toBeUndefined()
    store.noteConnect('mail', 'services', 1000)
    expect(store.takeConnect('mail', 1000 + 59 * 60)).toBe('services')
    store.noteConnect('mail', 'services', 1000)
    expect(store.takeConnect('mail', 1000 + 61 * 60)).toBeUndefined()
    // A note an older Start left for a step it no longer has comes back to Connections.
    sqlite.exec(
      `INSERT INTO app_onboarding_connects (connection_id, step, recommend, created_at) VALUES ('bank', 'retired', 1, 1000)`,
    )
    expect(store.takeConnect('bank', 1100)).toBeUndefined()
  })

  it.effect('begins a sign-in from its step and comes back there, allowing nothing on the way', () => {
    const { layer, begun } = start([server('notes', 'needs_auth')])
    return Effect.gen(function* () {
      const started = yield* startConnect({ connectionId: 'notes', step: 'services' })
      expect(started.authorizationUrl).toBe('https://auth.example/authorize?for=notes')
      expect(begun).toEqual(['notes'])
      expect(yield* connectedFromStart('notes')).toBe('services')
      // Taken once: a later sign-in to the same server comes back to Connections.
      expect(yield* connectedFromStart('notes')).toBeUndefined()
      expect(yield* connectedFromStart('mail')).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect('takes the note at once when the server connects without a sign-in', () => {
    const { layer, begun } = start([server('kiwi', 'needs_auth')], { signIn: false })
    return Effect.gen(function* () {
      expect(yield* startConnect({ connectionId: 'kiwi', step: 'services' })).toEqual({})
      expect(begun).toEqual(['kiwi'])
      expect(yield* connectedFromStart('kiwi')).toBeUndefined()
    }).pipe(Effect.provide(layer))
  })

  it.effect('tells goblin to begin useful work after the kickoff, without an architecture questionnaire', () =>
    Effect.gen(function* () {
      expect(yield* onboardingContext('s1')).toBeUndefined()
      yield* Onboarding.use((onboarding) => onboarding.kickoff('2', 0))
      const kickoff = yield* onboardingContext('s2')
      expect(kickoff).toContain('Begin by doing one useful piece')
      expect(kickoff).not.toContain('topic_create')
      expect(yield* onboardingContext('s1')).toBeUndefined()
      // Twenty minutes on, the ask is gone.
      yield* TestClock.adjust('20 minutes')
      expect(yield* onboardingContext('s2')).toBeUndefined()
    }).pipe(Effect.provide(start().layer)),
  )
})
