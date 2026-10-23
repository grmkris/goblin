import { topicFolder } from '@goblin/contracts'
import type { Boundary } from '../topics/boundary.ts'

// Which of the workspace's files a caller reaches (ADR 0115). Each Topic has its own folder, `/topics/<id>/uploads`
// (what people attached there) and `/topics/<id>/agent` (what the agent wrote there); `/uploads` and `/agent` outside
// every Topic are the Shared folder, what the workspace kept before Topics had folders. Pure: the store asks a view
// before every read and write.

/**
 * What one caller reaches: whether it may read a path (a file or a folder) and write one, and its own folder, where it
 * writes and where a path it names without a leading `/` is.
 */
export type FileView = {
  readonly reads: (path: string) => boolean
  readonly writes: (path: string) => boolean
  readonly home: string
}

/** Whether `path` is `root` or under it. */
const under = (root: string) => (path: string) => path === root || path.startsWith(`${root}/`)

const shared = (path: string): boolean => under('/uploads')(path) || under('/agent')(path)

/**
 * The owner's own reach (their Files page, their uploads, a file link they follow) and goblin's own keeping (a
 * Source's attachments, a skill draft): everything.
 */
export const OWNER_VIEW: FileView = { reads: () => true, writes: () => true, home: '/agent' }

/** A call whose chat the agent does not keep reaches no file. */
export const CLOSED_VIEW: FileView = { reads: () => false, writes: () => false, home: '/agent' }

/**
 * A turn's reach within `boundary` (ADR 0115): its own Topic's folder, every Topic's from a hub, and the Shared folder
 * on a person's turn (`people`) only, never on a turn a server's key sent an input to. It writes only under its own
 * Topic's `agent` folder.
 */
export const viewOf = (boundary: Boundary, people: boolean): FileView => {
  const own = topicFolder(boundary.topic)
  const topics = boundary.hub ? under('/topics') : under(own)
  const home = `${own}/agent`
  return { reads: (path) => topics(path) || (people && shared(path)), writes: under(home), home }
}

/** Where a path a turn names is: a full path as it is, a relative one under its own folder. */
export const pathIn = (view: FileView, path: string): string =>
  path.startsWith('/') ? path : `${view.home}/${path.replace(/^\.\//u, '')}`
