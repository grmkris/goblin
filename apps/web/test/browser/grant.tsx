import { createRoot } from 'react-dom/client'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import type { WorkspaceView } from '@goblin/contracts'
import { ClientsCard } from '../../src/components/account-cards.tsx'
import { DeveloperAppsCard, InstalledAppsCard } from '../../src/components/apps-cards.tsx'
import { Consent } from '../../src/components/consent.tsx'
import { Install } from '../../src/components/install.tsx'
import { Widen } from '../../src/components/widen.tsx'
import { parseWiden } from '../../src/lib/widen.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

// The app's theme script is not on a fixture page: follow the colour scheme the browser asks for.
document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)

/** The workspace Settings is in, its person its owner. */
const ACME: WorkspaceView = { id: 'ws_acme', name: 'Acme', slug: 'acme', role: 'owner', members: 2 }

/**
 * The screens that edit a grant (ADRs 0114, 0118) and the widening page, from source, by `?screen=`: Settings' MCP
 * clients and apps as the settings page lays them out, and the consent, install and widening pages as a person's own
 * pages.
 */
function Screen() {
  const search = new URLSearchParams(location.search)
  const screen = search.get('screen')
  // Where an approved consent sends the browser back to its client.
  if (screen === 'done') return <p>Back at the client.</p>
  if (screen === 'apps')
    return (
      <main className="shell">
        <div className="page-stack">
          <InstalledAppsCard workspace={ACME} />
          <DeveloperAppsCard workspace={ACME} />
        </div>
      </main>
    )
  if (screen === 'install')
    return (
      <main className="shell">
        <Install clientId={search.get('client_id') ?? ''} />
      </main>
    )
  if (screen === 'clients')
    return (
      <main className="shell">
        <div className="page-stack">
          <ClientsCard />
        </div>
      </main>
    )
  return (
    <main className="shell">
      {screen === 'widen' ? <Widen search={parseWiden(Object.fromEntries(search))} /> : <Consent />}
    </main>
  )
}

const route = createRootRoute({ component: Screen })
const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<RouterProvider router={router} />))
