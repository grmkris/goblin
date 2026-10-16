import { createRoot } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { Connections } from '../../src/components/connections.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
const route = createRootRoute({
  component: () => (
    <main className="shell connections-shell">
      <Connections />
    </main>
  ),
})
const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<RouterProvider router={router} />))
