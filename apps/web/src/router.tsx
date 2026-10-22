import { QueryClientProvider } from '@tanstack/react-query'
import { createRouter } from '@tanstack/react-router'
import { makeQueryClient } from './lib/query/api-query.ts'
import { ReportedRouteError } from './lib/query/route-error.tsx'
import { reportUnexpected } from './lib/unexpected.ts'
// Read before the router exists: it rewrites the consent page's signed query (`signed-query.ts`).
import './lib/signed-query.ts'
import { workspaceRewrite } from './lib/workspace-path.ts'
import { routeTree } from './routeTree.gen'

/**
 * One router, and one QueryClient with it, per call: on the server per request, never shared through module state
 * (myapps ADR 0013). It sees a workspace's pages without their `/w/<slug>` prefix and puts it back on every address it
 * builds (`workspaceRewrite`, ADR 0089), so one page load is one workspace's. An owner request that finds the session
 * gone clears the cache and goes to sign-in. A route that fails shows the calm error view with its reference, and a
 * defect is reported as a crash.
 */
export function getRouter() {
  const queryClient = makeQueryClient({
    onUnauthenticated: () => {
      queryClient.clear()
      router.navigate({ to: '/login' }).catch(reportUnexpected)
    },
  })
  const router = createRouter({
    routeTree,
    rewrite: workspaceRewrite(),
    context: { queryClient },
    scrollRestoration: true,
    scrollToTopSelectors: ['.start-content'],
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: ReportedRouteError,
    Wrap: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>,
  })
  return router
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
  }
}
