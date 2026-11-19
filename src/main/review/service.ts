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
  pruneReviewData,
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
  type ChangeSection,
  type ReviewSide,
  type Shown
} from '../../shared/reviewInbox'
import { isSessionNode } from '../../shared/model'
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

  /**
   * Other windows on the canvas open in this checkout: agents, terminals and run commands, since the person or another
   * tool can edit from any of them. Folders are matched by repository, not by path prefix.
   */
  const othersIn = async (root: string, assigned: string[], tops = new Map<string, Promise<string | null>>()): Promise<string[]> => {
    const out: string[] = []
    for (const n of nodes()) {
      if (!isSessionNode(n) || assigned.includes(n.id) || !n.cwd) continue
      if (!tops.has(n.cwd)) tops.set(n.cwd, d.git.toplevel(n.cwd))
      const top = await tops.get(n.cwd)!
      if (top && same(top, root)) out.push(n.title)
    }
    return out
  }

  /**
   * Each comment placed against the code as it is now. The new side is the working tree. The old side is the same
   * "from" the comment's own list compares from: HEAD now for local changes, the merge-base now (with the comment's base)
   * for committed work, and for since-review the recorded snapshot itself, which never changes.
   */
  async function place(projectId: string, taskId: string, root: string, list: ReviewComment[], shownTree?: string): Promise<CommentView[]> {
    if (!list.length) return []
    const tree = shownTree && (await d.git.objectType(root, shownTree)) === 'tree' ? shownTree : await snapshot(root)
    const head = await d.git.head(root)
    const chosen = await baseFor(projectId, taskId, root)
    const mergeBases = new Map<string, Promise<string | null>>()
    const mergeBaseWith = (base: string | null): Promise<string | null> => {
      if (!base || !head) return Promise.resolve(null)
      if (!mergeBases.has(base)) {
        mergeBases.set(base, d.git.resolveCommit(root, base).catch(() => null).then((oid) => (oid ? d.git.mergeBase(root, head, oid) : null)))
      }
      return mergeBases.get(base)!
    }
    const oldFrom = async (c: ReviewComment): Promise<{ rev: string } | { none: string }> => {
      const section = c.anchor.section ?? 'committed'
      if (section === 'since-review') return { rev: c.anchor.revision }
      if (section === 'local') return head ? { rev: head } : { none: 'There are no commits to find a removed line in.' }
      const mb = await mergeBaseWith(c.anchor.base ?? chosen)
      return mb ? { rev: mb } : { none: 'There is no base to find a removed line in.' }
    }
    const contents = new Map<string, Promise<string[] | null | 'too-large'>>()
    const linesAt = (rev: string, path: string): Promise<string[] | null | 'too-large'> => {
      const key = `${rev}:${path}`
      if (!contents.has(key)) contents.set(key, d.git.fileAt(root, rev, path).then((t) => (t === null || t === 'too-large' ? t : fileLines(t))))
      return contents.get(key)!
    }
    const out: CommentView[] = []
    for (const c of list) {
      let placement: Placement
      if (c.anchor.side === 'new') placement = placeAnchor(c.anchor, await linesAt(tree, c.anchor.path))
      else {
        const from = await oldFrom(c)
        placement = 'none' in from ? { kind: 'outdated', reason: from.none } : placeAnchor(c.anchor, await linesAt(from.rev, c.anchor.path))
      }
      out.push({ ...c, placement, state: commentState(c, placement) })
    }
    return out
  }

  const commentsFor = (projectId: string, taskId: string): ReviewComment[] =>
    d.data.get().comments.filter((c) => c.projectId === projectId && c.taskId === taskId)

  /** A commit or null, as the window named it: checked against this repository. */
  const commitOrNull = async (root: string, oid: unknown): Promise<string | null> => {
    if (oid === null || oid === undefined) return null
    if (!isOid(oid) || (await d.git.objectType(root, oid)) !== 'commit') throw new Error('Not a commit in this repository.')
    return oid
  }

  /**
   * Records what the person reviewed: the snapshot, HEAD and merge-base the window was showing, never the files as
   * they are at the click, which another agent may have changed since. Says whether the files have changed since.
   */
  async function record(projectId: string, taskId: string, root: string, reason: ReviewMark['reason'], shown: Shown | null): Promise<{ mark: ReviewMark; changedSince: boolean }> {
    let tree: string
    let head: string | null
    let base: string | null
    let mergeBase: string | null
    let changedSince = false
    if (shown) {
      if (!isOid(shown.tree) || (await d.git.objectType(root, shown.tree)) !== 'tree') throw new Error('The changes shown are no longer known to Patchbay. Refresh them first.')
      tree = shown.tree
      head = await commitOrNull(root, shown.head)
      base = shown.base === undefined ? null : baseName(shown.base)
      mergeBase = await commitOrNull(root, shown.mergeBase)
      changedSince = (await snapshot(root)) !== tree
    } else {
      tree = await snapshot(root)
      head = await d.git.head(root)
      base = await baseFor(projectId, taskId, root)
      const baseOid = base ? await d.git.resolveCommit(root, base).catch(() => null) : null
      mergeBase = head && baseOid ? await d.git.mergeBase(root, head, baseOid) : null
    }
    const mark: ReviewMark = { id: randomUUID(), projectId, taskId, root, head, tree, at: now(), reason, ...(base ? { base, mergeBase } : {}) }
    d.data.update((data) => pruneReviewData({ ...data, marks: [...data.marks, mark] }, () => false))
    return { mark, changedSince }
  }

  return {
    async inbox(projectId: string): Promise<InboxItem[]> {
      // Records of tasks that are gone are dropped. A project whose task records couldn't be read is left alone.
      const doc = d.store.get()
      const gone = (pid: string, tid: string): boolean => {
        const project = doc.projects.find((p) => p.id === pid)
        if (!project) return true
        return !!project.tasks && !project.tasks.tasks.some((t) => t.id === tid)
      }
      if (pruneReviewData(d.data.get(), gone) !== d.data.get()) d.data.update((data) => pruneReviewData(data, gone))
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
        if (d.data.get().bases[taskKey(projectId, taskId)] !== name) d.data.update((data) => ({ ...data, bases: { ...data.bases, [taskKey(projectId, taskId)]: name } }))
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

    async comments(projectId: string, taskId: string, tree?: string): Promise<CommentView[]> {
      const task = findTask(projectId, taskId)
      const list = commentsFor(projectId, taskId)
      const root = await d.git.toplevel(task.cwd)
      if (!root) return list.map((c) => ({ ...c, placement: { kind: 'outdated', reason: 'The task folder is no longer in a git repository.' }, state: c.status === 'resolved' ? 'resolved' : 'outdated' }))
      return place(projectId, taskId, root, list, isOid(tree) ? tree : undefined)
    },

    /** Main reads the line and its context from git itself; the window only names the line. */
    async addComment(projectId: string, taskId: string, c: { path: string; side: ReviewSide; line: number; revision: string; text: string; section: ChangeSection; base?: string }): Promise<CommentView> {
      const task = findTask(projectId, taskId)
      const root = await rootOf(task)
      if (!c?.text?.trim()) throw new Error('Write the comment first.')
      if (c.side !== 'new' && c.side !== 'old') throw new Error('A comment is on the new or the old side of a diff.')
      const path = repoPath(c.path)
      const type = await d.git.objectType(root, c.revision)
      if (type !== 'commit' && type !== 'tree') throw new Error('Not a revision in this repository.')
      if (!['committed', 'local', 'since-review'].includes(c.section)) throw new Error('A comment is on the committed, local or since-review list.')
      const base = c.section === 'committed' && c.base !== undefined ? baseName(c.base) : undefined
      const text = await d.git.fileAt(root, c.revision, path)
      if (text === 'too-large') throw new Error(`${path} is too large for Patchbay to anchor a comment in.`)
      const at = text === null ? null : anchorAt(fileLines(text), c.line)
      if (!at) throw new Error(`Line ${c.line} isn't in ${path} at that revision.`)
      const comment: ReviewComment = {
        id: randomUUID(), projectId, taskId, text: c.text.trim(), status: 'open', createdAt: now(),
        anchor: { path, side: c.side, revision: c.revision, revisionKind: type === 'commit' ? 'commit' : 'snapshot', ...at, section: c.section, ...(base ? { base } : {}) }
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

    /** Records the revision the window was showing as reviewed. */
    async markReviewed(projectId: string, taskId: string, shown: Shown): Promise<{ mark: ReviewMark; changedSince: boolean }> {
      if (!shown) throw new Error('Load the changes first, so it is clear what was reviewed.')
      return record(projectId, taskId, await rootOf(findTask(projectId, taskId)), 'marked', shown)
    },

    /**
     * Sends every unresolved comment to one of the task's own agents, through the send queue, and records what was
     * reviewed so the next look can be "changes since last review".
     */
    async requestFixes(projectId: string, taskId: string, sessionId: string, shown: Shown | null = null): Promise<{ queued: boolean; sent: number; to: string; recorded: boolean; changedSince: boolean }> {
      const view = await taskView(projectId, taskId)
      const task = view.task
      if (!task.assignedSessionIds.includes(sessionId)) throw new Error('Fixes go to an agent assigned to this task.')
      const agent = nodes().find((n) => n.id === sessionId)
      if (agent?.kind !== 'claude') throw new Error('That agent is no longer on the canvas.')
      const root = await rootOf(task)
      const comments = await place(projectId, taskId, root, commentsFor(projectId, taskId), shown?.tree)
      const unresolved = comments.filter((c) => c.state !== 'resolved')
      if (!unresolved.length) throw new Error('There are no open comments to send.')
      const branch = await d.git.branch(root)
      let mark: ReviewMark | null = null
      let changedSince = false
      try { ({ mark, changedSince } = await record(projectId, taskId, root, 'fixes-requested', shown)) } catch { /* Sent anyway; the result says it wasn't recorded. */ }
      const head = mark ? mark.head : await d.git.head(root)
      const reviewed = `${branch ?? 'detached HEAD'} at ${short(head)} in ${root}${mark?.base ? `, against ${mark.base} (merge-base ${short(mark.mergeBase)})` : ''}, uncommitted changes included`
      const r = d.send(sessionId, formatFixRequest(task, unresolved, reviewed))
      if (!r.ok) {
        if (mark) d.data.update((data) => ({ ...data, marks: data.marks.filter((m) => m.id !== mark!.id) }))
        throw new Error(r.reason)
      }
      const ids = new Set(unresolved.map((c) => c.id))
      const at = now()
      d.data.update((data) => ({ ...data, comments: data.comments.map((c) => (ids.has(c.id) ? { ...c, sentAt: at } : c)) }))
      return { queued: r.queued, sent: unresolved.length, to: agent.title, recorded: !!mark, changedSince }
    }
  }
}
