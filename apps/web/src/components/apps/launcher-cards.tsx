// Apps' cards (ADR 0078), one kind for each section: a pin, a recent view, a connection's own App and a built app. Each
// card shows its tile, its name and a quiet line or two, then its primary action and a ⋯ menu beside it, never inside
// it. Opening never grants anything: the App's calls are checked as they are made.
import type { ReactNode } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import type { AgentAppSummary, AppView } from '@goblin/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, KeyRoundIcon, MessageSquareIcon, PinOffIcon } from 'lucide-react'
import { appOrigin } from '../../lib/app-names.ts'
import { type ConnectedApp, needsYou, pinAction, pinNote } from '../../lib/launcher.ts'
import { type ShownPin, appPin, targetOf } from '../../lib/pins.ts'
import { messageOf } from '../../lib/query/app-error.ts'
import { useReconnect } from '../../mcp/hooks.ts'
import type { Pins } from '../../sidebar/hooks.ts'
import { connectionAnchor } from '../server-card.tsx'
import { useOpenChat } from '../shell/panel.tsx'
import { PinMenuItem } from '../shell/pin-toggle.tsx'
import { AppTile } from './app-tile.tsx'
import { useOpenApp } from './use-open-app.ts'

/**
 * One card: the tile of `origin`, the name with its quiet lines under it, and `actions` beside it; a card with words of
 * its own (a built app) has its main actions in `foot`, under them. `dimmed` marks one that does not open as it is.
 */
function LauncherCard({
  origin,
  name,
  kind,
  dimmed = false,
  lines,
  actions,
  foot,
}: {
  readonly origin: string
  readonly name: string
  readonly kind: 'pin' | 'recent' | 'connected' | 'built'
  readonly dimmed?: boolean
  readonly lines?: ReactNode
  readonly actions: ReactNode
  readonly foot?: ReactNode
}) {
  return (
    <li className="launcher-card" data-kind={kind} {...(dimmed && { 'data-dimmed': true })}>
      <AppTile origin={origin} />
      <div className="launcher-text">
        <h3 className="launcher-name">{name}</h3>
        {lines}
      </div>
      <div className="launcher-actions">{actions}</div>
      {foot !== undefined && <div className="launcher-foot">{foot}</div>}
    </li>
  )
}

/** A quiet line under a card's name; nothing for no text. */
const Line = ({ text }: { readonly text: string | undefined }) =>
  text === undefined ? null : <p className="launcher-meta">{text}</p>

/** Why a card's action failed, in its words with the reference, where the owner just pressed it. */
const Failure = ({ error, action }: { readonly error: unknown; readonly action: string }) =>
  error === null ? null : (
    <p className="launcher-error" role="alert">
      {messageOf(error, action)}
    </p>
  )

/** A card's ⋯ menu, named for the card it belongs to. */
function MoreMenu({ name, children }: { readonly name: string; readonly children: ReactNode }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label={`More for ${name}`} />}>
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Open as a link to App `appId`'s page. */
const OpenView = ({ appId, name }: { readonly appId: string; readonly name: string }) => (
  <Button
    variant="outline"
    nativeButton={false}
    aria-label={`Open ${name}`}
    render={<Link to="/a/$appId" params={{ appId }} />}
  >
    Open
  </Button>
)

/** Open as a link to a connection's own App, which opens in its kept thread. */
const OpenServer = ({ connectionId, name }: { readonly connectionId: string; readonly name: string }) => (
  <Button
    variant="outline"
    nativeButton={false}
    aria-label={`Open ${name}`}
    render={<Link to="/connections/$connectionId/app" params={{ connectionId }} />}
  >
    Open
  </Button>
)

/** Go to conversation: where a view was kept, or a built app's home, in its channel or its thread panel. */
function GoToConversation({ conversation }: { readonly conversation: string }) {
  const openChat = useOpenChat()
  return (
    <DropdownMenuItem onClick={() => openChat(conversation)}>
      <MessageSquareIcon aria-hidden />
      Go to conversation
    </DropdownMenuItem>
  )
}

/** The tile a pin shows: its server's, or its view's origin, or its id once the view is gone. */
const pinOrigin = (pin: ShownPin): string =>
  pin.kind === 'server' ? pin.connectionId : pin.app === undefined ? pin.appId : appOrigin(pin.app)

type Opening = ReturnType<typeof useOpenApp>
type Reconnecting = ReturnType<typeof useReconnect>

/**
 * A pin's primary action: Open (also while its server is still being read), Open for a closed view, which opens it again
 * first, Reconnect for a signed-out server; none for one with no App any more or gone, which the menu unpins.
 */
function PinPrimary({
  pin,
  opening,
  reconnecting,
}: {
  readonly pin: ShownPin
  readonly opening: Opening
  readonly reconnecting: Reconnecting
}) {
  const action = pinAction(pin.state)
  if (action === 'open')
    return pin.kind === 'server' ? (
      <OpenServer connectionId={pin.connectionId} name={pin.title} />
    ) : (
      <OpenView appId={pin.appId} name={pin.title} />
    )
  if (action === 'reopen' && pin.kind === 'view' && pin.app !== undefined) {
    const { app } = pin
    return (
      <Button
        variant="outline"
        aria-label={`Open ${pin.title}`}
        pending={opening.pending}
        onClick={() => opening.open(app)}
      >
        Open
      </Button>
    )
  }
  if (action === 'reconnect' && pin.kind === 'server') {
    const { connectionId } = pin
    return (
      <Button variant="outline" pending={reconnecting.pending} onClick={() => reconnecting.reconnect(connectionId)}>
        Reconnect
      </Button>
    )
  }
  return null
}

/**
 * A pin, in the owner's order: its name, where it came from, and why it does not open as it is ("Signed out",
 * "Closed"); then its action, and a menu that moves or unpins it.
 */
export function PinnedCard({
  pin,
  pins,
  context,
}: {
  readonly pin: ShownPin
  readonly pins: Pins
  /** Where it came from: its view's conversation, or its connection's label where that tells it apart. */
  readonly context: string | undefined
}) {
  const opening = useOpenApp()
  const reconnecting = useReconnect()
  const target = targetOf(pin)
  const note = pinNote(pin.state)
  return (
    <LauncherCard
      origin={pinOrigin(pin)}
      name={pin.title}
      kind="pin"
      dimmed={note !== undefined && pin.state !== 'closed'}
      lines={
        <>
          <Line text={context} />
          <Line text={note} />
          <Failure error={opening.error} action={`open ${pin.title} again`} />
          <Failure error={reconnecting.error} action={`reconnect ${pin.title}`} />
        </>
      }
      actions={
        <>
          <PinPrimary pin={pin} opening={opening} reconnecting={reconnecting} />
          <MoreMenu name={pin.title}>
            <DropdownMenuItem disabled={!pins.canMove(target, -1)} onClick={() => pins.move(target, -1)}>
              <ArrowUpIcon aria-hidden />
              Move up
            </DropdownMenuItem>
            <DropdownMenuItem disabled={!pins.canMove(target, 1)} onClick={() => pins.move(target, 1)}>
              <ArrowDownIcon aria-hidden />
              Move down
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => pins.unpin(target)}>
              <PinOffIcon aria-hidden />
              Unpin
            </DropdownMenuItem>
          </MoreMenu>
        </>
      }
    />
  )
}

/** A recent tool-result view: its name and conversation, Open for that exact view, then Pin and Go to conversation. */
export function RecentCard({
  app,
  name,
  from,
}: {
  readonly app: AppView
  readonly name: string
  readonly from: string | undefined
}) {
  return (
    <LauncherCard
      origin={appOrigin(app)}
      name={name}
      kind="recent"
      lines={<Line text={from} />}
      actions={
        <>
          <OpenView appId={app.id} name={name} />
          <MoreMenu name={name}>
            <PinMenuItem pin={appPin(app, name)} />
            <GoToConversation conversation={app.conversation} />
          </MoreMenu>
        </>
      }
    />
  )
}

/**
 * A connection's own App: its title, and its label where that tells it apart; Open while it is connected, Reconnect
 * once it is signed out; then Manage access (its card on Connections) and Pin.
 */
export function ConnectedCard({ entry }: { readonly entry: ConnectedApp }) {
  const navigate = useNavigate()
  const reconnecting = useReconnect()
  const { connectionId, title, label, connected } = entry
  const named = title.toLocaleLowerCase() === label.toLocaleLowerCase() ? undefined : label
  return (
    <LauncherCard
      origin={connectionId}
      name={title}
      kind="connected"
      dimmed={!connected}
      lines={
        <>
          <Line text={named} />
          <Line text={connected ? undefined : 'Signed out'} />
          <Failure error={reconnecting.error} action={`reconnect ${title}`} />
        </>
      }
      actions={
        <>
          {connected ? (
            <OpenServer connectionId={connectionId} name={title} />
          ) : (
            <Button
              variant="outline"
              pending={reconnecting.pending}
              onClick={() => reconnecting.reconnect(connectionId)}
            >
              Reconnect
            </Button>
          )}
          <MoreMenu name={title}>
            <DropdownMenuItem
              onClick={() => void navigate({ to: '/connections', hash: connectionAnchor(connectionId) })}
            >
              <KeyRoundIcon aria-hidden />
              Manage access
            </DropdownMenuItem>
            <PinMenuItem pin={{ kind: 'server', connectionId }} />
          </MoreMenu>
        </>
      }
    />
  )
}

/** A built app's Open: its view's page, opened again first when it was closed. */
function OpenBuilt({
  appId,
  view,
  name,
  opening,
}: {
  readonly appId: string
  readonly view: AppView | undefined
  readonly name: string
  readonly opening: Opening
}) {
  if (view?.closedAt === undefined) return <OpenView appId={appId} name={name} />
  return (
    <Button variant="outline" aria-label={`Open ${name}`} pending={opening.pending} onClick={() => opening.open(view)}>
      Open
    </Button>
  )
}

/**
 * An app built for the owner: its title, its words, and what it needs from them; Open when it has a view, otherwise
 * Manage as its one action, and Manage beside Open always. Its version and state stay on its management page.
 */
export function BuiltCard({ app, view }: { readonly app: AgentAppSummary; readonly view: AppView | undefined }) {
  const opening = useOpenApp()
  const need = needsYou(app)
  return (
    <LauncherCard
      origin={app.name}
      name={app.title}
      kind="built"
      lines={
        <>
          {app.description !== '' && <p className="launcher-about">{app.description}</p>}
          {app.app === null && <Line text={app.jobs.length > 0 ? 'Runs in the background' : 'Nothing to open yet'} />}
          {need !== undefined && <p className="launcher-need">{need}</p>}
          <Failure error={opening.error} action={`open ${app.title} again`} />
        </>
      }
      actions={
        <MoreMenu name={app.title}>
          {view !== undefined && <PinMenuItem pin={appPin(view, app.title)} />}
          <GoToConversation conversation={app.home} />
        </MoreMenu>
      }
      foot={
        <>
          {app.app !== null && <OpenBuilt appId={app.app} view={view} name={app.title} opening={opening} />}
          <Button
            variant={app.app === null ? 'outline' : 'ghost'}
            nativeButton={false}
            aria-label={`Manage ${app.title}`}
            render={<Link to="/apps/$name" params={{ name: app.name }} />}
          >
            Manage
          </Button>
        </>
      }
    />
  )
}
