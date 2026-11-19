import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import type { CanvasStore } from '../../shared/contract'
import {
  anchorAt,
  attribution,
  commentState,
  fileLines,
  formatFixRequest,
  placeAnchor,
  reviewQueue,
  taskKey,
  type ChangeRange,
  type ChangeSet,
  type CommentView,
  type CompareMode,
  type InboxItem,
  type Placement,
  type ReviewComment,
  type ReviewMark,
  type ReviewSide
} from '../../shared/reviewInbox'
import type { Task, TaskView } from '../../shared/task'
import type { SendResult } from '../agentMessages'
import type { TaskService } from '../tasks/service'
import { baseName, EMPTY_TREE, isOid, repoPath, type ReviewGit } from './git'
import type { ReviewStore } from './store'

export interface ReviewDeps {
  store: CanvasStore
  tasks: Pick<TaskService, 'views'>
  data: ReviewStore
  git: ReviewGit
  /** The queued delivery every message to an agent goes through: a busy agent gets it once it's idle. */
  send: (sessionId: string, text: string) => SendResult
  now?: () => number
}

const same = (a: string, b: string): boolean => resolve(a).toLowerCase() === resolve(b).toLowerCase()
const short = (oid: string | null | undefined): string => (oid ? oid.slice(0, 7) : 'none')

export type ReviewService = ReturnType<typeof createReviewService>

export function createReviewService(d: ReviewDeps) {
  const now = d.now ?? Date.now
  const nodes = () => d.store.get().nodes

  const taskView = async (projectId: string, taskId: string): Promise<TaskView> => {
    const view = (await d.tasks.views(projectId)).find((v) => v.task.id === taskId)
    if (!view) throw new Error('Task not found in this project')
    return view
  }
  const findTask = (projectId: string, taskId: string): Task => {
    const task = d.store.get().projects.find((p) => p.id === projectId)?.tasks?.tasks.find((t) => t.id === taskId)
    if (!task) throw new Error('Task not found in this project')
    return task
  }
  const rootOf = async (task: Task): Promise<string> => {
    const root = await d.git.toplevel(task.cwd)
    if (!root) throw new Error(`${task.cwd} isn't in a git repository, so there are no changes to review.`)
    return root
  }

  /** Snapshots being taken now. Calls at the same moment share one; a later call always takes its own, so it's never stale. */
  const snapshots = new Map<string, Promise<string>>()
  const snapshot = (root: string): Promise<string> => {
    const key = root.toLowerCase()
    const pending = snapshots.get(key)
    if (pending) return pending
    const tree = d.git.snapshot(root)
    snapshots.set(key, tree)
    const clear = (): void => { if (snapshots.get(key) === tree) snapshots.delete(key) }
    tree.then(clear, clear)
    return tree
  }

  const lastMark = (projectId: string, taskId: string): ReviewMark | undefined =>
    d.data.get().marks.filter((m) => m.projectId === projectId && m.taskId === taskId).sort((a, b) => a.at - b.at).at(-1)

  const baseFor = async (projectId: string, taskId: string, root: string): Promise<string | null> =>
    d.data.get().bases[taskKey(projectId, taskId)] ?? (await d.git.defaultBase(root))

  /** Agents on the canvas working in this checkout, other than the task's own. Folders are matched by repository, not by path prefix. */
  const othersIn = async (root: string, assigned: string[], tops = new Map<string, Promise<string | null>>()): Promise<string[]> => {
    const agents = nodes().filter((n) => n.kind === 'claude' && !assigned.includes(n.id))
    const out: string[] = []
    for (const a of agents) {
      if (!('cwd' in a)) continue
      if (!tops.has(a.cwd)) tops.set(a.cwd, d.git.toplevel(a.cwd))
      const top = await tops.get(a.cwd)!
      if (top && same(top, root)) out.push(a.title)
    }
    return out
  }

  /** Each comment placed against the code as it is now: the new side in the working tree, the old side at the merge-base. */
  async function place(projectId: string, taskId: string, root: string, list: ReviewComment[]): Promise<CommentView[]> {
    if (!list.length) return []
    const tree = await snapshot(root)
    const head = await d.git.head(root)
    const base = await baseFor(projectId, taskId, root)
    const baseOid = base ? await d.git.resolveCommit(root, base).catch(() => null) : null
    const mergeBase = head && baseOid ? await d.git.mergeBase(root, head, baseOid) : null
    const contents = new Map<string, string[] | null>()
    const linesOf = async (side: ReviewSide, path: string): Promise<string[] | null | 'no-base'> => {
      const rev = side === 'new' ? tree : mergeBase
      if (!rev) return 'no-base'
      const key = `${side}:${path}`
      if (!contents.has(key)) {
        const text = await d.git.fileAt(root, rev, path)
        contents.set(key, text === null ? null : fileLines(text))
      }
      return contents.get(key)!
    }
    const out: CommentView[] = []
    for (const c of list) {
      const lines = await linesOf(c.anchor.side, c.anchor.path)
      const placement: Placement = lines === 'no-base' ? { kind: 'outdated', reason: 'There is no base to find a removed line in.' } : placeAnchor(c.anchor, lines)
      out.push({ ...c, placement, state: commentState(c, placement) })
    }
    return out
  }

  const commentsFor = (projectId: string, taskId: string): ReviewComment[] =>
    d.data.get().comments.filter((c) => c.projectId === projectId && c.taskId === taskId)

  async function record(projectId: string, taskId: string, root: string, reason: ReviewMark['reason']): Promise<ReviewMark> {
    const tree = await d.git.snapshot(root)
    const head = await d.git.head(root)
    const base = await baseFor(projectId, taskId, root)
    const baseOid = base ? await d.git.resolveCommit(root, base).catch(() => null) : null
    const mergeBase = head && baseOid ? await d.git.mergeBase(root, head, baseOid) : null
    const mark: ReviewMark = { id: randomUUID(), projectId, taskId, root, head, tree, at: now(), reason, ...(base ? { base, mergeBase } : {}) }
    d.data.update((data) => ({ ...data, marks: [...data.marks, mark] }))
    return mark
  }

  return {
    async inbox(projectId: string): Promise<InboxItem[]> {
      const queue = reviewQueue(await d.tasks.views(projectId))
      // Each agent's repository is looked up once per listing, however many tasks there are.
      const tops = new Map<string, Promise<string | null>>()
      const items: InboxItem[] = []
      for (const view of queue) {
        const task = view.task
        const titled = task.assignedSessionIds.map((id) => nodes().find((n) => n.id === id))
        const assigned = task.assignedSessionIds.map((id, i) => titled[i]?.title ?? `${id} (closed)`)
        const agents = titled.flatMap((n) => (n?.kind === 'claude' ? [{ id: n.id, title: n.title }] : []))
        const openComments = commentsFor(projectId, task.id).filter((c) => c.status === 'open').length
        const base: Omit<InboxItem, 'root' | 'branch' | 'head' | 'attribution' | 'base'> = { view, agents, openComments, lastReview: lastMark(projectId, task.id) }
        const root = await d.git.toplevel(task.cwd)
        if (!root) {
          items.push({ ...base, root: null, branch: null, head: null, base: null, attribution: attribution(assigned, []), error: `${task.cwd} isn't in a git repository.` })
          continue
        }
        const [branch, head, others, chosen] = await Promise.all([d.git.branch(root), d.git.head(root), othersIn(root, task.assignedSessionIds, tops), baseFor(projectId, task.id, root)])
        items.push({ ...base, root, branch, head, base: chosen, attribution: attribution(assigned, others) })
      }
      return items
    },

    async branches(projectId: string, taskId: string): Promise<string[]> {
      return d.git.branches(await rootOf(findTask(projectId, taskId)))
    },

    async changes(projectId: string, taskId: string, mode: CompareMode): Promise<ChangeSet> {
      const task = findTask(projectId, taskId)
      const root = await rootOf(task)
      const [branch, head, tree] = await Promise.all([d.git.branch(root), d.git.head(root), snapshot(root)])
      const notes: string[] = []
      const set: ChangeSet = { root, branch, head, tree, mode, ranges: {}, files: [], notes }
      const mark = lastMark(projectId, taskId)
      if (mode.kind === 'branch') {
        const name = baseName(mode.base)
        const baseOid = await d.git.resolveCommit(root, name)
        if (!baseOid) throw new Error(`There is no branch "${name}" in ${root}.`)
        d.data.update((data) => ({ ...data, bases: { ...data.bases, [taskKey(projectId, taskId)]: name } }))
        if (!head) {
          notes.push('There are no commits yet, so every file is a local change.')
          set.ranges.local = { from: EMPTY_TREE, to: tree }
        } else {
          const mergeBase = await d.git.mergeBase(root, head, baseOid)
          if (!mergeBase) throw new Error(`${branch ?? 'HEAD'} and ${name} share no history, so there is no merge-base to compare from.`)
          set.base = { name, oid: baseOid, mergeBase }
          if (mergeBase === head) notes.push(`HEAD is on ${name} itself (or behind it), so there is no committed work to tell apart from the base. Only local changes show.`)
          else set.ranges.committed = { from: mergeBase, to: head }
          set.ranges.local = { from: head, to: tree }
          if (mark?.base === name && mark.mergeBase && mark.mergeBase !== mergeBase) {
            notes.push(`The base moved since your last review: the merge-base with ${name} was ${short(mark.mergeBase)} and is now ${short(mergeBase)}.`)
          }
        }
      } else {
        if (!mark) throw new Error('No review is recorded for this task yet. Use Mark reviewed or Request fixes first.')
        set.review = mark
        if (!same(mark.root, root)) notes.push(`The last review was of ${mark.root}; the task's folder is now in ${root}.`)
        let from = mark.tree
        if (!(await d.git.objectType(root, mark.tree))) {
          if (mark.head && (await d.git.objectType(root, mark.head))) {
            from = mark.head
            notes.push(`git has cleaned up the saved snapshot of what you reviewed, so this compares with the commit you reviewed, ${short(mark.head)}. Uncommitted changes you already saw then may show again.`)
          } else throw new Error('The revision recorded at your last review is no longer in this repository. Use Mark reviewed to record a new one.')
        }
        if (mark.head && head && mark.head !== head && !(await d.git.isAncestor(root, mark.head, head))) {
          notes.push(`History was rewritten since your last review: the commit you reviewed, ${short(mark.head)}, is no longer behind HEAD. The comparison is of the files themselves, so it is still exact.`)
        }
        set.ranges['since-review'] = { from, to: tree }
      }
      for (const [section, range] of Object.entries(set.ranges) as [keyof typeof set.ranges, ChangeRange][]) {
        set.files.push(...(await d.git.changed(root, range.from, range.to, section)))
      }
      return set
    },

    async fileDiff(projectId: string, taskId: string, range: ChangeRange, path: string): Promise<{ text: string; truncated: boolean }> {
      if (!isOid(range?.from) || !isOid(range?.to)) throw new Error('Not a revision to compare')
      return d.git.diff(await rootOf(findTask(projectId, taskId)), range.from, range.to, repoPath(path))
    },

    async comments(projectId: string, taskId: string): Promise<CommentView[]> {
      const task = findTask(projectId, taskId)
      const list = commentsFor(projectId, taskId)
      const root = await d.git.toplevel(task.cwd)
      if (!root) return list.map((c) => ({ ...c, placement: { kind: 'outdated', reason: 'The task folder is no longer in a git repository.' }, state: c.status === 'resolved' ? 'resolved' : 'outdated' }))
      return place(projectId, taskId, root, list)
    },

    /** Main reads the line and its context from git itself; the window only names the line. */
    async addComment(projectId: string, taskId: string, c: { path: string; side: ReviewSide; line: number; revision: string; text: string }): Promise<CommentView> {
      const task = findTask(projectId, taskId)
      const root = await rootOf(task)
      if (!c?.text?.trim()) throw new Error('Write the comment first.')
      if (c.side !== 'new' && c.side !== 'old') throw new Error('A comment is on the new or the old side of a diff.')
      const path = repoPath(c.path)
      const type = await d.git.objectType(root, c.revision)
      if (type !== 'commit' && type !== 'tree') throw new Error('Not a revision in this repository.')
      const text = await d.git.fileAt(root, c.revision, path)
      const at = text === null ? null : anchorAt(fileLines(text), c.line)
      if (!at) throw new Error(`Line ${c.line} isn't in ${path} at that revision.`)
      const comment: ReviewComment = {
        id: randomUUID(), projectId, taskId, text: c.text.trim(), status: 'open', createdAt: now(),
        anchor: { path, side: c.side, revision: c.revision, revisionKind: type === 'commit' ? 'commit' : 'snapshot', ...at }
      }
      d.data.update((data) => ({ ...data, comments: [...data.comments, comment] }))
      return (await place(projectId, taskId, root, [comment]))[0]
    },

    setCommentStatus(projectId: string, commentId: string, status: 'open' | 'resolved'): true {
      if (status !== 'open' && status !== 'resolved') throw new Error('A comment is open or resolved.')
      if (!d.data.get().comments.some((c) => c.id === commentId && c.projectId === projectId)) throw new Error('Comment not found')
      d.data.update((data) => ({
        ...data,
        comments: data.comments.map((c) => {
          if (c.id !== commentId) return c
          const next: ReviewComment = { ...c, status }
          if (status === 'resolved') next.resolvedAt = now()
          else delete next.resolvedAt
          return next
        })
      }))
      return true
    },

    deleteComment(projectId: string, commentId: string): true {
      if (!d.data.get().comments.some((c) => c.id === commentId && c.projectId === projectId)) throw new Error('Comment not found')
      d.data.update((data) => ({ ...data, comments: data.comments.filter((c) => c.id !== commentId) }))
      return true
    },

    async markReviewed(projectId: string, taskId: string): Promise<ReviewMark> {
      return record(projectId, taskId, await rootOf(findTask(projectId, taskId)), 'marked')
    },

    /**
     * Sends every unresolved comment to one of the task's own agents, through the send queue, and records what was
     * reviewed so the next look can be "changes since last review".
     */
    async requestFixes(projectId: string, taskId: string, sessionId: string): Promise<{ queued: boolean; sent: number; to: string; recorded: boolean }> {
      const view = await taskView(projectId, taskId)
      const task = view.task
      if (!task.assignedSessionIds.includes(sessionId)) throw new Error('Fixes go to an agent assigned to this task.')
      const agent = nodes().find((n) => n.id === sessionId)
      if (agent?.kind !== 'claude') throw new Error('That agent is no longer on the canvas.')
      const root = await rootOf(task)
      const comments = await place(projectId, taskId, root, commentsFor(projectId, taskId))
      const unresolved = comments.filter((c) => c.state !== 'resolved')
      if (!unresolved.length) throw new Error('There are no open comments to send.')
      const [branch, head] = await Promise.all([d.git.branch(root), d.git.head(root)])
      let mark: ReviewMark | null = null
      try { mark = await record(projectId, taskId, root, 'fixes-requested') } catch { /* Sent anyway; the result says it wasn't recorded. */ }
      const reviewed = `${branch ?? 'detached HEAD'} at ${short(head)} in ${root}${mark?.base ? `, against ${mark.base} (merge-base ${short(mark.mergeBase)})` : ''}, uncommitted changes included`
      const r = d.send(sessionId, formatFixRequest(task, unresolved, reviewed))
      if (!r.ok) {
        if (mark) d.data.update((data) => ({ ...data, marks: data.marks.filter((m) => m.id !== mark!.id) }))
        throw new Error(r.reason)
      }
      const ids = new Set(unresolved.map((c) => c.id))
      const at = now()
      d.data.update((data) => ({ ...data, comments: data.comments.map((c) => (ids.has(c.id) ? { ...c, sentAt: at } : c)) }))
      return { queued: r.queued, sent: unresolved.length, to: agent.title, recorded: !!mark }
    }
  }
}
