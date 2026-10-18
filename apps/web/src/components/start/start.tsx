// First-run Start (ADR 0062): one task per screen, on the sidebar's own green, which the owner may pass by or skip; the
// app never waits for it. The panel lists the steps (each a link; a sign-in Start began comes back to its step), and on
// a phone narrows to a band with a count and one segment per step; the task says why and offers one action. Finishing
// narrows the panel into the sidebar as the chat appears: the one motion of the page.
import { useMutation, useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from '@tanstack/react-router'
import { ONBOARDING_STEPS, PRIMARY_CHAT, type OnboardingStep, type OnboardingView } from '@goblin/contracts'
import { Button, GoblinMark, Receipt } from '@goblin/ui'
import { CheckIcon, CircleAlertIcon } from 'lucide-react'
import { useState } from 'react'
import { clearStartDraft, useStartDraft } from '../../onboarding/draft.ts'
import { describeError, messageOf } from '../../lib/query/app-error.ts'
import { reportUnexpected } from '../../lib/unexpected.ts'
import { changeOnboardingMutation, kickoffMutation, onboardingQuery } from '../../onboarding/queries.ts'
import { GoblinStep, ModelStep, STEP_TEXT, ServicesStep, WelcomeStep } from './steps.tsx'

/** How a sign-in Start began came back (the callback's own words): connected, or why not. */
export type StartSearch = { readonly connected?: string; readonly error?: string; readonly ref?: string }

/** How long the panel takes to become the sidebar (`--start-leave` in start.css). */
const LEAVE_MS = 320

/** Opens the chat, after the panel has narrowed into the sidebar (at once when the owner asks for less motion). */
function useLeave(): { readonly leaving: boolean; readonly leave: (chat?: string) => void } {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const leave = (chat: string = PRIMARY_CHAT) => {
    const go = () => {
      navigate({ to: '/c/$chatId', params: { chatId: chat } }).catch(reportUnexpected)
    }
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return go()
    setLeaving(true)
    window.setTimeout(go, LEAVE_MS)
  }
  return { leaving, leave }
}

/** Whether step `id` is done, once Start's state is read. */
const isDone = (view: OnboardingView | undefined, id: OnboardingStep): boolean =>
  view?.steps.find((each) => each.id === id)?.done === true

/** The step list on the panel: done, here, or still to do, each a link. */
function StepList({ view, step }: { readonly view: OnboardingView | undefined; readonly step: OnboardingStep }) {
  return (
    <ol className="start-steps">
      {ONBOARDING_STEPS.map((id, index) => {
        const done = isDone(view, id)
        return (
          <li key={id}>
            <Link
              to="/start/$step"
              params={{ step: id }}
              className="start-step"
              // The router marks the active link `aria-current="page"` itself; the step Start is on is marked here.
              {...(id === step ? { 'data-current': true } : {})}
              {...(done ? { 'data-done': true } : {})}
            >
              <span className="start-step-mark" aria-hidden>
                <CheckIcon className="start-step-check" />
                <span className="start-step-number">{index + 1}</span>
              </span>
              <span>{STEP_TEXT[id].label}</span>
              {done && <span className="sr-only"> (done)</span>}
            </Link>
          </li>
        )
      })}
    </ol>
  )
}

/** On a phone: one segment per step, filled once done, marked where the owner is. The count says it in words. */
function StepSegments({ view, step }: { readonly view: OnboardingView | undefined; readonly step: OnboardingStep }) {
  return (
    <ol className="start-segments" aria-hidden>
      {ONBOARDING_STEPS.map((id) => (
        <li
          key={id}
          {...(id === step ? { 'data-current': true } : {})}
          {...(isDone(view, id) ? { 'data-done': true } : {})}
        />
      ))}
    </ol>
  )
}

/** The green panel: goblin's mark, the steps (a count and its segments on a phone), and the way out. */
function StartPanel({
  view,
  step,
  onSkip,
}: {
  readonly view: OnboardingView | undefined
  readonly step: OnboardingStep
  readonly onSkip: () => void
}) {
  const index = ONBOARDING_STEPS.indexOf(step)
  return (
    <aside className="start-panel" aria-label="Setting up goblin">
      <div className="start-brand">
        <span className="start-mark">
          <GoblinMark />
        </span>
        <span className="start-brand-name">Set up goblin</span>
      </div>
      <StepList view={view} step={step} />
      <p className="start-count">
        <span className="start-count-of">
          {index + 1} of {ONBOARDING_STEPS.length}
        </span>
        <span>{STEP_TEXT[step].label}</span>
      </p>
      <StepSegments view={view} step={step} />
      <button type="button" className="start-skip" onClick={onSkip}>
        Skip setup
      </button>
    </aside>
  )
}

/**
 * A sign-in Start began that did not finish, said once on the step it returned to. One that did is the services step's
 * own to show, with the server's suggested access.
 */
function ReturnNotice({ search }: { readonly search: StartSearch }) {
  if (search.error === undefined) return null
  return (
    <Receipt tone="error">
      <CircleAlertIcon aria-hidden />
      <span>
        The sign-in did not finish ({search.error}){search.ref === undefined ? '' : ` · ref ${search.ref.slice(0, 8)}`}.
        Try again.
      </span>
    </Receipt>
  )
}

/** Whether the agent has a model to answer with: the model step and the kickoff wait for one. */
const hasModel = (view: OnboardingView | undefined): boolean => view !== undefined && view.model.source !== 'none'

/**
 * Back and Continue move through setup. Model setup waits for a configured endpoint; services remain optional.
 * The welcome has its own button, and the last step can finish without sending the first message.
 */
function StartNav({
  step,
  view,
  finishing,
  onNext,
  onFinish,
}: {
  readonly step: OnboardingStep
  readonly view: OnboardingView | undefined
  readonly finishing: boolean
  readonly onNext: () => void
  readonly onFinish: () => void
}) {
  const navigate = useNavigate()
  if (step === 'welcome') return null
  const back = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) - 1]
  const next =
    step === 'goblin' ? (
      <Button variant="ghost" disabled={finishing} onClick={onFinish}>
        Finish without it
      </Button>
    ) : (
      <Button disabled={step === 'model' && !hasModel(view)} onClick={onNext}>
        Continue
      </Button>
    )
  return (
    <footer className="start-nav">
      {back === undefined ? (
        <span />
      ) : (
        <Button
          variant="ghost"
          disabled={finishing}
          onClick={() => {
            navigate({ to: '/start/$step', params: { step: back } }).catch(reportUnexpected)
          }}
        >
          Back
        </Button>
      )}
      {next}
    </footer>
  )
}

/** Start's flow: going through a step, the kickoff, finishing without it, and skipping. */
function useStartFlow(step: OnboardingStep) {
  const read = useQuery(onboardingQuery)
  const view = read.data
  const navigate = useNavigate()
  const change = useMutation(changeOnboardingMutation)
  const kickoff = useMutation(kickoffMutation)
  const saved = useStartDraft()
  const { leaving, leave } = useLeave()
  const starting = kickoff.isPending || (change.isPending && change.variables?.status !== undefined)
  const next = () => {
    if (step === 'model' && !hasModel(view)) return
    change.mutate({ step })
    const following = ONBOARDING_STEPS[ONBOARDING_STEPS.indexOf(step) + 1]
    if (following !== undefined) navigate({ to: '/start/$step', params: { step: following } }).catch(reportUnexpected)
  }
  const start = () => {
    if (!hasModel(view)) {
      navigate({ to: '/start/$step', params: { step: 'model' } }).catch(reportUnexpected)
      return
    }
    const { goal, channel, operation } = saved.begin()
    kickoff.mutate(
      { goal: goal.trim(), channel: channel.trim(), operationId: operation },
      {
        onSuccess: ({ topic }) => {
          clearStartDraft()
          leave(topic.conversation)
        },
        // A refusal comes before the kickoff makes anything, so the draft may change. Any other failure may have made
        // the channel: the draft stays frozen under its operation, and a retry replays it.
        onError: (error) => {
          if (['conflict', 'validation'].includes(describeError(error).kind)) saved.rejected()
        },
      },
    )
  }
  const finish = () =>
    change.mutate(
      { status: 'done', step: 'goblin' },
      {
        onSuccess: () => {
          clearStartDraft()
          leave()
        },
      },
    )
  const skip = () => change.mutate({ status: 'skipped' }, { onSuccess: () => leave() })
  const failure = kickoff.error ?? change.error ?? read.error
  return { saved, view, starting, leaving, failure, next, start, finish, skip }
}

export function StartPage({ step, search }: { readonly step: OnboardingStep; readonly search: StartSearch }) {
  const { saved, view, starting, leaving, failure, next, start, finish, skip } = useStartFlow(step)
  const { draft } = saved
  return (
    <div className="start" aria-busy={starting} {...(leaving ? { 'data-leaving': true } : {})}>
      <div className="start-panel-wrap" inert={starting}>
        <StartPanel view={view} step={step} onSkip={skip} />
      </div>
      <section className="start-task" data-step={step} aria-labelledby="start-title">
        <div className="start-content">
          <header className="start-head">
            <h1 id="start-title">{STEP_TEXT[step].title}</h1>
            <p>{STEP_TEXT[step].why}</p>
          </header>
          <ReturnNotice search={search} />
          {step === 'welcome' && (
            <WelcomeStep
              goal={draft.goal}
              onChange={(goal) => saved.edit({ goal })}
              onPick={saved.pick}
              onContinue={next}
            />
          )}
          {step === 'model' && <ModelStep />}
          {step === 'services' && <ServicesStep connected={search.connected} featured={draft.groups} />}
          {step === 'goblin' && <GoblinStep draft={draft} onChange={saved.edit} pending={starting} onStart={start} />}
          {failure !== null && (
            <Receipt tone="error">
              <CircleAlertIcon aria-hidden />
              <span>{messageOf(failure, 'finish setting up')}</span>
            </Receipt>
          )}
        </div>
        <StartNav step={step} view={view} finishing={starting} onNext={next} onFinish={finish} />
      </section>
    </div>
  )
}
