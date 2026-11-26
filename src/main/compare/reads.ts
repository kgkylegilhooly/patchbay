import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { NO_FSMONITOR } from '../../core/git/args'
import { describeFailure, LIMITS, systemGit, type Git, type GitService } from '../../core/git/service'
import type { AttemptState, FileChange, SourceInfo } from '../../shared/compare'

/**
 * What a comparison reads from git. Every call here only reads: status, diff, log, rev-parse, rev-list and
 * merge-base, with optional locks off (gitEnvFrom), so looking at an attempt never changes it.
 */
export type CompareReads = ReturnType<typeof createCompareReads>

const SHOWN_UNCOMMITTED = 50
const SHOWN_IGNORED = 10
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

/** A file's whole content, read as a stream so there's no size limit. Null when it isn't there or can't be read. */
function hashFile(path: string): Promise<string | null> {
  return new Promise((done) => {
    const h = createHash('sha1')
    const s = createReadStream(path)
    s.on('data', (c) => h.update(c))
    s.on('error', () => done(null))
    s.on('end', () => done(h.digest('hex')))
  })
}

/**
 * The uncommitted changes as content: each changed or new file's path and full content. Two states with the same
 * fingerprint have the same files on disk, however large. Staging alone doesn't change it: what's on disk is the same.
 */
export async function fingerprintChanges(root: string, paths: string[]): Promise<string> {
  const h = createHash('sha1')
  for (const p of [...paths].sort()) {
    const content = await hashFile(resolve(root, p))
    h.update(`${p}\0${content ?? '-'}\0`)
  }
  return h.digest('hex')
}

/** A diff runs no program the attempt's own config names (GX1): no external diff, no textconv. */
const NO_DIFF_PROGRAMS = ['--no-ext-diff', '--no-textconv']

/** The git compare runs in attempts, which agents write, config included: no fsmonitor program either (GX1). */
export function compareGit(env: Record<string, string>): Git {
  return systemGit(env, NO_FSMONITOR)
}

export function createCompareReads(git: Git, service: Pick<GitService, 'status' | 'toplevel' | 'diff'>) {
  const run = (cwd: string, args: string[], limit = LIMITS.read) => git(cwd, args, limit)
  const out = async (cwd: string, args: string[], limit = LIMITS.read): Promise<string> => {
    const r = await run(cwd, args, limit)
    if (r.code !== 0) throw new Error(describeFailure(r, `git ${args[0]}`))
    if (r.truncated) throw new Error(`git ${args[0]} gave more output than can be read.`)
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

  /** Commits the worktree's HEAD has that no other local branch has: what deleting its branch would lose. */
  async function unmergedCount(path: string, branch: string | null): Promise<number> {
    // With --branches, --exclude takes the short name.
    const args = ['rev-list', '--count', 'HEAD', '--not', ...(branch ? [`--exclude=${branch}`] : []), '--branches']
    return Number((await out(path, args)).trim()) || 0
  }

  /** Git-ignored files and folders (a folder counts once), which removing the worktree deletes too. */
  async function ignored(path: string): Promise<{ count: number; first: string[] }> {
    const text = await out(path, ['status', '--porcelain=v1', '-z', '--ignored=traditional', '--untracked-files=normal'])
    const all = text.split('\0').filter((e) => e.startsWith('!! ')).map((e) => e.slice(3))
    return { count: all.length, first: all.slice(0, SHOWN_IGNORED) }
  }

  const numstat = async (path: string, from: string, to?: string): Promise<FileChange[]> => parseNumstat(await out(path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--numstat', from, ...(to ? [to] : []), '--'], LIMITS.diff))

  /** An attempt as it is now, against its base. */
  async function attempt(path: string, base: string): Promise<AttemptState> {
    if (!existsSync(path)) return { ok: false, gone: true, reason: `The worktree folder is gone: ${path}` }
    try {
      const c = await changedPaths(path)
      const head = c.head
      if (!head) return { ok: false, gone: false, reason: 'The worktree has no commit checked out.' }
      const [log, committed, uncommittedNum, ancestor, unmerged, changes] = await Promise.all([
        out(path, ['log', `--max-count=${MAX_COMMITS}`, '--format=%H%x09%s', `${base}..${head}`]),
        numstat(path, base, head),
        numstat(path, 'HEAD'),
        run(path, ['merge-base', '--is-ancestor', base, head]),
        unmergedCount(path, c.branch),
        fingerprintChanges(path, c.paths)
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
        committed,
        uncommitted: [...uncommittedNum, ...untracked],
        fromBase: ancestor.code === 0,
        unmerged,
        changes
      }
    } catch (e) {
      return { ok: false, gone: false, reason: (e as Error).message }
    }
  }

  /** One file's diff, for a file the attempt lists on that side now. Nothing else can be read through this. */
  async function fileDiff(path: string, base: string, file: string, side: 'committed' | 'uncommitted'): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }> {
    if (!existsSync(path)) return { ok: false, reason: `The worktree folder is gone: ${path}` }
    const rel = relative(path, resolve(path, file))
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return { ok: false, reason: `Not a file in this worktree: ${file}` }
    try {
      // Only the list for that side is read, not the whole state.
      let untracked = false
      let listed: boolean
      if (side === 'committed') listed = (await numstat(path, base, 'HEAD')).some((f) => f.path === file)
      else {
        const c = await changedPaths(path)
        untracked = c.untracked.includes(file)
        listed = c.paths.includes(file)
      }
      if (!listed) return { ok: false, reason: `${file} has no ${side} changes now.` }
      if (untracked) {
        const d = await service.diff(path, file, false)
        return { ok: true, text: d.binary ? `New, untracked binary file: ${file}` : d.text, truncated: d.truncated }
      }
      const r = await run(path, side === 'committed' ? ['diff', ...NO_DIFF_PROGRAMS, '--no-renames', base, 'HEAD', '--', file] : ['diff', ...NO_DIFF_PROGRAMS, '--no-renames', 'HEAD', '--', file], LIMITS.diff)
      if (r.code !== 0) return { ok: false, reason: describeFailure(r, 'git diff') }
      return { ok: true, text: r.stdout, truncated: r.truncated }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  return { source, isCommit, branchExists, attempt, fileDiff, unmergedCount, ignored }
}

