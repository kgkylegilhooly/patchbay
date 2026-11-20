import { readdir, rm, rmdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ReviewMark } from '../../shared/reviewInbox'
import type { ReviewGit } from './git'

/**
 * How the review object store (`<userData>/review-objects`, one folder per repository) is kept from growing for ever.
 * Snapshots of working trees are written there, and git never cleans it: Patchbay does, from what the inbox still
 * needs. See docs/plans/review-inbox.md.
 */
export const OBJECT_LIMITS = {
  /** An object nothing needs is left this long first: a snapshot may be being written or shown. */
  graceMs: 60 * 60_000,
  /** A snapshot handed to the window is kept this long, as it may still be on screen. */
  shownMs: 24 * 60 * 60_000,
  /**
   * A task's latest review keeps its snapshot this long. After that "changes since last review" compares with the
   * commit reviewed, and says so.
   */
  reviewMs: 90 * 24 * 60 * 60_000,
  /** A folder for a repository no review record names any more: its objects go once this old. */
  orphanMs: 30 * 24 * 60 * 60_000,
  /** Most a repository's folder keeps. Past it, the oldest reviews' snapshots go first; open comments' never do. */
  maxBytes: 512 * 1024 * 1024,
  /** How often the inbox prunes while it's used. */
  everyMs: 6 * 60 * 60_000
}
export type ObjectLimits = typeof OBJECT_LIMITS

/**
 * What one repository's folder must keep: `required` always, and each review's snapshot while there's room. A known
 * repository's folder is never removed, as git is pointed at it; only folders no repository is known for are.
 */
export interface StoreNeeds {
  root: string
  required: string[]
  /** Oldest first: the order they give up their snapshots when the folder is over its size. */
  reviews: { tree: string; at: number }[]
}

/**
 * What the review store must keep, by repository. A recorded review is needed only as each task's latest (the one
 * "since last review" compares with) and only for `reviewMs`. An open comment's snapshot is needed while it's open.
 * A snapshot shown in the last `shownMs` is needed, as the window may still be showing it.
 */
export function objectNeeds(
  input: {
    marks: ReviewMark[]
    /** Open comments written on a snapshot, with the repository they're in. */
    comments: { root: string; revision: string }[]
    shown: { root: string; tree: string; at: number }[]
    /** Repositories in use with nothing to keep: their objects may go, but their folders stay. */
    roots?: string[]
  },
  now: number,
  limits: Pick<ObjectLimits, 'reviewMs' | 'shownMs'> = OBJECT_LIMITS
): StoreNeeds[] {
  const byRoot = new Map<string, StoreNeeds>()
  const of = (root: string): StoreNeeds => {
    const key = resolve(root).toLowerCase()
    let n = byRoot.get(key)
    if (!n) byRoot.set(key, (n = { root, required: [], reviews: [] }))
    return n
  }
  const latest = new Map<string, ReviewMark>()
  for (const m of input.marks) {
    const k = `${m.projectId}/${m.taskId}`
    const was = latest.get(k)
    if (!was || m.at > was.at) latest.set(k, m)
  }
  for (const m of latest.values()) if (now - m.at <= limits.reviewMs) of(m.root).reviews.push({ tree: m.tree, at: m.at })
  for (const c of input.comments) of(c.root).required.push(c.revision)
  for (const s of input.shown) if (now - s.at <= limits.shownMs) of(s.root).required.push(s.tree)
  for (const root of input.roots ?? []) of(root)
  for (const n of byRoot.values()) n.reviews.sort((a, b) => a.at - b.at)
  return [...byRoot.values()]
}

const HEX2 = /^[0-9a-f]{2}$/
const HEX38 = /^[0-9a-f]{38}(?:[0-9a-f]{24})?$/

/** Removes a folder's loose objects that aren't in `keep` and weren't written since `before`. Gives what's left. */
export async function sweepObjects(dir: string, keep: Set<string>, before: number): Promise<{ removed: number; bytes: number }> {
  let removed = 0
  let bytes = 0
  const subs = await readdir(dir).catch(() => [] as string[])
  for (const sub of subs) {
    if (!HEX2.test(sub)) continue
    const folder = join(dir, sub)
    const names = await readdir(folder).catch(() => [] as string[])
    let left = 0
    for (const name of names) {
      const file = join(folder, name)
      const s = await stat(file).catch(() => null)
      if (!s?.isFile()) continue
      if (!HEX38.test(name) || keep.has(sub + name) || s.mtimeMs >= before) {
        bytes += s.size
        left++
        continue
      }
      // git writes objects read-only; rm's force takes care of that on Windows.
      await rm(file, { force: true }).then(() => removed++, () => { bytes += s.size; left++ })
    }
    if (!left) await rmdir(folder).catch(() => {})
  }
  return { removed, bytes }
}

export interface PruneReport {
  /** Objects removed, over all folders. */
  removed: number
  /** Reviews whose snapshots were given up for a folder's size. */
  reviewsDropped: number
  /** Folders of repositories no record names, removed once empty. */
  foldersRemoved: number
  /** Repositories left alone because git couldn't list what they need. */
  skipped: string[]
}

/**
 * Prunes the review store. Nothing a folder needs is removed, and nothing at all from a folder whose needs couldn't be
 * listed: a git failure leaves it as it was. The caller makes sure no snapshot is being written meanwhile.
 */
export async function pruneObjectStore(
  git: Pick<ReviewGit, 'storeDir' | 'reachable'>,
  objectsRoot: string,
  needs: StoreNeeds[],
  now: number,
  limits: Pick<ObjectLimits, 'graceMs' | 'orphanMs' | 'maxBytes'> = OBJECT_LIMITS
): Promise<PruneReport> {
  const report: PruneReport = { removed: 0, reviewsDropped: 0, foldersRemoved: 0, skipped: [] }
  const known = new Map<string, StoreNeeds>()
  for (const n of needs) {
    try {
      known.set(resolve(await git.storeDir(n.root)).toLowerCase(), n)
    } catch {
      // Its folder can't be named now (the repository may be gone); it's treated as no record's, so only very old objects go.
    }
  }
  const folders = await readdir(objectsRoot, { withFileTypes: true }).catch(() => [])
  for (const entry of folders) {
    if (!entry.isDirectory()) continue
    const dir = join(objectsRoot, entry.name)
    const need = known.get(resolve(dir).toLowerCase())
    if (!need) {
      const r = await sweepObjects(dir, new Set(), now - limits.orphanMs)
      report.removed += r.removed
      if (r.bytes === 0 && (await readdir(dir).then((names) => names.every((n) => n === 'pack' || n === 'info'), () => false))) {
        await rm(dir, { recursive: true, force: true }).then(() => report.foldersRemoved++, () => {})
      }
      continue
    }
    const reviews = [...need.reviews]
    try {
      for (;;) {
        const keep = await git.reachable(need.root, [...need.required, ...reviews.map((r) => r.tree)])
        const r = await sweepObjects(dir, keep, now - limits.graceMs)
        report.removed += r.removed
        if (r.bytes <= limits.maxBytes || !reviews.length) break
        reviews.shift()
        report.reviewsDropped++
      }
    } catch {
      report.skipped.push(need.root)
    }
  }
  return report
}
