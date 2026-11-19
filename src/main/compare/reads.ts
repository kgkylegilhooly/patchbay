import { createHash } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { describeFailure, LIMITS, type Git, type GitService } from '../../core/git/service'
import type { AttemptState, FileChange, SourceInfo } from '../../shared/compare'

/**
 * What a comparison reads from git. Every call here only reads: status, diff, log, rev-parse, rev-list and
 * merge-base, with optional locks off (gitEnvFrom), so looking at an attempt never changes it.
 */
export type CompareReads = ReturnType<typeof createCompareReads>

const SHOWN_UNCOMMITTED = 50
const MAX_COMMITS = 200

/** `--numstat` lines: added, removed, path. Binary files show `-` for both. */
export function parseNumstat(text: string): FileChange[] {
  const out: FileChange[] = []
  for (const line of text.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(line)
    if (!m) continue
    out.push({ path: m[3], added: m[1] === '-' ? null : Number(m[1]), removed: m[2] === '-' ? null : Number(m[2]) })
  }
  return out
}

export function createCompareReads(git: Git, service: Pick<GitService, 'status' | 'toplevel' | 'diff'>) {
  const run = (cwd: string, args: string[], limit = LIMITS.read) => git(cwd, args, limit)
  const out = async (cwd: string, args: string[], limit = LIMITS.read): Promise<string> => {
    const r = await run(cwd, args, limit)
    if (r.code !== 0) throw new Error(describeFailure(r, `git ${args[0]}`))
    return r.stdout
  }

  /** Every changed path, once, as the git panel lists them. */
  const changedPaths = async (root: string): Promise<{ paths: string[]; untracked: string[]; branch: string | null; head: string | null }> => {
    const s = await service.status(root)
    const paths = [...new Set([...s.staged, ...s.unstaged, ...s.conflicts].map((e) => e.path))]
    return { paths, untracked: s.unstaged.filter((e) => e.area === 'untracked').map((e) => e.path), branch: s.branch, head: s.oid }
  }

  /** The source checkout as the start dialog shows it: its HEAD, branch and uncommitted changes. */
  async function source(folder: string): Promise<SourceInfo> {
    if (!folder || !isAbsolute(folder)) return { ok: false, reason: 'Choose a folder in a git repository first.' }
    const root = await service.toplevel(folder)
    if (!root) return { ok: false, reason: `Not in a git repository: ${folder}` }
    try {
      const c = await changedPaths(root)
      if (!c.head) return { ok: false, reason: `This repository has no commits yet: ${root}` }
      const subject = (await out(root, ['log', '-1', '--format=%s', c.head])).trim()
      return { ok: true, repo: root, source: root, commit: c.head, branch: c.branch, subject, uncommitted: c.paths.slice(0, SHOWN_UNCOMMITTED), uncommittedMore: Math.max(0, c.paths.length - SHOWN_UNCOMMITTED) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  async function isCommit(repo: string, commit: string): Promise<boolean> {
    const r = await run(repo, ['rev-parse', '--verify', '--quiet', `${commit}^{commit}`])
    return r.code === 0 && r.stdout.trim() === commit
  }

  async function branchExists(repo: string, branch: string): Promise<boolean> {
    return (await run(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0
  }

  /** Changes to untracked files show up too: each one's size and time go into the fingerprint. */
  const fingerprint = (diffText: string, root: string, untracked: string[]): string => {
    const h = createHash('sha1').update(diffText)
    for (const p of untracked) {
      try {
        const s = statSync(resolve(root, p))
        h.update(`\0${p}\0${s.size}\0${s.mtimeMs}`)
      } catch {
        h.update(`\0${p}`)
      }
    }
    return h.digest('hex')
  }

  /** Commits the worktree's HEAD has that no other local branch has: what deleting its branch would lose. */
  async function unmergedCount(path: string, branch: string | null): Promise<number> {
    const args = ['rev-list', '--count', 'HEAD', '--not', ...(branch ? [`--exclude=${branch}`] : []), '--branches']
    return Number((await out(path, args)).trim()) || 0
  }

  /** An attempt as it is now, against its base. */
  async function attempt(path: string, base: string): Promise<AttemptState> {
    if (!existsSync(path)) return { ok: false, gone: true, reason: `The worktree folder is gone: ${path}` }
    try {
      const c = await changedPaths(path)
      const head = c.head
      if (!head) return { ok: false, gone: false, reason: 'The worktree has no commit checked out.' }
      const range = `${base}..${head}`
      const [log, committed, uncommittedNum, diffText, ancestor, unmerged] = await Promise.all([
        out(path, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s', range]),
        out(path, ['diff', '--no-renames', '--numstat', base, head, '--']),
        out(path, ['diff', '--no-renames', '--numstat', 'HEAD', '--']),
        run(path, ['diff', '--no-renames', 'HEAD', '--'], LIMITS.diff),
        run(path, ['merge-base', '--is-ancestor', base, head]),
        unmergedCount(path, c.branch)
      ])
      const untracked: FileChange[] = c.untracked.map((p) => ({ path: p, added: null, removed: null, untracked: true }))
      return {
        ok: true,
        head,
        branch: c.branch,
        commits: log
          .split('\n')
          .filter(Boolean)
          .map((l) => ({ hash: l.slice(0, l.indexOf('\t')), subject: l.slice(l.indexOf('\t') + 1) })),
        committed: parseNumstat(committed),
        uncommitted: [...parseNumstat(uncommittedNum), ...untracked],
        fromBase: ancestor.code === 0,
        unmerged,
        changes: fingerprint(diffText.stdout, path, c.untracked)
      }
    } catch (e) {
      return { ok: false, gone: false, reason: (e as Error).message }
    }
  }

  /** One file's diff, for a file the attempt's state lists. Nothing else can be read through this. */
  async function fileDiff(path: string, base: string, file: string, side: 'committed' | 'uncommitted'): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }> {
    const state = await attempt(path, base)
    if (!state.ok) return { ok: false, reason: state.reason }
    const listed = (side === 'committed' ? state.committed : state.uncommitted).find((f) => f.path === file)
    if (!listed) return { ok: false, reason: `${file} has no ${side} changes now.` }
    const rel = relative(path, resolve(path, file))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `Not a file in this worktree: ${file}` }
    if (listed.untracked) {
      const d = await service.diff(path, file, false)
      return { ok: true, text: d.binary ? `New, untracked binary file: ${file}` : d.text, truncated: d.truncated }
    }
    const r = await run(path, side === 'committed' ? ['diff', '--no-renames', base, state.head!, '--', file] : ['diff', '--no-renames', 'HEAD', '--', file], LIMITS.diff)
    if (r.code !== 0) return { ok: false, reason: describeFailure(r, 'git diff') }
    return { ok: true, text: r.stdout, truncated: r.truncated }
  }

  return { source, isCommit, branchExists, attempt, fileDiff, unmergedCount }
}
