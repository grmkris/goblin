import { createRoot } from 'react-dom/client'
import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from '@tanstack/react-router'
import { Landing } from '../../src/components/landing/landing.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** goblin's landing as `/` renders it for a visitor who is signed out. */
const root = createRootRoute({
  component: () => (
    <main className="landing-root">
      <Outlet />
    </main>
  ),
})
const home = createRoute({ getParentRoute: () => root, path: '/', component: Landing })
const router = createRouter({
  routeTree: root.addChildren([home]),
  history: createMemoryHistory({ initialEntries: ['/'] }),
})

const element = document.getElementById('root')
if (element) createRoot(element).render(withQueryClient(<RouterProvider router={router} />))
