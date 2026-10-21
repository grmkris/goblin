import { createFileRoute, useRouterState } from '@tanstack/react-router'
import { Authentication } from '../components/authentication.tsx'

/**
 * Better Auth's login page for MCP client authorization; plain sign-in otherwise, which opens the app, or first-run
 * Start's welcome (ADR 0062) for an account just created. A sign-in through the deployment's provider (ADR 0064) that
 * did not finish comes back here with Better Auth's `error`.
 */
export const Route = createFileRoute('/login')({ component: Login })
function Login() {
  // `?new=1` (the landing's Meet your goblin) opens on creating an account. Read from the raw query, untouched: an
  // MCP client's authorization arrives here with Better Auth's signed query, which must reach it as it was sent.
  const query = useRouterState({ select: (state) => state.location.searchStr })
  const search = new URLSearchParams(query)
  return (
    <Authentication
      creating={search.get('new') === '1'}
      providerError={search.get('error') ?? undefined}
      onAuthenticated={(created) => window.location.assign(created ? '/?welcome=1' : '/')}
    />
  )
}
