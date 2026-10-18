import { createRoot } from 'react-dom/client'
import { WorkspacePlanCard } from '../../src/components/workspace-plan.tsx'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)
const element = document.getElementById('root')
if (element)
  createRoot(element).render(
    withQueryClient(
      <main className="mx-auto max-w-2xl p-4">
        <WorkspacePlanCard id={`wsp_${'a'.repeat(32)}`} />
      </main>,
    ),
  )
