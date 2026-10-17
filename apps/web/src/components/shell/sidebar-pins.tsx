// The sidebar's pins (ADRs 0053, 0078): every stored pin in the owner's order, one that does not open keeping its place
// and saying why, each with its menu.
import { Link } from '@tanstack/react-router'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@goblin/ui'
import { ArrowDownIcon, ArrowUpIcon, EllipsisIcon, PinOffIcon, RefreshCwIcon } from 'lucide-react'
import { jobTrouble } from '../../lib/app-jobs.ts'
import { appOrigin } from '../../lib/app-names.ts'
import { type PinState, type ShownPin, targetOf } from '../../lib/pins.ts'
import { type Pins, usePins } from '../../sidebar/hooks.ts'
import { AppTile } from '../apps/app-tile.tsx'
import { EXACT, Section, Tip, useCurrent } from './sidebar-parts.tsx'

const STATE_WORDS: Partial<Record<PinState, string>> = {
  'signed-out': 'Signed out',
  'no-app': 'No app any more',
  closed: 'Closed',
  gone: 'Not available',
}

/** A pin's menu: move it up or down among the pins, sign in again when its server is signed out, or unpin it. */
function PinMenu({ pin, pins }: { readonly pin: ShownPin; readonly pins: Pins }) {
  const target = targetOf(pin)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" className="sidebar-row-more" aria-label={`More for ${pin.title}`} />}
      >
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {pin.state === 'signed-out' && (
          <>
            <DropdownMenuItem render={<Link activeOptions={EXACT} to="/connections" />}>
              <RefreshCwIcon aria-hidden />
              Reconnect
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
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
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/**
 * One pin: a server opens its own App in its thread; a view opens that App's page. One that does not open keeps its
 * place and says why; a signed-out server leads to Connections, where it signs in again.
 */
function PinnedRow({ pin, pins }: { readonly pin: ShownPin; readonly pins: Pins }) {
  const current = useCurrent(`pin:${pin.kind === 'server' ? `server:${pin.connectionId}` : `view:${pin.appId}`}`)
  const origin = pin.kind === 'server' ? pin.connectionId : pin.app === undefined ? pin.appId : appOrigin(pin.app)
  const trouble = pin.kind === 'view' && pin.app?.source.kind === 'agent' && pin.app.source.jobs.some(jobTrouble)
  const words = STATE_WORDS[pin.state]
  const label = (
    <>
      <AppTile origin={origin} />
      <span className="sidebar-row-name">{pin.title}</span>
      {words !== undefined && <span className="sidebar-row-state">{words}</span>}
      {trouble && <span className="sidebar-row-alert" aria-label="Needs you" />}
    </>
  )
  const name = words === undefined ? pin.title : `${pin.title} (${words})`
  const row =
    pin.state === 'no-app' || pin.state === 'gone' ? (
      <span className="sidebar-row" data-state={pin.state} aria-disabled>
        {label}
      </span>
    ) : pin.kind === 'view' ? (
      <Link
        activeOptions={EXACT}
        to="/a/$appId"
        params={{ appId: pin.appId }}
        className="sidebar-row"
        data-state={pin.state}
        aria-current={current}
      >
        {label}
      </Link>
    ) : pin.state === 'signed-out' ? (
      <Link activeOptions={EXACT} to="/connections" className="sidebar-row" data-state={pin.state}>
        {label}
      </Link>
    ) : (
      <Link
        activeOptions={EXACT}
        to="/connections/$connectionId/app"
        params={{ connectionId: pin.connectionId }}
        className="sidebar-row"
        data-state={pin.state}
        aria-current={current}
      >
        {label}
      </Link>
    )
  return (
    <li className="sidebar-pin">
      <Tip label={name}>{row}</Tip>
      <PinMenu pin={pin} pins={pins} />
    </li>
  )
}

/** The owner's pins (ADRs 0053, 0078), in their order. Nothing when nothing is pinned. */
export function Pinned() {
  const pins = usePins()
  if (pins.shown.length === 0) return null
  return (
    <Section id="pinned" label="Pinned">
      {pins.shown.map((pin) => (
        <PinnedRow key={`${pin.kind}:${pin.kind === 'server' ? pin.connectionId : pin.appId}`} pin={pin} pins={pins} />
      ))}
    </Section>
  )
}
