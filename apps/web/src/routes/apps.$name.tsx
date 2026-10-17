import { useQuery } from '@tanstack/react-query'
import { Link, createFileRoute, redirect } from '@tanstack/react-router'
import { agentAppQuery } from '../agent-apps/queries.ts'
import { AppManage } from '../components/app-manage.tsx'
import { OwnerGate } from '../components/owner-gate.tsx'
import { PageBar } from '../components/page-bar.tsx'
import { primeOwnerRead } from '../lib/prime.ts'

/** Managing one agent app (ADRs 0021, 0078), by its name: its page opens it, and changes and deletes it. */
export const Route = createFileRoute('/apps/$name')({
  beforeLoad: ({ params }) => {
    if (!/^[a-z][a-z0-9-]{1,23}$/u.test(params.name)) throw redirect({ to: '/apps' })
  },
  loader: ({ context, params }) => primeOwnerRead(context.queryClient, agentAppQuery(params.name)),
  component: AppRoute,
})
/** "Apps / Manage Trip tracker": the way back to Apps, and the app by its title once the page has read it. */
function ManageTitle({ name }: { readonly name: string }) {
  const title = useQuery(agentAppQuery(name)).data?.title ?? name
  return (
    <>
      <Link to="/apps" className="text-muted-foreground hover:text-foreground">
        Apps
      </Link>{' '}
      / Manage {title}
    </>
  )
}
function AppRoute() {
  const { name } = Route.useParams()
  return (
    <OwnerGate>
      <PageBar title={<ManageTitle name={name} />} />
      <div className="shell">
        <AppManage name={name} />
      </div>
    </OwnerGate>
  )
}
