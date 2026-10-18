import { createRoot } from 'react-dom/client'
import { NOTHING } from '@goblin/contracts'
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
      {
        conversations: [],
        activity: [],
        apps: [],
        personas: [
          {
            id: 7,
            name: 'Planner',
            avatar: { glyph: 'P', hue: 200 },
            role: 'Plan my day',
            instructions: '',
            setup: NOTHING,
            revision: 3,
            createdAt: 1,
            updatedAt: 1,
          },
        ],
      },
    ),
  )
