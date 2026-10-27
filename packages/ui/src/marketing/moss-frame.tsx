// A marketing page's hero, built as the product's own shell at large scale: the moss field its sidebar is made of,
// with the headline, one line and the invitation on it, and beside them the off-white message area as a framed panel,
// where the product's characteristic moment plays. On a phone the copy comes first and the panel runs full width under
// it.
//
// With `backdrop="page"` the page draws the field and a scene behind the hero (and behind everything after it): the
// hero paints nothing of its own, and leaves the scene room. On a desktop the copy and the panel keep to the right seven
// columns, beside the scene's subject; on a phone and a tablet a stretch between the copy and the panel stays open.
import { type ReactNode, useId } from 'react'

export interface MossFrameProps {
  /** The section's id, for a skip link or an anchor. */
  readonly id?: string
  /** The page's one headline (its `<h1>`). */
  readonly title: ReactNode
  /** One line under it: what the product is. */
  readonly lede: ReactNode
  /** The invitation and anything beside it (`SiteButton`s, which take the field's colours). */
  readonly actions: ReactNode
  /** A small line under the actions: the price, a fact. */
  readonly note?: ReactNode
  /** `own` (the default) paints the moss field; `page` leaves it, and a scene, to the page behind the hero. */
  readonly backdrop?: 'own' | 'page'
  /** The panel's name, in its top bar ("# Islands", "Payments"); assistive tech calls the panel by it too. */
  readonly panelLabel: string
  /** At the end of the panel's top bar: a status. */
  readonly panelStatus?: ReactNode
  /** The panel's content. */
  readonly panel: ReactNode
  /** At the foot of the panel: a composer, an input. */
  readonly panelFooter?: ReactNode
}

export function MossFrame({
  id,
  title,
  lede,
  actions,
  note,
  backdrop = 'own',
  panelLabel,
  panelStatus,
  panel,
  panelFooter,
}: MossFrameProps) {
  const titleId = useId()
  return (
    <section id={id} aria-labelledby={titleId} data-slot="moss-frame" data-backdrop={backdrop} className="moss-frame">
      <div className="site-width moss-frame-grid">
        <div className="moss-frame-copy">
          <h1 id={titleId} className="site-display">
            {title}
          </h1>
          <p className="moss-frame-lede">{lede}</p>
          <div className="moss-frame-actions">{actions}</div>
          {note === undefined ? null : <p className="site-small moss-frame-note">{note}</p>}
        </div>
        <div role="region" aria-label={panelLabel} className="moss-frame-panel">
          <div className="moss-frame-panel-bar">
            <p className="moss-frame-panel-label">{panelLabel}</p>
            {panelStatus}
          </div>
          <div className="moss-frame-panel-body">{panel}</div>
          {panelFooter}
        </div>
      </div>
    </section>
  )
}
