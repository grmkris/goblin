import type { ReactNode } from 'react'
import { Button } from '@goblin/ui'

/**
 * What an Activity offer to route something shows under its words: where it goes (`select`), then Not now, which
 * leaves it waiting, and Set up, which routes it (disabled while nothing is picked).
 */
export function OfferPick({
  select,
  pending,
  ready,
  onNotNow,
  onSetUp,
}: {
  readonly select: ReactNode
  readonly pending: boolean
  readonly ready: boolean
  readonly onNotNow: () => void
  readonly onSetUp: () => void
}) {
  return (
    <span className="source-offer-pick">
      {select}
      <span className="row-actions">
        <Button variant="ghost" size="sm" disabled={pending} onClick={onNotNow}>
          Not now
        </Button>
        <Button variant="outline" size="sm" pending={pending} disabled={!ready} onClick={onSetUp}>
          Set up
        </Button>
      </span>
    </span>
  )
}
