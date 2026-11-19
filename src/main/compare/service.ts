import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative } from 'node:path'
import type { RunResult } from '../../core/git/run'
import type { CanvasStore } from '../../shared/contract'
import {
  ATTEMPT_KEYS,
  attemptLabel,
  attemptPrompt,
  COMPARE_SCHEMA,
  confirmCovers,
  describeLoss,
  readComparisonFile,
  removalNeeds,
  startProblem,
  tailOutput,
  titleFor,
  verifyArgv,
  type Attempt,
  type AttemptKey,
  type Comparison,
  type RemovalCheck,
  type RemoveResult,
  type StartComparison,
  type StartResult
} from '../../shared/compare'
import { AGENT_NAMES, isSessionNode, type CanvasNode, type ClaudeNode, type GroupNode } from '../../shared/model'
import type { CompareReads } from './reads'

type Worktree = { path: string; branch: string; repo: string }

export interface CompareServiceDeps {
  store: CanvasStore
  runner: { startNode(id: string): Promise<void>; stopNode(id: string): Promise<void> }
  reads: CompareReads
  /** `<Patchbay data>/comparisons.json`. */
  file: string
  createWorktree(a: { repo: string; branch: string; base: string }): Promise<Worktree>
  /** Never forces: refuses a worktree with uncommitted changes. src/core/worktree/service.ts. */
  removeWorktree(wt: Worktree): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Removes a worktree whose uncommitted changes the person chose to lose, and deletes branches. */
  git(cwd: string, args: string[]): Promise<RunResult>
  /** Runs an argument list in a folder with no shell, and gives back its exit and output. */
  runVerify(argv: string[], cwd: string): Promise<RunResult>
  now?: () => number
  newId?: () => string
}

export type CompareService = ReturnType<typeof createCompareService>

const GAP = 40
const GROUP = { width: 668, height: 508 }
const AGENT = { x: 24, y: 64, width: 620, height: 420 }

const inside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

export function createCompareService(d: CompareServiceDeps) {
  const now = d.now ?? Date.now
  const newId = d.newId ?? randomUUID
  let all: Comparison[] = load()
  const verifying = new Set<string>()

  /** An unreadable file is kept aside, never overwritten silently. */
  function load(): Comparison[] {
    if (!existsSync(d.file)) return []
    try {
      return readComparisonFile(JSON.parse(readFileSync(d.file, 'utf8')))
    } catch {
      try {
        renameSync(d.file, `${d.file}.bad`)
      } catch {
        // Left where it is. The next save replaces it.
      }
      return []
    }
  }

  function save(): void {
    mkdirSync(dirname(d.file), { recursive: true })
    const tmp = `${d.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ schema: COMPARE_SCHEMA, comparisons: all }, null, 2))
    renameSync(tmp, d.file)
  }

  const find = (id: string): Comparison | undefined => all.find((c) => c.id === id)
  const update = (id: string, change: (c: Comparison) => Comparison): Comparison | null => {
    const c = find(id)
    if (!c) return null
    const next = change(c)
    all = all.map((x) => (x.id === id ? next : x))
    save()
    return next
  }
  const patchAttempt = (id: string, key: AttemptKey, patch: Partial<Attempt>): Comparison | null =>
    update(id, (c) => ({ ...c, attempts: c.attempts.map((a) => (a.key === key ? { ...a, ...patch } : a)) }))

  /** To the right of everything in the project, as a team or an issue's agent goes. */
  const spot = (projectId: string): { x: number; y: number } => {
    const top = d.store.get().nodes.filter((n) => n.projectId === projectId && !n.parentId)
    return top.length ? { x: Math.max(...top.map((n) => n.x + n.width)) + GAP, y: Math.min(...top.map((n) => n.y)) } : { x: 0, y: 0 }
  }

  /** One attempt's worktree group and its agent, started on the brief. */
  async function makeAttempt(req: StartComparison, key: AttemptKey, wt: Worktree, at: { x: number; y: number }, title: string): Promise<Attempt> {
    const a = req.attempts[ATTEMPT_KEYS.indexOf(key)]
    const prompt = attemptPrompt(req.brief, a.approach)
    const group: GroupNode = { id: newId(), kind: 'group', title: `${attemptLabel(key)} · ${AGENT_NAMES[a.agent]} · ${wt.branch}`, ...at, ...GROUP, parentId: null, projectId: req.projectId, worktree: wt }
    d.store.dispatch({ op: 'addNode', node: group })
    const node: ClaudeNode = {
      id: newId(), kind: 'claude', agent: a.agent, title: `Attempt ${attemptLabel(key)}: ${title}`, cwd: wt.path, prompt,
      sessionId: null, transcriptPath: null, after: [], ...AGENT, parentId: group.id, projectId: req.projectId
    }
    d.store.dispatch({ op: 'addNode', node: node as CanvasNode })
    await d.runner.startNode(node.id)
    return { key, agent: a.agent, approach: a.approach.trim(), prompt, branch: wt.branch, path: wt.path, nodeId: node.id, groupId: group.id }
  }

  /**
   * Two worktrees from the one commit the dialog showed, each with its own branch, group and agent. Everything that can
   * be checked is checked first. A failure after the first worktree is made leaves it in place, recorded, and says so.
   */
  async function start(req: StartComparison): Promise<StartResult> {
    if (!d.store.get().projects.some((p) => p.id === req?.projectId)) return { ok: false, reason: 'That project is gone.' }
    const info = await d.reads.source(String(req.source ?? ''))
    const problem = startProblem(req, info)
    if (problem || !info.ok) return { ok: false, reason: problem ?? 'The source checkout could not be read.' }
    if (!(await d.reads.isCommit(info.repo, req.base))) return { ok: false, reason: `The base commit ${req.base.slice(0, 10)} is not in ${info.repo}.` }
    const branches = req.attempts.map((a) => a.branch.trim())
    for (const b of branches) if (await d.reads.branchExists(info.repo, b)) return { ok: false, reason: `A branch named "${b}" already exists.` }

    const title = titleFor(req.brief)
    const comparison: Comparison = {
      id: newId(),
      projectId: req.projectId,
      title,
      brief: req.brief.trim(),
      base: { commit: req.base, branch: info.commit === req.base ? info.branch : null, source: info.source, repo: info.repo, uncommitted: info.uncommitted.length ? 'left-out' : 'none' },
      verify: (verifyArgv(req.verify ?? '') as { ok: true; argv: string[] | null }).argv,
      createdAt: now(),
      attempts: [],
      ...(req.taskId ? { taskId: String(req.taskId) } : {})
    }
    const at = spot(req.projectId)
    for (const [i, key] of ATTEMPT_KEYS.entries()) {
      let made: Worktree | null = null
      try {
        made = await d.createWorktree({ repo: info.repo, branch: branches[i], base: req.base })
        comparison.attempts.push(await makeAttempt(req, key, made, { x: at.x + i * (GROUP.width + GAP), y: at.y }, title))
      } catch (e) {
        // Nothing is taken back: a worktree may already hold work. What's left is said, and attempts made are recorded.
        const left = [
          ...comparison.attempts.map((a) => `attempt ${attemptLabel(a.key)}'s worktree ${a.path} on branch ${a.branch}, with its agent`),
          ...(made ? [`attempt ${attemptLabel(key)}'s worktree ${made.path} on branch ${made.branch}`] : [])
        ]
        const reason = `Attempt ${attemptLabel(key)} could not be made: ${(e as Error).message}${left.length ? ` Left in place: ${left.join('; ')}.` : ''}`
        if (!comparison.attempts.length) return { ok: false, reason }
        all = [...all, comparison]
        save()
        return { ok: false, reason, comparison }
      }
    }
    all = [...all, comparison]
    save()
    return { ok: true, comparison }
  }

  const attemptOf = (id: string, key: AttemptKey): { c: Comparison; a: Attempt } | { problem: string } => {
    const c = find(id)
    if (!c) return { problem: 'That comparison is gone.' }
    const a = c.attempts.find((x) => x.key === key)
    return a ? { c, a } : { problem: `This comparison has no attempt ${attemptLabel(key)}.` }
  }

  /** Runs the comparison's command in one attempt's worktree. Only the command itself can change files there. */
  async function verify(id: string, key: AttemptKey): Promise<{ ok: true; comparison: Comparison } | { ok: false; reason: string }> {
    const found = attemptOf(id, key)
    if ('problem' in found) return { ok: false, reason: found.problem }
    const { c, a } = found
    if (!c.verify) return { ok: false, reason: 'This comparison has no verification command.' }
    if (a.removed) return { ok: false, reason: 'This attempt\'s worktree was removed.' }
    const runKey = `${id}:${key}`
    if (verifying.has(runKey)) return { ok: false, reason: 'Verification is already running for this attempt.' }
    verifying.add(runKey)
    try {
      const before = await d.reads.attempt(a.path, c.base.commit)
      if (!before.ok) return { ok: false, reason: before.reason }
      const startedAt = now()
      const r = await d.runVerify(c.verify, a.path)
      const { output, truncated } = tailOutput(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ''}`)
      const result = { argv: c.verify, cwd: a.path, exitCode: r.code, startedAt, durationMs: Math.max(0, now() - startedAt), output, truncated: truncated || r.truncated, timedOut: r.timedOut, missing: r.missing, head: before.head, changes: before.changes }
      const next = patchAttempt(id, key, { verify: result })
      return next ? { ok: true, comparison: next } : { ok: false, reason: 'That comparison is gone.' }
    } finally {
      verifying.delete(runKey)
    }
  }

  /** Records the person's choice, and nothing else: no merge, commit, switch or removal. Null clears it. */
  async function choose(id: string, key: AttemptKey | null): Promise<{ ok: true; comparison: Comparison } | { ok: false; reason: string }> {
    const c = find(id)
    if (!c) return { ok: false, reason: 'That comparison is gone.' }
    if (key === null) {
      const next = update(id, ({ chosen: _gone, ...rest }) => rest)!
      return { ok: true, comparison: next }
    }
    const a = c.attempts.find((x) => x.key === key)
    if (!a) return { ok: false, reason: `This comparison has no attempt ${attemptLabel(key)}.` }
    const state = a.removed ? null : await d.reads.attempt(a.path, c.base.commit)
    const head = state?.ok ? state.head : null
    return { ok: true, comparison: update(id, (x) => ({ ...x, chosen: { key, at: now(), head } }))! }
  }

  /**
   * Removes one attempt's worktree, and its branch if asked. Anything that would lose work (uncommitted changes, or
   * commits only that branch has) is refused unless `confirm` says exactly what was shown and that is still true.
   */
  async function remove(id: string, key: AttemptKey, opts: { deleteBranch: boolean; confirm?: RemovalCheck }): Promise<RemoveResult> {
    const found = attemptOf(id, key)
    if ('problem' in found) return { ok: false, reason: found.problem }
    const { c, a } = found
    if (a.removed) return { ok: false, reason: 'This attempt\'s worktree was already removed.' }
    const deleteBranch = opts?.deleteBranch === true
    if (!existsSync(a.path)) {
      // Removed outside Patchbay. git keeps a note of it until pruned, which `git worktree prune` does.
      d.store.dispatch({ op: 'patchNode', id: a.groupId, patch: { worktree: null } as Partial<CanvasNode> })
      return { ok: true, comparison: patchAttempt(id, key, { removed: { at: now(), branchDeleted: false } })! }
    }
    const state = await d.reads.attempt(a.path, c.base.commit)
    if (!state.ok) return { ok: false, reason: state.reason }
    if (deleteBranch && state.branch !== a.branch) {
      return { ok: false, reason: `The worktree is on ${state.branch ? `branch ${state.branch}` : 'a detached HEAD'} now, not ${a.branch}, so its branch isn't deleted here. Remove the worktree only, and delete branches with git.` }
    }
    const needs = removalNeeds({ head: state.head, uncommitted: state.uncommitted.length, unmerged: state.unmerged }, deleteBranch)
    if (needs && !confirmCovers(needs, opts?.confirm)) {
      return { ok: false, needs, reason: `Removing attempt ${attemptLabel(key)} would lose ${describeLoss(needs, a.branch)}. Confirm this removal to go ahead.` }
    }

    // Windows won't delete a folder that a running process has open.
    const sessions = d.store.get().nodes.filter((n) => isSessionNode(n) && n.cwd && inside(a.path, n.cwd))
    await Promise.all(sessions.map((n) => d.runner.stopNode(n.id)))
    if (needs) {
      // A session may have written more before it stopped. What's lost must still be exactly what was confirmed.
      const after = await d.reads.attempt(a.path, c.base.commit)
      const now = after.ok ? removalNeeds({ head: after.head, uncommitted: after.uncommitted.length, unmerged: after.unmerged }, deleteBranch) : null
      if (!now || !confirmCovers(now, opts?.confirm)) {
        return { ok: false, ...(now ? { needs: now } : {}), reason: after.ok ? `Attempt ${attemptLabel(key)} changed while its sessions stopped. Look again before removing it.` : after.reason }
      }
    }
    const wt = { path: a.path, branch: a.branch, repo: c.base.repo }
    if (needs?.uncommitted) {
      // Confirmed for exactly these changes, above.
      const r = await d.git(c.base.repo, ['worktree', 'remove', '--force', a.path])
      if (r.code !== 0) return { ok: false, reason: `${r.stderr || r.stdout}`.trim() || 'git could not remove the worktree.' }
    } else {
      const r = await d.removeWorktree(wt)
      if (!r.ok) return r
    }
    d.store.dispatch({ op: 'patchNode', id: a.groupId, patch: { worktree: null } as Partial<CanvasNode> })
    let branchDeleted = false
    let note = ''
    if (deleteBranch) {
      // -D only when its commits were confirmed as lost; otherwise git's own -d refuses unmerged work.
      const r = await d.git(c.base.repo, ['branch', needs?.unmerged ? '-D' : '-d', '--', a.branch])
      branchDeleted = r.code === 0
      if (!branchDeleted) note = ` The worktree was removed, but the branch stays: ${`${r.stderr || r.stdout}`.trim()}`
    }
    const next = patchAttempt(id, key, { removed: { at: now(), branchDeleted } })!
    return note ? { ok: false, reason: note.trim() } : { ok: true, comparison: next }
  }

  /** Drops the record only. Worktrees, branches and agents stay as they are. */
  function forget(id: string): { ok: true } | { ok: false; reason: string } {
    if (!find(id)) return { ok: false, reason: 'That comparison is gone.' }
    all = all.filter((c) => c.id !== id)
    save()
    return { ok: true }
  }

  return {
    start,
    verify,
    choose,
    remove,
    forget,
    list: (projectId: string): Comparison[] => all.filter((c) => c.projectId === projectId).sort((x, y) => y.createdAt - x.createdAt),
    get: (id: string): Comparison | null => find(id) ?? null,
    async state(id: string, key: AttemptKey) {
      const found = attemptOf(id, key)
      if ('problem' in found) return { ok: false as const, gone: true, reason: found.problem }
      if (found.a.removed) return { ok: false as const, gone: true, reason: 'The worktree was removed.' }
      return d.reads.attempt(found.a.path, found.c.base.commit)
    },
    async diff(id: string, key: AttemptKey, path: string, side: 'committed' | 'uncommitted') {
      const found = attemptOf(id, key)
      if ('problem' in found) return { ok: false as const, reason: found.problem }
      if (found.a.removed) return { ok: false as const, reason: 'The worktree was removed.' }
      return d.reads.fileDiff(found.a.path, found.c.base.commit, String(path), side === 'committed' ? 'committed' : 'uncommitted')
    }
  }
}
