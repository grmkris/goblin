import { PRIMARY_CHAT } from '@goblin/contracts'
import { drizzle } from 'drizzle-orm/durable-sqlite'
import { Schema } from 'effect'
import { expect } from 'vitest'
import { chatSession, operationSession } from '../../src/chats/directory.ts'
import { unwrap } from '../../src/http/rpc.ts'
import { clientSendResult, sendStatusResult } from '../caller-client.ts'
import { type NativeCase, probeOf } from './native-case.ts'
import { type Inside, type Probes, inAgent } from './probe.ts'
import { ownerSend } from './probe-reads.ts'

/** The owner's send, a client's send and its status read on main, with where each landed in Pi. */
async function primaryProfileProbe({ agent, api, storage, harness }: Inside) {
  const operationId = 'permuted-primary-proof'
  await ownerSend(api, PRIMARY_CHAT, 'prove the primary binding', operationId)
  const settled = await agent.settle(PRIMARY_CHAT, operationId)
  const db = drizzle(storage)
  const session = chatSession(db, PRIMARY_CHAT)
  unwrap(await clientSendResult(api, 'fixture-client', PRIMARY_CHAT, 'inbound binding proof', 'primary-inbound'))
  await agent.settle(PRIMARY_CHAT, 'primary-inbound')
  const inbound = unwrap(await sendStatusResult(api, PRIMARY_CHAT, 'primary-inbound'))
  return {
    session,
    inboundStatus: inbound.status,
    inboundSession: operationSession(db, PRIMARY_CHAT, 'primary-inbound'),
    recentInbound: JSON.stringify(await harness.messages({ session })).includes('inbound binding proof'),
    settledSession: settled.session,
    rootMessages: (await harness.messages({ session: '1' })).length,
    primaryMessages: (await harness.messages({ session })).length,
  }
}

export const probes: Probes = { 'primary-profile': inAgent(primaryProfileProbe) }

const Proof = Schema.Struct({
  session: Schema.String,
  settledSession: Schema.String,
  rootMessages: Schema.Number,
  primaryMessages: Schema.Number,
  inboundStatus: Schema.String,
  inboundSession: Schema.String,
  recentInbound: Schema.Boolean,
})

/** Owner admission, a client's send and its status read all follow chat 1's non-root Pi binding. */
async function primaryBindingChecks(base: string): Promise<void> {
  const result = await probeOf(base, 'primary-profile', Proof, 'primary-proof')
  expect(result.session).not.toBe('1')
  expect(result.settledSession).toBe(result.session)
  expect(result.inboundStatus).toBe('answered')
  expect(result.inboundSession).toBe(result.session)
  expect(result.recentInbound).toBe(true)
  expect(result.rootMessages).toBe(0)
  expect(result.primaryMessages).toBeGreaterThan(0)
}

/** The permuted profile's own case: it runs only when main is bound to a non-root Pi session. */
export const permutedCases: readonly NativeCase[] = [
  { title: 'the stable primary chat writes only to its non-root Pi session', run: primaryBindingChecks },
]
