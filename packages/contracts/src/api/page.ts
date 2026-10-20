import * as Schema from 'effect/Schema'
import { PageCursor } from '../ids.ts'

/** The most one page of a list answers. */
export const PAGE_LIMIT = 100

/** `?cursor=&limit=`: where a page starts (the last page's `next`), and at most how many it answers, 1 to 100. */
export const PageQuery = {
  cursor: Schema.optional(PageCursor),
  limit: Schema.optional(
    Schema.NumberFromString.check(
      Schema.isInt(),
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(PAGE_LIMIT),
    ),
  ),
}
