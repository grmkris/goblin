import { type ReactNode, createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { Button, Drawer, DrawerDescription, DrawerSide, DrawerTitle, useIsMobile } from '@goblin/ui'
import { PanelLeftIcon } from 'lucide-react'
import { browserPlatform, isApple, isModShortcut } from '../../lib/shortcuts.ts'
import { Sidebar } from './sidebar.tsx'
import { toggleCollapsed, useNavCounts } from './sidebar-state.ts'

type Shell = {
  /** Opens the navigation drawer on a phone; on a desktop the sidebar always shows. */
  readonly openNavigation: () => void
}

const ShellContext = createContext<Shell>({ openNavigation: () => undefined })

/**
 * The button that opens the navigation on a phone, at the start of a page's or a channel's top bar, with a dot while
 * something waits on the owner in Activity (its name says how many).
 */
export function NavigationButton() {
  const { openNavigation } = use(ShellContext)
  const waiting = useNavCounts().activity
  const label = waiting > 0 ? `Open navigation, ${String(waiting)} waiting in Activity` : 'Open navigation'
  return (
    <span className="nav-button">
      <Button variant="ghost" size="icon" aria-label={label} onClick={openNavigation}>
        <PanelLeftIcon />
      </Button>
      {waiting > 0 && <span className="nav-button-dot" aria-hidden />}
    </span>
  )
}

/**
 * On a phone, the sidebar in a drawer from the left edge. It closes when the page changes, and on a tap of any link in
 * it, even one to the page already showing; a swipe left closes it the way it came.
 */
function NavigationDrawer({
  open,
  onOpenChange,
}: {
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
}) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange} swipeDirection="left">
      <DrawerSide
        tone="shell"
        className="w-[min(19rem,88vw)]"
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('a[href]') !== null) onOpenChange(false)
        }}
      >
        <DrawerTitle className="sr-only">Navigation</DrawerTitle>
        <DrawerDescription className="sr-only">
          Activity, work, apps, pins, Topics and the app's pages.
        </DrawerDescription>
        <div className="shell-drawer-body">
          <Sidebar place="drawer" />
        </div>
      </DrawerSide>
    </Drawer>
  )
}

/** ⌘B (Ctrl+B elsewhere) collapses the desktop sidebar to its strip, or opens it again. */
function useCollapseShortcut(narrow: boolean) {
  useEffect(() => {
    if (narrow) return undefined
    const apple = isApple(browserPlatform())
    const onKey = (event: KeyboardEvent) => {
      if (!isModShortcut(event, 'b', apple)) return
      event.preventDefault()
      toggleCollapsed()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [narrow])
}

/**
 * The signed-in app: the moss sidebar beside the page on a desktop (collapsible to a strip of icons); on a phone the
 * page alone, full width, with the sidebar in a drawer its top bar opens. The server renders the desktop column (CSS
 * hides it on a phone, so a phone's first paint does not show it either).
 */
export function ShellFrame({ children }: { readonly children: ReactNode }) {
  const narrow = useIsMobile()
  const path = useRouterState({ select: (router) => router.location.pathname })
  // The drawer is open on the page it was opened on: going to another page closes it.
  const [openOn, setOpenOn] = useState<string>()
  const open = openOn === path
  const setOpen = useCallback((next: boolean) => setOpenOn(next ? path : undefined), [path])
  const openNavigation = useCallback(() => setOpen(true), [setOpen])
  const shell = useMemo(() => ({ openNavigation }), [openNavigation])
  useCollapseShortcut(narrow)
  return (
    <ShellContext value={shell}>
      <div className="shell-frame">
        {!narrow && (
          <div className="shell-nav" data-slot="shell-nav">
            <Sidebar place="column" />
          </div>
        )}
        {narrow && <NavigationDrawer open={open} onOpenChange={setOpen} />}
        <div className="shell-main">{children}</div>
      </div>
    </ShellContext>
  )
}
