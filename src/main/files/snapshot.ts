import { copyFile, rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { GLOBAL } from '../../core/git/args'
import { runProgram, type RunResult } from '../../core/git/run'

/**
 * A snapshot of a working copy as a git tree, made through a temporary copy of its index: the real index, refs and
 * stash are never touched. Untracked files are included and ignored ones aren't, as `git add -A` would have it. The
 * tree's objects are unreferenced, so git's own gc removes them once they're old.
 */

export type RunGit = (cwd: string, args: string[], opts: { env?: Record<string, string>; maxBytes?: number }) => Promise<RunResult>

/** The real git, with `base` as its environment. */
export function gitRunner(base: Record<string, string>, timeoutMs = 20_000): RunGit {
  return (cwd, args, opts) => runProgram('git', [...GLOBAL, '-C', cwd, ...args], { env: { ...base, ...(opts.env ?? {}) }, timeoutMs, maxBytes: opts.maxBytes ?? 256 * 1024 })
}

/** git's tree with nothing in it, for a repository with no commit yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export type Snapshot = { ok: true; root: string; tree: string; head: string | null } | { ok: false; root: string | null; problem: string }

const said = (r: RunResult): string => (r.missing ? 'git was not found on PATH.' : r.timedOut ? 'git took too long.' : (r.stderr || r.stdout).trim().split('\n')[0] || `git ended with code ${r.code}.`)

let made = 0

/** Snapshots the working copy that `cwd` is in. `tmpDir` holds the index copy for the moment it takes. */
export async function snapshotTree(run: RunGit, cwd: string, tmpDir: string): Promise<Snapshot> {
  const where = await run(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir'], {})
  if (where.code !== 0) return { ok: false, root: null, problem: where.missing ? said(where) : 'Not in a git repository.' }
  const [top, gitDir] = where.stdout.trim().split(/\r?\n/)
  if (!top || !gitDir) return { ok: false, root: null, problem: 'git did not say where the repository is.' }
  const root = resolve(top)
  const index = join(tmpDir, `snap-${process.pid}-${Date.now()}-${made++}.index`)
  const env = { GIT_INDEX_FILE: index }
  try {
    // Starting from the real index lets git skip every file whose size and time haven't changed.
    await copyFile(join(gitDir, 'index'), index).catch(() => undefined)
    const add = await run(root, ['add', '-A', '--', '.'], { env })
    if (add.code !== 0) return { ok: false, root, problem: said(add) }
    const tree = await run(root, ['write-tree'], { env })
    if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree.stdout.trim())) return { ok: false, root, problem: said(tree) }
    const head = await run(root, ['rev-parse', '--verify', '-q', 'HEAD'], {})
    return { ok: true, root, tree: tree.stdout.trim(), head: head.code === 0 ? head.stdout.trim() : null }
  } finally {
    await rm(index, { force: true }).catch(() => undefined)
    await rm(`${index}.lock`, { force: true }).catch(() => undefined)
  }
}

/** A file's path inside a checkout, as git wants it, or null when it's outside. */
export function insideRoot(root: string, path: string): string | null {
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null
  return rel.replace(/\\/g, '/')
}

const DIFF_BYTES = 2 * 1024 * 1024

/** The change to one file between two trees. */
export async function diffFile(run: RunGit, root: string, base: string, now: string, rel: string): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }> {
  const r = await run(root, ['diff', '--no-ext-diff', '--no-color', base, now, '--', `:(literal)${rel}`], { maxBytes: DIFF_BYTES })
  if (r.code !== 0) return { ok: false, reason: said(r) }
  return { ok: true, text: r.stdout, truncated: r.truncated }
}
