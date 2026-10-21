import { workspaceOf } from './workspace-path.ts'

const KEY = 'goblin:last-workspace'

/** The workspace this browser opened last, which home opens again: the person's first until one was opened. */
export function lastWorkspace(): string | undefined {
  try {
    return localStorage.getItem(KEY) ?? undefined
  } catch {
    // expected: storage is off in this browser (private mode, a policy), so home opens the first workspace
    return undefined
  }
}

/** Remembers the workspace this page is in, for home (a convenience: without storage home opens the first). */
export function rememberWorkspace(pathname: string): void {
  const slug = workspaceOf(pathname)?.slug
  if (slug === undefined) return
  try {
    localStorage.setItem(KEY, slug)
  } catch {
    // expected: storage is off or full, so home opens the first workspace instead
  }
}
