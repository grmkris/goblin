import { expect, it } from 'vitest'
import { routineSummary } from '../src/routines/summary.ts'

it('keeps JSON whole: public token fields, credential-named fields and a link followed by more fields', () => {
  const payload = JSON.stringify({
    rewardToken: '0x123',
    token: '0x456',
    outputs: { shareUrl: 'https://media.test/f/a.mp4?t=T0k3n', sha256: 'abc' },
    accessToken: 'as-sent',
  })
  expect(routineSummary(payload)).toBe(payload)
})

it('keeps links and credential-shaped text as written (ADR 0104)', () => {
  const text =
    'Done: https://owner:pw@media.test/f/a.mp4?t=T0k3n#t=3\nBearer sample-token\napi_key=sample-key\nwhsec_sample-key'
  expect(routineSummary(text)).toBe(text)
})

it('strips terminal and bidi controls and bounds the stored summary', () => {
  expect(routineSummary(' Useful\u0000\u001b[31m result‮⁦\n ')).toBe('Useful[31m result')
  expect(routineSummary('x'.repeat(5000))).toHaveLength(1600)
})
