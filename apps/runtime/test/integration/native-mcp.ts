import * as Schema from 'effect/Schema'
import { mkdirSync, writeFileSync } from 'node:fs'
import { URL as FileURL } from 'node:url'
import { expect } from 'vitest'
import { type NativeCase, evict, freshName, matchCase, probeCase, probeOf } from './native-case.ts'

const SkillsCache = Schema.Struct({
  firstBody: Schema.String,
  secondBody: Schema.String,
  reads: Schema.Number,
  repaired: Schema.Boolean,
})
const LearnerOutcome = Schema.Literals(['skipped', 'none', 'duplicate', 'drafted', 'failed'])
const SkillsLearnerDraft = Schema.Struct({
  first: LearnerOutcome,
  second: LearnerOutcome,
  files: Schema.Array(Schema.String),
  notices: Schema.Array(Schema.String),
  rows: Schema.Array(
    Schema.Struct({ connectionId: Schema.String, name: Schema.String, baseUri: Schema.NullOr(Schema.String) }),
  ),
})
const SkillsPersisted = Schema.Struct({
  instance: Schema.String,
  retained: Schema.Struct({
    activation: Schema.Unknown,
    digest: Schema.String,
    cachedText: Schema.String,
    file: Schema.Struct({ kind: Schema.Literal('text'), path: Schema.String, text: Schema.String }),
    networkCalls: Schema.Number,
  }),
})

/** Skill activation and its verified bytes, written, then read again by the restarted lifecycle object. */
async function skillsRestartChecks(base: string): Promise<void> {
  const name = freshName('skills-restart')
  const before = await probeOf(base, 'skills-write', SkillsPersisted, name)
  await evict(base, name, 'skills-evict')
  const after = await probeOf(base, 'skills-read', SkillsPersisted, name)
  expect(after.instance).not.toBe(before.instance)
  expect(after.retained).toEqual(before.retained)
  expect(after.retained.networkCalls).toBe(0)
  expect(after.retained.cachedText).toContain('# Cache test')
  expect(after.retained.file.text).toBe(after.retained.cachedText)
  expect(after.retained.digest).toMatch(/^sha256:[a-f0-9]{64}$/u)
  const path = new FileURL('../../.alchemy/goblin-skills-restart.json', import.meta.url)
  mkdirSync(new FileURL('./', path), { recursive: true })
  writeFileSync(path, JSON.stringify({ environment: 'local-workerd-do-restart', before, after }, null, 2))
}

/** MCP Events (signed Telegram delivery, replay, gaps, refresh and cleanup), a Source end to end and the skills cache. */
export const cases: readonly NativeCase[] = [
  matchCase(
    "a Source makes the owner's message a turn in its chat's own Topic, someone else's a notice, and answers once [canary]",
    'sources',
    (result) =>
      expect(result).toMatchObject({
        confirmed: 'active',
        received: 204,
        routes: [
          { route: 'topic', title: 'Trip planning', updatedBy: 'default' },
          { route: 'topic', title: 'Trip planning', updatedBy: 'default' },
        ],
        distinctTopics: true,
        secondTopic: 'Trip planning (2)',
        secondSettled: 'done',
        secondTurns: [{ author: true, words: 'Different chat, same title', files: [] }],
        topic: 'Trip planning',
        settled: 'done',
        turns: [
          {
            author: true,
            words: 'Book the ferry for Friday',
            files: [
              {
                path: expect.stringMatching(/^\/agent\/received\/[^/]+\/\d{4}-\d{2}-\d{2}\/image\.png$/u),
                mimeType: 'image/png',
              },
              {
                path: expect.stringMatching(/^\/agent\/received\/[^/]+\/\d{4}-\d{2}-\d{2}\/ferry\.md$/u),
                mimeType: 'text/markdown',
              },
            ],
          },
        ],
        stored: [
          { name: 'ferry.md', whole: true },
          { name: 'image.png', whole: true },
        ],
        noteKept: true,
        notice: { inTopic: true, titled: true },
        replies: [
          {
            chat: 'c1',
            text: expect.stringMatching(/^echo: /u),
            operationId: 'reply-0-source-src_00000000000000c1-m1',
          },
          {
            chat: 'c2',
            text: expect.stringMatching(/^echo: /u),
            operationId: 'reply-0-source-src_00000000000000c1-m4',
          },
        ],
      }),
  ),
  matchCase(
    'a Source drops foreign messages before creating or retitling its routes and Topics [canary]',
    'sources-drop',
    (result) =>
      expect(result).toEqual({
        routes: [{ key: '["c1"]', title: 'Trip planning' }],
        topics: ['Personal', 'Trip planning'],
        notices: 0,
      }),
  ),
  matchCase(
    'Events discovery, challenge, signed Telegram, replay, gap, refresh, termination and cleanup [canary]',
    'events',
    (result) =>
      expect(result).toMatchObject({
        discovered: true,
        received: 204,
        replayed: 204,
        bad: 400,
        old: 400,
        operations: ['telegram-tg-123', 'telegram-tg-124'],
        waiting: true,
        runs: {
          channel: [
            { kind: 'channel.received', status: 'ok', operationId: 'telegram-tg-123', message: 'tg:123' },
            { kind: 'channel.received', status: 'ok', operationId: 'telegram-tg-124', message: 'tg:124' },
            { kind: 'channel.reply', status: 'ok', operationId: 'telegram-tg-123', delivery: 'sent' },
          ],
          inbox: expect.any(Number),
        },
        refreshedEarly: true,
        terminated: 'terminated',
        cleanup: { retired: true, remoteCleanup: true },
        remainingRemote: 0,
        pollRecovered: true,
        sharedPreserved: true,
        scheduledRecovery: true,
        skills: { first: true, second: true, retained: true, dirty: 1, replayDirty: 1, refreshed: 1, terminated: true },
        recovery: { interrupted: true, pendingRetained: true, accepted: true, stableOperation: true, processed: true },
      }),
  ),
  probeCase(
    'a corrupted skill cache row is rejected, refetched and repaired',
    'skills-cache',
    SkillsCache,
    (result) => {
      expect(result.firstBody).toContain('# Cache test')
      expect(result.secondBody).toContain('# Cache test')
      expect(result.reads).toBe(2)
      expect(result.repaired).toBe(true)
    },
  ),
  probeCase(
    "a learner's improvement is written to the owner's files once, naming the skill it improves",
    'skills-draft',
    SkillsLearnerDraft,
    (result) =>
      expect(result).toEqual({
        first: 'drafted',
        second: 'duplicate',
        files: ['/agent/skills/drafts/draft-proof.md'],
        notices: [
          'Drafted an improvement to the skill "draft-proof", for you to review: /agent/skills/drafts/draft-proof.md',
        ],
        rows: [
          {
            connectionId: 'library',
            name: 'draft-proof',
            baseUri: 'skill://skv_222222222222222222222222/draft-proof/SKILL.md',
          },
        ],
      }),
  ),
  { title: 'skill activation and verified bytes survive a Durable Object restart', run: skillsRestartChecks },
]
