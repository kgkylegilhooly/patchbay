import { copyFile, mkdir, readdir, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { GLOBAL } from '../../core/git/args'
import { runProgram, type RunResult } from '../../core/git/run'

/**
 * A snapshot of a working copy as a git tree, made through a temporary copy of its index: the real index, refs and
 * stash are never touched. Its objects go to Patchbay's own object folder, with the repository's objects read as an
 * alternate, so the person's repository never grows from it, and Patchbay prunes that folder itself.
 *
 * What's in it: every tracked file as it is now, plus untracked files that aren't ignored, up to a size and a count.
 * Bigger untracked files are left out, and the snapshot says how many.
 */

export type RunGit = (cwd: string, args: string[], opts: { env?: Record<string, string>; maxBytes?: number }) => Promise<RunResult>

/**
 * The real git, with `base` as its environment. No fsmonitor daemon is started for a throwaway index, and none of the
 * repository's own programs need to run for a look.
 */
export function gitRunner(base: Record<string, string>, timeoutMs = 20_000): RunGit {
  return (cwd, args, opts) =>
    runProgram('git', [...GLOBAL, '-c', 'core.fsmonitor=false', '-C', cwd, ...args], { env: { ...base, ...(opts.env ?? {}) }, timeoutMs, maxBytes: opts.maxBytes ?? 256 * 1024 })
}

/** git's tree with nothing in it, for a repository with no commit yet. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

/** Untracked files bigger than this are left out of a snapshot. */
export const UNTRACKED_MAX_BYTES = 1024 * 1024
/** At most this many untracked files go in one snapshot. */
export const UNTRACKED_MAX_FILES = 5000

export interface SnapshotStore {
  /** Holds the index copy for the moment a snapshot takes. */
  tmpDir: string
  /** Patchbay's own git object folder. */
  objectDir: string
}

export type Snapshot =
  | { ok: true; root: string; tree: string; head: string | null; /** The repository's object folder, read as an alternate. */ objects: string; /** Untracked files left out. */ skipped: number }
  | { ok: false; root: string | null; problem: string }

const said = (r: RunResult): string => (r.missing ? 'git was not found on PATH.' : r.timedOut ? 'git took too long.' : (r.stderr || r.stdout).trim().split('\n')[0] || `git ended with code ${r.code}.`)

/** Where git reads and writes objects for a snapshot or its diff. */
export function objectEnv(store: Pick<SnapshotStore, 'objectDir'>, repoObjects: string): Record<string, string> {
  return { GIT_OBJECT_DIRECTORY: store.objectDir, GIT_ALTERNATE_OBJECT_DIRECTORIES: repoObjects }
}

let made = 0

/** Snapshots the working copy that `cwd` is in. */
export async function snapshotTree(run: RunGit, cwd: string, store: SnapshotStore): Promise<Snapshot> {
  const where = await run(cwd, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], {})
  if (where.code !== 0) return { ok: false, root: null, problem: where.missing ? said(where) : 'Not in a git repository.' }
  const [top, gitDir, common] = where.stdout.trim().split(/\r?\n/)
  if (!top || !gitDir || !common) return { ok: false, root: null, problem: 'git did not say where the repository is.' }
  const root = resolve(top)
  const objects = join(isAbsolute(common) ? common : resolve(cwd, common), 'objects')
  await mkdir(store.objectDir, { recursive: true })
  await mkdir(store.tmpDir, { recursive: true })
  const stem = join(store.tmpDir, `snap-${process.pid}-${Date.now()}-${made++}`)
  const index = `${stem}.index`
  const list = `${stem}.paths`
  const env = { GIT_INDEX_FILE: index, ...objectEnv(store, objects) }
  try {
    // Starting from the real index lets git skip every tracked file whose size and time haven't changed.
    await copyFile(join(gitDir, 'index'), index).catch(() => undefined)
    const tracked = await run(root, ['add', '-u', '--', '.'], { env })
    if (tracked.code !== 0) return { ok: false, root, problem: said(tracked) }
    const others = await run(root, ['ls-files', '-o', '--exclude-standard', '-z'], { env, maxBytes: 8 * 1024 * 1024 })
    if (others.code !== 0) return { ok: false, root, problem: said(others) }
    const names = others.stdout.split('\0').filter(Boolean)
    const kept: string[] = []
    let skipped = 0
    for (const name of names) {
      // A folder here is a repository of its own inside this one, which a snapshot leaves alone.
      const size = await stat(join(root, name)).then((s) => (s.isFile() ? s.size : -1), () => -1)
      if (size < 0) continue
      if (size > UNTRACKED_MAX_BYTES || kept.length >= UNTRACKED_MAX_FILES) skipped++
      else kept.push(name)
    }
    if (kept.length) {
      await writeFile(list, kept.map((n) => `:(literal)${n}`).join('\0'))
      const add = await run(root, ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul'], { env })
      if (add.code !== 0) return { ok: false, root, problem: said(add) }
    }
    const tree = await run(root, ['write-tree'], { env })
    if (tree.code !== 0 || !/^[0-9a-f]{40,64}$/.test(tree.stdout.trim())) return { ok: false, root, problem: said(tree) }
    const head = await run(root, ['rev-parse', '--verify', '-q', 'HEAD'], {})
    return { ok: true, root, tree: tree.stdout.trim(), head: head.code === 0 ? head.stdout.trim() : null, objects, skipped }
  } finally {
    for (const f of [index, `${index}.lock`, list]) await rm(f, { force: true }).catch(() => undefined)
  }
}

/** A file's path inside a checkout, as git wants it, or null when it's outside. */
export function insideRoot(root: string, path: string): string | null {
  const rel = relative(root, path)
  if (!rel || rel.startsWith('..') || /^[a-zA-Z]:/.test(rel) || rel.startsWith('/')) return null
  return rel.replace(/\\/g, '/')
}

const DIFF_BYTES = 2 * 1024 * 1024

/** The change to one file between two trees. `env` says where their objects are: see objectEnv. */
export async function diffFile(
  run: RunGit,
  root: string,
  base: string,
  now: string,
  rel: string,
  env: Record<string, string> = {}
): Promise<{ ok: true; text: string; truncated: boolean } | { ok: false; reason: string }> {
  const r = await run(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', base, now, '--', `:(literal)${rel}`], { env, maxBytes: DIFF_BYTES })
  if (r.code !== 0) return { ok: false, reason: /bad object|unable to read|not a tree|bad revision/i.test(r.stderr) ? 'That snapshot is no longer kept.' : said(r) }
  return { ok: true, text: r.stdout, truncated: r.truncated }
}

/**
 * Keeps Patchbay's object folder bounded: loose objects older than `maxAgeMs` go, then the oldest until it's under
 * `maxBytes`. A snapshot whose objects have gone says so when its diff is asked for. Returns how many were removed.
 */
export async function pruneObjects(dir: string, maxAgeMs: number, maxBytes: number, now = Date.now()): Promise<number> {
  const all: { file: string; at: number; size: number }[] = []
  for (const sub of await readdir(dir).catch(() => [] as string[])) {
    if (!/^[0-9a-f]{2}$/.test(sub)) continue
    for (const name of await readdir(join(dir, sub)).catch(() => [] as string[])) {
      const file = join(dir, sub, name)
      const s = await stat(file).catch(() => null)
      if (s?.isFile()) all.push({ file, at: s.mtimeMs, size: s.size })
    }
  }
  all.sort((a, b) => a.at - b.at)
  let total = all.reduce((sum, o) => sum + o.size, 0)
  let removed = 0
  for (const o of all) {
    if (now - o.at <= maxAgeMs && total <= maxBytes) break
    await rm(o.file, { force: true }).catch(() => undefined)
    total -= o.size
    removed++
  }
  for (const sub of await readdir(dir).catch(() => [] as string[])) if (/^[0-9a-f]{2}$/.test(sub)) await rmdir(join(dir, sub)).catch(() => undefined)
  return removed
}
