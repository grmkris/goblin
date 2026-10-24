import { writeFileSync } from 'node:fs'
import { Schema } from 'effect'
import { expect } from 'vitest'
import type { NativeService } from '../native-service.ts'
import { durableSource } from '../../src/agent-apps/dquickts/source.ts'
import { probeOf } from './native-case.ts'

const initial = {
  run: 'fixture',
  fuel: 1000000000,
  cpuBudgetMs: 500,
  input: durableSource("const state = {n:40}; state.n += tools.call('fixture','lookup',{}); return state"),
}
async function guards(service: NativeService) {
  expect((await service.call('eval', initial, false)).status).toBe(401)
  expect((await service.call('eval', { ...initial, build: 'foreign' })).status).toBe(400)
  const { answer } = await service.call('eval', initial)
  expect(answer.status).toBe(1)
  if (!answer.snapshot) throw new Error('snapshot missing')
  for (const snapshot of [
    { ...answer.snapshot, delta: 'AAAA' },
    { ...answer.snapshot, build: 'foreign' },
    { ...answer.snapshot, cpuUsedUs: 0 },
    { ...answer.snapshot, run: 'another-run' },
  ]) {
    expect((await service.call('resume', { ...initial, snapshot, input: '{"ok":true,"value":2}' })).status).toBe(400)
  }
  const resumed = await service.call('resume', {
    ...initial,
    snapshot: answer.snapshot,
    input: '{"ok":true,"value":2}',
  })
  expect(JSON.parse(resumed.answer.output ?? '')).toMatchObject({ value: { n: 42 } })
}
async function isolation(service: NativeService) {
  const network = await service.call('network', initial)
  const memory = await service.call('memory', initial)
  expect(JSON.parse(network.answer.output ?? '')).toMatchObject({ value: { errno: 1 } })
  expect(JSON.parse(memory.answer.output ?? '')).toMatchObject({ value: { errno: 12 } })
  const bomb = await service.call('eval', { ...initial, input: 'new ArrayBuffer(1024 * 1024 * 1024)' })
  expect(bomb.answer).toMatchObject({ ok: true, status: -1, output: expect.stringContaining('out of memory') })
  const wall = await service.call('wall', { ...initial, wallMs: 50 })
  expect(wall.answer).toMatchObject({ ok: false, error: expect.stringContaining('wall limit'), signal: 14 })
  writeFileSync('../../.local/native/isolation.json', JSON.stringify({ network, memory, bomb, wall }, null, 2))
}
async function cpu(service: NativeService, url: string) {
  const samples = []
  const input = "(function(){for(let i=0;i<4;i++) hostCall('tick',{}); while(true){}})()"
  let answer = (await service.call('eval', { ...initial, input, cpuBudgetMs: 100 })).answer
  samples.push(answer)
  let boundaries = 0
  while (answer.ok && answer.snapshot) {
    boundaries += 1
    answer = (
      await service.call('resume', {
        ...initial,
        snapshot: answer.snapshot,
        input: 'null',
        remainingCpuMs: answer.remainingCpuMs,
      })
    ).answer
    samples.push(answer)
  }
  expect(boundaries).toBe(4)
  expect(answer).toMatchObject({ ok: false, error: expect.stringContaining('CPU limit'), signal: 27 })
  expect(samples.reduce((n, value) => n + (value.cpuMs ?? 0), 0)).toBeLessThanOrEqual(100)
  const worker = await probeOf(url, 'native-code-cpu', Schema.Unknown)
  expect(worker).toMatchObject({
    calls: 4,
    remaining: 0,
    result: { ok: false, error: expect.stringContaining('CPU limit') },
    again: { ok: false, error: expect.stringContaining('CPU limit') },
  })
  // Snapshot bytes and MACs are fixture-only, but the timing receipt needs only counters.
  writeFileSync(
    '../../.local/native/cpu.json',
    JSON.stringify(
      {
        worker,
        samples: samples.map(({ cpuMs, remainingCpuMs, signal, error }) => ({ cpuMs, remainingCpuMs, signal, error })),
      },
      null,
      2,
    ),
  )
}
async function latency(service: NativeService) {
  const samples = []
  for (let i = 0; i < 9; i += 1) {
    const start = performance.now()
    const evaluated = (await service.call('eval', initial)).answer
    const evalHttpMs = performance.now() - start
    if (!evaluated.snapshot) throw new Error('snapshot missing')
    const snapshotStart = performance.now()
    const snap = (await service.call('snapshot', { ...initial, snapshot: evaluated.snapshot })).answer
    const snapshotHttpMs = performance.now() - snapshotStart
    if (!snap.snapshot) throw new Error('snapshot missing')
    const restoreStart = performance.now()
    const restored = (await service.call('restore', { ...initial, snapshot: snap.snapshot })).answer
    const restoreHttpMs = performance.now() - restoreStart
    if (!restored.snapshot) throw new Error('snapshot missing')
    const resumeStart = performance.now()
    const resumed = (
      await service.call('resume', { ...initial, snapshot: restored.snapshot, input: '{"ok":true,"value":2}' })
    ).answer
    expect(JSON.parse(resumed.output ?? '')).toMatchObject({ value: { n: 42 } })
    samples.push({
      evalHttpMs,
      snapshotHttpMs,
      restoreHttpMs,
      resumeHttpMs: performance.now() - resumeStart,
      evalTiming: evaluated.timing,
      snapshotTiming: snap.timing,
      resumeTiming: resumed.timing,
      baseBytes: Buffer.byteLength(evaluated.snapshot.base, 'base64'),
      deltaBytes: Buffer.byteLength(evaluated.snapshot.delta, 'base64'),
      cpuMs: resumed.cpuUsedMs,
    })
  }
  writeFileSync('../../.local/native/latency.json', JSON.stringify({ samples }, null, 2))
}
async function responsiveness(_service: NativeService, url: string) {
  const result = await probeOf(url, 'native-code-blocked', Schema.Unknown)
  expect(result).toMatchObject({
    samples: Array.from({ length: 10 }, () => ({ result: { ok: true, value: 499999500000 } })),
  })
  writeFileSync('../../.local/native/blocked.json', JSON.stringify(result, null, 2))
  expect(await probeOf(url, 'native-code-down', Schema.Unknown)).toMatchObject({
    ok: false,
    error: 'native service unavailable',
  })
}
export const nativeCases: readonly {
  readonly title: string
  readonly run: (service: NativeService, url: string) => Promise<void>
}[] = [
  { title: 'auth, snapshot MAC, build/run binding and intact state', run: guards },
  { title: 'seccomp sockets, kernel address space, memory bomb and wall kill', run: isolation },
  { title: 'kernel CPU budget across four suspended calls and SQLite accounting', run: cpu },
  { title: 'eval / snapshot / restore / resume latency receipts', run: latency },
  { title: 'agent heartbeat delay versus WASM and clean service-down failure', run: responsiveness },
]
