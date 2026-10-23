import { createRoot } from 'react-dom/client'
import { TrustedWorkloadsCard } from '../../src/components/trusted-workloads-card.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
const root = document.getElementById('root')
if (root)
  createRoot(root).render(
    withQueryClient(
      <main className="shell">
        <div className="page-stack">
          <TrustedWorkloadsCard />
        </div>
      </main>,
    ),
  )
