import type { ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  TooltipProvider,
} from '@goblin/ui'
import {
  AtSignIcon,
  BellIcon,
  CircleUserIcon,
  LayoutGridIcon,
  ListChecksIcon,
  LogOutIcon,
  PanelLeftCloseIcon,
  PanelLeftOpenIcon,
  PlugIcon,
  SettingsIcon,
  UserCogIcon,
} from 'lucide-react'
import { signOutMutation } from '../../auth/queries.ts'
import type { NavRow } from '../../lib/nav-highlight.ts'
import { JumpToButton } from './jump-to.tsx'
import { Count, EXACT, Here, Strip, Tip, useCurrent } from './sidebar-parts.tsx'
import { Pinned } from './sidebar-pins.tsx'
import { WorkspaceMenu } from './workspace-menu.tsx'
import { toggleCollapsed, useCollapsed, useHighlight, useNavCounts } from './sidebar-state.ts'
import { Topics, TopicsInStrip } from './sidebar-topics.tsx'

type PlaceTo = '/activity' | '/work' | '/apps' | '/threads' | '/connections' | '/personas' | '/settings'

/** One of the places: its icon and name, and what waits there. */
function Place({
  to,
  row,
  label,
  icon,
  count,
  words = '',
}: {
  readonly to: PlaceTo
  readonly row: NavRow
  readonly label: string
  readonly icon: ReactNode
  readonly count?: number
  readonly words?: string
}) {
  const current = useCurrent(row)
  return (
    <li>
      <Tip label={label}>
        <Link activeOptions={EXACT} to={to} className="sidebar-row sidebar-place" aria-current={current}>
          {icon}
          <span className="sidebar-row-name">{label}</span>
          {count !== undefined && <Count count={count} words={words} />}
        </Link>
      </Tip>
    </li>
  )
}

/** The Account row: a menu with the account's settings and Sign out. */
function Account() {
  const signingOut = useMutation(signOutMutation)
  return (
    <li>
      <DropdownMenu>
        <Tip label="Account">
          <DropdownMenuTrigger render={<button type="button" className="sidebar-row sidebar-place" />}>
            <CircleUserIcon className="sidebar-row-mark" aria-hidden />
            <span className="sidebar-row-name">Account</span>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent side="top" align="start">
          <DropdownMenuItem render={<Link activeOptions={EXACT} to="/settings" hash="account" />}>
            <UserCogIcon aria-hidden />
            Account settings
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={signingOut.isPending}
            onClick={() => signingOut.mutate(undefined, { onSettled: () => window.location.assign('/') })}
          >
            <LogOutIcon aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** Collapses the sidebar to its strip of icons, or opens it again (⌘B or Ctrl+B too). */
function CollapseButton() {
  const collapsed = useCollapsed()
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar'
  return (
    <Tip label={label}>
      <button
        type="button"
        className="sidebar-collapse"
        aria-label={label}
        aria-expanded={!collapsed}
        onClick={toggleCollapsed}
      >
        {collapsed ? <PanelLeftOpenIcon aria-hidden /> : <PanelLeftCloseIcon aria-hidden />}
      </button>
    </Tip>
  )
}

/** The head's places: Jump to, then Activity and Work with what waits and runs there, then Apps. */
function Places({ counts }: { readonly counts: ReturnType<typeof useNavCounts> }) {
  return (
    <ul className="sidebar-rows sidebar-places">
      <li>
        <Tip label="Jump to">
          <JumpToButton />
        </Tip>
      </li>
      <Place
        to="/activity"
        row="activity"
        label="Activity"
        icon={<BellIcon className="sidebar-row-mark" aria-hidden />}
        count={counts.activity}
        words="waiting"
      />
      <Place
        to="/work"
        row="work"
        label="Work"
        icon={<ListChecksIcon className="sidebar-row-mark" aria-hidden />}
        count={counts.tasks}
        words="running"
      />
      <Place to="/apps" row="apps" label="Apps" icon={<LayoutGridIcon className="sidebar-row-mark" aria-hidden />} />
    </ul>
  )
}

/** The foot: Connections, Personas, Settings and the account. */
function Foot() {
  return (
    <ul className="sidebar-rows sidebar-foot">
      <Place
        to="/connections"
        row="connections"
        label="Connections"
        icon={<PlugIcon className="sidebar-row-mark" aria-hidden />}
      />
      <Place
        to="/personas"
        row="personas"
        label="Personas"
        icon={<AtSignIcon className="sidebar-row-mark" aria-hidden />}
      />
      <Place
        to="/settings"
        row="settings"
        label="Settings"
        icon={<SettingsIcon className="sidebar-row-mark" aria-hidden />}
      />
      <Account />
    </ul>
  )
}

/**
 * The sidebar (ADR 0078): goblin's mark (the channel this tab showed last) and the places (Jump to, Activity, Work,
 * Apps) at its head; the owner's pins and the Topics with their live threads in the middle, which scrolls; Connections,
 * Personas, Settings and the account at its foot. On a desktop it is a column the owner can collapse to a strip of
 * icons; on a phone, the drawer's contents. Exactly one row shows where the page is.
 */
export function Sidebar({ place }: { readonly place: 'column' | 'drawer' }) {
  const collapsed = useCollapsed()
  const here = useHighlight()
  const counts = useNavCounts()
  return (
    <Strip value={place === 'column' && collapsed}>
      <Here value={here}>
        <TooltipProvider>
          <nav className="shell-sidebar" aria-label="Navigation" data-place={place}>
            <header className="sidebar-head">
              <WorkspaceMenu />
              {place === 'column' && <CollapseButton />}
            </header>
            <Places counts={counts} />
            <div className="sidebar-scroll">
              <Pinned />
              <ul className="sidebar-rows sidebar-strip-only">
                <TopicsInStrip unread={counts.threads} />
              </ul>
              <Topics unread={counts.threads} />
            </div>
            <Foot />
          </nav>
        </TooltipProvider>
      </Here>
    </Strip>
  )
}
