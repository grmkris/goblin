import { createRoot } from 'react-dom/client'
import { useQuery } from '@tanstack/react-query'
import { ToolGrants } from '../../src/components/tool-grants.tsx'
import { toolsQuery } from '../../src/mcp/queries.ts'
import { withQueryClient } from './with-query-client.tsx'
import '../../src/styles.css'

function GrantsFixture() {
  const { data } = useQuery(toolsQuery('notes'))
  return <main className="p-4">{data && <ToolGrants connectionId="notes" tools={data} />}</main>
}

const root = document.getElementById('root')
if (root) createRoot(root).render(withQueryClient(<GrantsFixture />))
