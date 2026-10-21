import { createFileRoute, redirect, useRouterState } from '@tanstack/react-router'
import { PRIMARY_CHAT } from '@goblin/contracts'
import { createServerOnlyFn } from '@tanstack/react-start'
import { getCookie } from '@tanstack/react-start/server'
import { useSession } from '../auth/hooks.ts'
import { Landing } from '../components/landing/landing.tsx'
import { OpenWorkspace } from '../components/open-workspace.tsx'
import { sessionQuery } from '../auth/queries.ts'
import { lastChannel } from '../lib/last-channel.ts'
import { hasSessionCookie } from '../lib/home.ts'
import { deploymentOrigin } from '../lib/origin.ts'
import { workspaceOf } from '../lib/workspace-path.ts'

const TITLE = 'goblin: your own agent, always on'
const DESCRIPTION =
  "Your own goblin, always on. A personal agent that keeps working while you're away, uses only the tools you allow, and asks before it spends."

/** On the server: whether the request carries Better Auth's session cookie. */
const requestHasSession = createServerOnlyFn(() => hasSessionCookie(getCookie))

/**
 * Home. In a workspace (`/w/<slug>/`, ADR 0089) it opens the channel this tab showed last there (its first channel at
 * first); `OwnerGate` on that page asks a signed-out visitor to sign in. At the deployment's own `/`, a signed-in person
 * opens a workspace (`OpenWorkspace`) and a visitor who is signed out gets goblin's landing page. The server decides
 * signed in from the session cookie, before any page is drawn; in the browser, the session as the cache knows it.
 * Neither grants anything.
 */
export const Route = createFileRoute('/')({
  beforeLoad: ({ context, location }) => {
    const server = typeof window === 'undefined'
    if (workspaceOf(new URL(location.publicHref, 'https://goblin.invalid').pathname) !== undefined)
      // The server cannot know the tab's last channel, so it opens the first.
      throw redirect({
        to: '/c/$chatId',
        params: { chatId: server ? PRIMARY_CHAT : lastChannel() },
        statusCode: 307,
      })
    // In the browser this never waits on the network, so the page it hydrates is never held up: the session the cache
    // already knows decides here, and a check still under way decides when it ends.
    const signedIn = server
      ? requestHasSession()
      : context.queryClient.getQueryData(sessionQuery.queryKey) === 'signed-in'
    return { signedIn }
  },
  head: () => {
    // The deployment's own address, whoever deploys it.
    const origin = deploymentOrigin()
    const canonical = `${origin}/`
    const image = `${origin}/og.png`
    return {
      meta: [
        { title: TITLE },
        { name: 'description', content: DESCRIPTION },
        { property: 'og:type', content: 'website' },
        { property: 'og:site_name', content: 'goblin' },
        { property: 'og:url', content: canonical },
        { property: 'og:title', content: TITLE },
        { property: 'og:description', content: DESCRIPTION },
        { property: 'og:image', content: image },
        { property: 'og:image:width', content: '1200' },
        { property: 'og:image:height', content: '630' },
        { property: 'og:image:alt', content: 'goblin: your own goblin, always on.' },
        { name: 'twitter:card', content: 'summary_large_image' },
        { name: 'twitter:site', content: '@goblin_surf' },
        { name: 'twitter:title', content: TITLE },
        { name: 'twitter:description', content: DESCRIPTION },
        { name: 'twitter:image', content: image },
      ],
      links: [{ rel: 'canonical', href: canonical }],
    }
  },
  component: Home,
})

/**
 * The landing on the deployment's own origin, which the server reads from its request (`lib/origin.ts`), for a visitor
 * who is signed out; a signed-in person's workspace opens instead (`?welcome=1` on Start, for an account just made).
 */
function Home() {
  const { signedIn } = Route.useRouteContext()
  const { state } = useSession()
  const welcome = useRouterState({ select: (router) => new URLSearchParams(router.location.searchStr).get('welcome') })
  if (state === 'signed-in' || (state === 'checking' && signedIn)) return <OpenWorkspace welcome={welcome === '1'} />
  return <Landing origin={deploymentOrigin()} />
}
