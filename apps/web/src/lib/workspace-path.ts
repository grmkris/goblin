import type { LocationRewrite } from '@tanstack/react-router'

/**
 * Which workspace a page is in (ADR 0089): its address says, as `/w/<slug>/…`. The router sees a workspace's pages
 * without the prefix (`/c/12`), so every route and link stays as it is, and this module puts the prefix back on
 * the way out and in front of every API call the page makes. A person's own pages (sign-in, consent, the policies)
 * and the home that opens a workspace are outside any.
 */

/** A workspace's prefix: its slug (lowercase letters, digits and hyphens), then its page's path. */
const PREFIX = /^\/w\/([a-z0-9-]{1,64})(?=\/|$)(.*)$/u

/** The pages that belong to a person, not a workspace: never prefixed. */
const PERSON_PAGES = ['/login', '/consent', '/invite', '/terms', '/privacy'] as const

const isPersonPage = (path: string): boolean =>
  PERSON_PAGES.some((page) => path === page || path.startsWith(`${page}/`))

/** The workspace slug and the page's path within it, when `pathname` is a workspace's. */
export const workspaceOf = (pathname: string): { readonly slug: string; readonly path: string } | undefined => {
  const [, slug, rest = ''] = PREFIX.exec(pathname) ?? []
  return slug === undefined ? undefined : { slug, path: rest === '' ? '/' : rest }
}

/** The address of `path` in the workspace at `slug`. */
export const inWorkspace = (slug: string, path = '/'): string => `/w/${slug}${path === '/' ? '/' : path}`

/** The slug of the workspace this page is in; none on a person's own page or on the server. */
export const currentSlug = (): string | undefined =>
  typeof window === 'undefined' ? undefined : workspaceOf(window.location.pathname)?.slug

/**
 * An API path as this page calls it: a member's, under its workspace (`/w/<slug>/api/…`); the person's own
 * (`/api/workspaces`, `/api/client-errors`, `/api/auth/…`) as they are.
 */
export const apiPath = (path: string): string => {
  const slug = currentSlug()
  return slug === undefined ? path : `/w/${slug}${path}`
}

/**
 * The router's view of addresses: a workspace's prefix comes off on the way in, remembered, and goes back on every
 * address it builds for one of that workspace's pages. One per router, so a server rendering one request keeps its
 * own.
 */
export const workspaceRewrite = (): LocationRewrite => {
  let slug: string | undefined
  return {
    input: ({ url }) => {
      const found = workspaceOf(url.pathname)
      slug = found?.slug
      if (found === undefined) return undefined
      const inner = new URL(url)
      inner.pathname = found.path
      return inner
    },
    output: ({ url }) => {
      if (slug === undefined || isPersonPage(url.pathname) || workspaceOf(url.pathname) !== undefined) return undefined
      const outer = new URL(url)
      outer.pathname = inWorkspace(slug, url.pathname)
      return outer
    },
  }
}

/** A browser storage key for something kept per workspace: this page's workspace's, or the person's. */
export const workspaceKey = (name: string): string => {
  const slug = currentSlug()
  return slug === undefined ? `goblin:${name}` : `goblin:${slug}:${name}`
}
