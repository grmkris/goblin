import { GoblinMark } from '@goblin/ui'

/**
 * The screen while first-run Start (ADR 0062) waits for the session or its own state: the mark alone on the page's
 * background, as the Home Screen app's startup image draws it, so no words appear and then change.
 */
export function StartSplash() {
  return (
    <div className="start-splash" role="status">
      <span className="start-splash-mark" aria-hidden>
        <GoblinMark />
      </span>
      <span className="sr-only">Opening goblin</span>
    </div>
  )
}
