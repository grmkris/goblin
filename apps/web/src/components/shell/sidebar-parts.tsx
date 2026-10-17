// The sidebar's shared parts (ADR 0078): whether it shows as its strip, which row shows where the page is, a row's name
// beside it in the strip, a count, and a section that folds.
import { type ReactElement, type ReactNode, createContext, use } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@goblin/ui'
import { ChevronRightIcon } from 'lucide-react'
import type { Highlight, NavRow } from '../../lib/nav-highlight.ts'
import { useFolded } from './sidebar-state.ts'

/**
 * Every sidebar link is active only on its exact place: the router marks an active link the page itself, and its own
 * prefix match would mark a channel while its thread shows and Connections while a server's App shows.
 */
export const EXACT = { exact: true } as const

/** Whether the sidebar shows as its strip of icons: on a desktop, once the owner collapsed it. */
export const Strip = createContext(false)
/** The row that shows where the page is. */
export const Here = createContext<Highlight | undefined>(undefined)

/** The `aria-current` of `row`: the page, holding the page, or nothing. */
export function useCurrent(row: NavRow): 'page' | 'true' | undefined {
  const here = use(Here)
  return here?.row === row ? here.current : undefined
}

/** A row's name beside it while the sidebar is a strip of icons; nothing while the names show. */
export function Tip({ label, children }: { readonly label: string; readonly children: ReactElement }) {
  const strip = use(Strip)
  return (
    <Tooltip disabled={!strip}>
      <TooltipTrigger render={children} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/** A count at a row's end (on its icon in the strip), and the same for a screen reader in words. */
export function Count({ count, words }: { readonly count: number; readonly words: string }) {
  if (count <= 0) return null
  return (
    <>
      <span className="sidebar-count" aria-hidden>
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">
        , {count} {words}
      </span>
    </>
  )
}

/** A section of the sidebar: a label that folds it, an action at its end, and its rows. */
export function Section({
  id,
  label,
  action,
  children,
}: {
  readonly id: string
  readonly label: string
  readonly action?: ReactNode
  readonly children: ReactNode
}) {
  const [folded, toggle] = useFolded(id)
  return (
    <section className="sidebar-section" aria-label={label} data-section={id}>
      <div className="sidebar-section-head">
        <button type="button" className="sidebar-section-toggle" aria-expanded={!folded} onClick={toggle}>
          <ChevronRightIcon aria-hidden />
          {label}
        </button>
        {action}
      </div>
      {!folded && <ul className="sidebar-rows">{children}</ul>}
    </section>
  )
}
