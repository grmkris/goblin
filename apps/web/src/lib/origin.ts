import { createIsomorphicFn } from '@tanstack/react-start'
import { getRequestUrl } from '@tanstack/react-start/server'

/**
 * This deployment's own origin (ADR 0064): its `APP_URL`, which every page request is on, since the canonical redirect
 * (`@goblin/runtime/canonical`) sends any other host there first. The request's on the server, the page's in the
 * browser, so both render the same. For routes only: it needs Start's compiler, which the component fixtures lack.
 */
export const deploymentOrigin = createIsomorphicFn()
  .server(() => getRequestUrl().origin)
  .client(() => window.location.origin)
