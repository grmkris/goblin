import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { ONBOARDING_STEPS, type OnboardingStep } from '@goblin/contracts'
import { StartSplash } from '../../src/components/start/splash.tsx'
import { StartPage, type StartSearch } from '../../src/components/start/start.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

const isStep = (value: string): value is OnboardingStep => ONBOARDING_STEPS.some((step) => step === value)

/** First-run Start's page as `/start/$step` renders it, and the splash, on a memory router (`?at=/start/model`). */
const root = createRootRoute({
  component: () => (
    <main className="start-root">
      <Outlet />
    </main>
  ),
})
const step = createRoute({
  getParentRoute: () => root,
  path: '/start/$step',
  // A sign-in's return, as the app's route reads it (`?connected=notes`).
  validateSearch: (search: Record<string, unknown>): StartSearch =>
    typeof search['connected'] === 'string' ? { connected: search['connected'] } : {},
  component: function Step() {
    const { step: id } = step.useParams()
    return <StartPage step={isStep(id) ? id : 'welcome'} search={step.useSearch()} />
  },
})
const splash = createRoute({ getParentRoute: () => root, path: '/splash', component: StartSplash })
const channel = createRoute({
  getParentRoute: () => root,
  path: '/c/$chatId',
  component: function Destination() {
    return <p>Opened channel {channel.useParams().chatId}</p>
  },
})
const at = new URLSearchParams(location.search).get('at') ?? '/start/welcome'
const router = createRouter({
  routeTree: root.addChildren([step, splash, channel]),
  history: createMemoryHistory({ initialEntries: [at] }),
  scrollRestoration: true,
  scrollToTopSelectors: ['.start-content'],
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />))
