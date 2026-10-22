import { PRIMARY_CHAT } from '@goblin/contracts'
import { expect } from 'vitest'
import { type NativeCase, probeCase } from './native-case.ts'
import { GATEWAY, type Names, OWN, Result } from './source-propose-probe.ts'

/** What the agent's own setup of a Source comes to, by the names `names` the connection lists. */
const expected = (names: Names) => (result: typeof Result.Type) =>
  expect(result).toMatchObject({
    activated: true,
    listed: {
      tools: [
        { name: names.read, outputSchema: true },
        { name: names.reply, outputSchema: true },
      ],
      event: true,
    },
    refused: true,
    afterRefusal: 0,
    proposed: { state: 'proposed', revision: 1, chat: PRIMARY_CHAT },
    confirmed: 'active',
    received: 204,
    topic: 'Trip planning',
    settled: 'done',
    turns: [{ author: true, words: 'Book the ferry for Friday' }],
    reply: {
      chat: 'c1',
      text: expect.stringMatching(/^echo: /u),
      operationId: expect.stringMatching(/^reply-0-source-src_[0-9a-f]+-m1$/u),
    },
    outcome: 'accepted',
    notices: 0,
  })

/** The agent's `source_propose` end to end (ADR 0096), by the app's own names and by a gateway's. */
export const cases: readonly NativeCase[] = [
  probeCase(
    'the agent sets a Source up from the server guide: refused without result rules, proposed with them, then a confirmed post is a turn whose answer is accepted with no notice [canary]',
    'source-propose',
    Result,
    expected(OWN),
  ),
  probeCase(
    'the agent sets the same Source up through a gateway by the names its connection lists',
    'source-propose-gateway',
    Result,
    expected(GATEWAY),
  ),
]
