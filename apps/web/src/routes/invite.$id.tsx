import { createFileRoute } from '@tanstack/react-router'
import { Invitation } from '../components/invitation.tsx'

/** An invitation's link (ADR 0093): a person's own page, outside any workspace. */
export const Route = createFileRoute('/invite/$id')({ component: InvitePage })
function InvitePage() {
  const { id } = Route.useParams()
  return <Invitation id={id} />
}
