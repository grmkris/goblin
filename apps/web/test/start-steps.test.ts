import { describe, expect, it } from 'vitest'
import { ONBOARDING_STEPS, type OnboardingView } from '@goblin/contracts'
import { firstOpenStep, stepsLeft } from '../src/onboarding/queries.ts'

/** Start's view with the steps in `done` done, on the deployment's models. */
const view = (status: OnboardingView['status'], done: readonly string[]): OnboardingView => ({
  status,
  steps: ONBOARDING_STEPS.map((id) => ({ id, done: done.includes(id) })),
  model: { source: 'deployment', deployment: true, models: ['house-model'] },
  connected: 0,
  kickoff: false,
})

const ids = (steps: OnboardingView['steps']) => steps.map((step) => step.id)

describe('where first-run Start picks up (ADR 0062)', () => {
  it('opens on the first step still to do, and on the welcome once all are done or before Start is read', () => {
    expect(firstOpenStep(view('open', []))).toBe('welcome')
    expect(firstOpenStep(view('skipped', ['welcome']))).toBe('model')
    expect(firstOpenStep(view('open', ['welcome', 'model', 'goblin']))).toBe('services')
    expect(firstOpenStep(view('done', ONBOARDING_STEPS))).toBe('welcome')
    expect(firstOpenStep(undefined)).toBe('welcome')
  })
})

describe("what Start's ways back count as left", () => {
  it('counts the model and services steps of an open or skipped Start, never the welcome or the kickoff', () => {
    expect(ids(stepsLeft(view('open', [])))).toEqual(['model', 'services'])
    expect(ids(stepsLeft(view('skipped', ['welcome', 'model'])))).toEqual(['services'])
    expect(stepsLeft(view('skipped', ['model', 'services']))).toEqual([])
  })

  it('counts nothing once the owner finished Start, whatever step was passed by', () => {
    expect(stepsLeft(view('done', []))).toEqual([])
  })
})
