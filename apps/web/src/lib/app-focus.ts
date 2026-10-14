/**
 * An App panel to open on, such as `add_funds` (letters and underscores only), as a page's search carries it: a
 * server's own App takes it as its tool's `focus` argument (ADR 0053).
 */
export const parseFocus = (search: Record<string, unknown>): { readonly focus?: string } =>
  typeof search['focus'] === 'string' && /^[a-z_]{1,32}$/u.test(search['focus']) ? { focus: search['focus'] } : {}
