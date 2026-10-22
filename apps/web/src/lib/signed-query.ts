/**
 * The page's query as the server sent it, read once as the app starts, before the router reads it: the router
 * writes repeated keys back as one JSON value, and the authorization server signs its consent query with repeated
 * keys (`ba_param`). The consent posts this one (`oauth_query`), so its signature still holds.
 */
export const SIGNED_QUERY: string = typeof window === 'undefined' ? '' : window.location.search.replace(/^\?/u, '')
