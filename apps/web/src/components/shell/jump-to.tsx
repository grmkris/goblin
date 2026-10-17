// Jump to (⌘K, Ctrl+K elsewhere): one search over the places the browser already holds (pages, Topics, open threads,
// Apps, Personas and sections), opening the highlighted one on Enter. It reads nothing new from the server beyond the
// lists it already keeps, never a transcript, and opening a place changes no pin, grant or App power. The shortcut
// works anywhere in the shell except inside an App's sandboxed frame, which keeps its own keys.
import {
  type ReactNode,
  createContext,
  use,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  Autocomplete,
  AutocompleteCollection,
  AutocompleteDialog,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteItemDetail,
  AutocompleteItemLabel,
  AutocompleteList,
  Dialog,
} from '@goblin/ui'
import {
  AtSignIcon,
  BellIcon,
  HashIcon,
  LayoutGridIcon,
  ListChecksIcon,
  type LucideIcon,
  MessagesSquareIcon,
  PlugIcon,
  SearchIcon,
  SettingsIcon,
} from 'lucide-react'
import { agentAppsQuery } from '../../agent-apps/queries.ts'
import { healthQuery } from '../../auth/queries.ts'
import {
  type JumpGroup,
  type JumpItem,
  type JumpKind,
  type ShortcutPlatform,
  WORK_PATH,
  isJumpShortcut,
  jumpItems,
  jumpResults,
  jumpShortcut,
  shortcutPlatform,
} from '../../lib/jump.ts'
import { useConversations, usePersonas, useTopics } from '../../lib/workspace/hooks.ts'
import { serversQuery } from '../../mcp/queries.ts'
import { usePins } from '../../sidebar/hooks.ts'
import { AppTile } from '../apps/app-tile.tsx'

/** What opens the switcher from anywhere in the shell. */
type JumpTo = { readonly open: () => void }

const JumpToContext = createContext<JumpTo | undefined>(undefined)

const subscribeNever = () => () => undefined
const platformNow = () => shortcutPlatform(navigator.userAgent)
const platformOnServer = () => undefined

/** The platform whose shortcut to show; unknown while the server renders and the page hydrates. */
const usePlatform = (): ShortcutPlatform | undefined =>
  useSyncExternalStore(subscribeNever, platformNow, platformOnServer)

/** Opens the switcher; only inside `JumpToProvider`. */
export function useJumpTo(): JumpTo {
  const jumpTo = use(JumpToContext)
  if (jumpTo === undefined) throw new Error('useJumpTo is used outside JumpToProvider')
  return jumpTo
}

/** What opens and closes the switcher: ⌘K on Apple's platforms, Ctrl+K elsewhere, unless something inside took it. */
function useShortcut(toggle: () => void) {
  useEffect(() => {
    const platform = shortcutPlatform(navigator.userAgent)
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !isJumpShortcut(event, platform)) return
      event.preventDefault()
      toggle()
    }
    window.addEventListener('keydown', keydown)
    return () => window.removeEventListener('keydown', keydown)
  }, [toggle])
}

/**
 * The switcher for everything inside it: its shortcut, `useJumpTo` and the dialog itself. The dialog's contents mount
 * only while it is open, so the lists it reads are read then.
 */
export function JumpToProvider({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const jumpTo = useMemo((): JumpTo => ({ open: () => setOpen(true) }), [])
  const toggle = useCallback(() => setOpen((was) => !was), [])
  useShortcut(toggle)
  return (
    <JumpToContext value={jumpTo}>
      {children}
      <Dialog open={open} onOpenChange={setOpen}>
        <AutocompleteDialog aria-label="Jump to">
          <JumpSearch onJump={() => setOpen(false)} />
        </AutocompleteDialog>
      </Dialog>
    </JumpToContext>
  )
}

/** The sidebar's "Jump to…" row, with the platform's shortcut at its end at a keyboard and mouse. */
export function JumpToButton() {
  const { open } = useJumpTo()
  const platform = usePlatform()
  const shortcut = platform === undefined ? undefined : jumpShortcut(platform)
  return (
    <button
      type="button"
      className="sidebar-row"
      aria-haspopup="dialog"
      aria-keyshortcuts={shortcut?.aria}
      onClick={open}
    >
      <SearchIcon className="sidebar-row-mark" aria-hidden />
      <span className="sidebar-row-name">Jump to…</span>
      {shortcut !== undefined && (
        <kbd className="font-sans text-13 tabular-nums opacity-75 pointer-coarse:hidden" aria-hidden>
          {shortcut.label}
        </kbd>
      )}
    </button>
  )
}

/**
 * Every place the switcher can open, from the workspace feed and the lists the browser keeps (the servers, which the
 * sidebar reads anyway, and the built apps). A list not read yet, or one that failed, only means fewer places.
 */
function useJumpItems(): readonly JumpItem[] {
  const topics = useTopics()
  const views = useConversations()
  const personas = usePersonas()
  const { shown: pins } = usePins()
  const servers = useQuery(serversQuery).data
  const built = useQuery(agentAppsQuery).data
  // A deployment without agent apps (ADR 0064) has no Apps page and builds nothing; until /health says so, it has them.
  const agentApps = useQuery(healthQuery).data?.features?.agentApps !== false
  return useMemo(
    () => jumpItems({ topics, views, personas, pins, servers, built, agentApps }),
    [topics, views, personas, pins, servers, built, agentApps],
  )
}

/** Each page's icon, by its path: a page and its sections share it. */
const PAGE_ICONS: Readonly<Partial<Record<string, LucideIcon>>> = {
  '/activity': BellIcon,
  [WORK_PATH]: ListChecksIcon,
  '/apps': LayoutGridIcon,
  '/connections': PlugIcon,
  '/settings': SettingsIcon,
  '/threads': MessagesSquareIcon,
}

/** Each kind's icon where its page gives it none. */
const KIND_ICONS: Readonly<Record<JumpKind, LucideIcon>> = {
  destination: LayoutGridIcon,
  topic: HashIcon,
  thread: MessagesSquareIcon,
  app: LayoutGridIcon,
  persona: AtSignIcon,
  setting: SettingsIcon,
}

/**
 * A row's mark: an App's tile, a Topic's `#`, a page's own icon; its kind is in words beside it as well. Each sits in
 * the same square as a tile, so every label starts at the same place.
 */
function Mark({ item }: { readonly item: JumpItem }) {
  const page = item.kind === 'destination' || item.kind === 'setting' ? PAGE_ICONS[item.link.to] : undefined
  const Icon = page ?? KIND_ICONS[item.kind]
  return (
    <span className="grid size-4.5 shrink-0 place-items-center" aria-hidden>
      {item.tile === undefined ? <Icon className="size-4 text-muted-foreground" /> : <AppTile origin={item.tile} />}
    </span>
  )
}

/**
 * The search and its results. The field takes focus when the dialog opens and the first result is highlighted, so
 * typing and Enter is enough; the arrow keys move the highlight. A result is a link: Enter or a click opens it and
 * closes the switcher, and focus goes back to where it was.
 */
function JumpSearch({ onJump }: { readonly onJump: () => void }) {
  const items = useJumpItems()
  const [query, setQuery] = useState('')
  const groups = useMemo(() => jumpResults(items, query), [items, query])
  const hint = useId()
  return (
    <Autocomplete
      open
      inline
      items={groups}
      filter={null}
      autoHighlight="always"
      keepHighlight
      value={query}
      onValueChange={(next) => setQuery(next)}
      itemToStringValue={(item) => item.label}
    >
      <AutocompleteInput placeholder="Jump to a topic, thread or app…" aria-label="Jump to" aria-describedby={hint} />
      <span id={hint} hidden>
        Use the arrow keys to choose and Enter to open.
      </span>
      <AutocompleteEmpty>No matches.</AutocompleteEmpty>
      <AutocompleteList>
        {(group: JumpGroup) => (
          <AutocompleteGroup key={group.kind} items={group.items}>
            <AutocompleteGroupLabel>{group.label}</AutocompleteGroupLabel>
            <AutocompleteCollection>
              {(item: JumpItem) => (
                <AutocompleteItem key={item.id} value={item} render={<Link {...item.link} />} onClick={onJump}>
                  <Mark item={item} />
                  <AutocompleteItemLabel>{item.label}</AutocompleteItemLabel>
                  <AutocompleteItemDetail>{item.detail}</AutocompleteItemDetail>
                </AutocompleteItem>
              )}
            </AutocompleteCollection>
          </AutocompleteGroup>
        )}
      </AutocompleteList>
    </Autocomplete>
  )
}
