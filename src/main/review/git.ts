import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { gitEnvFrom, GLOBAL, plainBranchName } from '../../core/git/args'
import { runProgram, type RunResult } from '../../core/git/run'
import type { ChangedFile, ChangeSection } from '../../shared/reviewInbox'
import { cleanEnv } from '../sessions/env'

/** git's id for the empty tree: what a repository with no commits is compared from. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
export const isOid = (s: unknown): s is string => typeof s === 'string' && OID.test(s)

const READ = { timeoutMs: 20_000, maxBytes: 8 * 1024 * 1024 }
const SNAPSHOT = { timeoutMs: 120_000, maxBytes: 1024 * 1024 }
const DIFF = { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 }
/** Listing every object a snapshot holds: one id a line, for every file in the checkout. */
const OBJECTS = { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 }

export type RunGit = (cwd: string, args: string[], limit: { timeoutMs: number; maxBytes: number }, extraEnv?: Record<string, string>) => Promise<RunResult>

/** The real git, with prompts off and nothing inherited pointing it at another repository or index. */
export function systemReviewGit(): RunGit {
  const env = gitEnvFrom(cleanEnv(process.env, {}))
  return (cwd, args, limit, extraEnv) => runProgram('git', [...GLOBAL, '-C', cwd, ...args], { env: { ...env, ...extraEnv }, ...limit })
}

/** A path inside the repository, as git names it. Anything that could read as an option or leave the repository is refused. */
export function repoPath(path: unknown): string {
  if (typeof path !== 'string' || !path || path.startsWith('-') || isAbsolute(path) || path.split(/[\\/]/).includes('..') || /[\0\r\n]/.test(path)) {
    throw new Error(`Not a file in this repository: ${String(path)}`)
  }
  return path.replace(/\\/g, '/')
}

/** A base branch name, local or remote. */
export function baseName(name: unknown): string {
  if (typeof name !== 'string' || !plainBranchName(name)) throw new Error(`"${String(name)}" can't be a base branch name.`)
  return name
}

/**
 * Review git. `objectsRoot` is a folder of Patchbay's own: snapshots of working trees are written there, one object
 * store per repository, with the repository's objects read through git's alternates. So a snapshot adds nothing to the
 * repository, and what was reviewed lasts until Patchbay itself removes it.
 */
export function createReviewGit(objectsRoot: string, run: RunGit = systemReviewGit()) {
  const fail = (r: RunResult, args: string[]): Error =>
    new Error(r.missing ? 'git was not found on PATH.' : r.timedOut ? `git ${args[0]} took too long.` : r.truncated ? `git ${args[0]} gave more output than Patchbay reads.` : (r.stderr.trim() || `git ${args[0]} ended with code ${r.code}`))

  /** Where each repository's review objects go, worked out once per repository folder. */
  const stores = new Map<string, Promise<Record<string, string>>>()
  const storeEnv = (root: string): Promise<Record<string, string>> => {
    const key = root.toLowerCase()
    let env = stores.get(key)
    if (!env) {
      env = (async () => {
        const r = await run(root, ['rev-parse', '--git-common-dir'], READ)
        if (r.code !== 0) throw fail(r, ['rev-parse'])
        const common = resolve(root, r.stdout.trim())
        const own = join(objectsRoot, createHash('sha256').update(common.toLowerCase()).digest('hex').slice(0, 16))
        await mkdir(join(own, 'pack'), { recursive: true })
        await mkdir(join(own, 'info'), { recursive: true })
        return { GIT_OBJECT_DIRECTORY: own, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(common, 'objects') }
      })()
      env.catch(() => stores.delete(key))
      stores.set(key, env)
    }
    return env
  }
  /** The review object folder of a repository: `<objectsRoot>/<16 hex of its git folder>`. */
  const storeDir = async (root: string): Promise<string> => (await storeEnv(root)).GIT_OBJECT_DIRECTORY
  /** Every call on a repository sees its own objects and Patchbay's review objects. */
  const inRepo = async (root: string, args: string[], limit = READ, extraEnv: Record<string, string> = {}): Promise<RunResult> =>
    run(root, args, limit, { ...(await storeEnv(root)), ...extraEnv })
  const ok = async (root: string, args: string[], limit = READ, extraEnv?: Record<string, string>): Promise<string> => {
    const r = await inRepo(root, args, limit, extraEnv)
    if (r.code !== 0 || r.truncated) throw fail(r, args)
    return r.stdout
  }
  const maybe = async (root: string, args: string[]): Promise<string | null> => {
    const r = await inRepo(root, args, READ)
    return r.code === 0 && !r.truncated ? r.stdout.trim() : null
  }

  async function toplevel(folder: string): Promise<string | null> {
    if (!folder || !isAbsolute(folder)) return null
    const r = await run(folder, ['rev-parse', '--show-toplevel'], READ)
    const out = r.code === 0 ? r.stdout.trim() : ''
    return out ? resolve(out) : null
  }

  const head = (root: string): Promise<string | null> => maybe(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  const branch = (root: string): Promise<string | null> => maybe(root, ['symbolic-ref', '--short', '-q', 'HEAD'])

  /**
   * A tree of the whole working tree as it is, untracked files included and ignored ones left out, written through a
   * copy of the checkout's index into Patchbay's own object store. The repository, its index, files and refs are never
   * touched.
   */
  async function snapshot(root: string): Promise<string> {
    const index = join(tmpdir(), `patchbay-review-${randomUUID()}.index`)
    const env = { GIT_INDEX_FILE: index }
    try {
      const real = resolve(root, (await ok(root, ['rev-parse', '--git-path', 'index'])).trim())
      let copied = true
      // The copy keeps git's record of file times, so unchanged files aren't read again.
      await copyFile(real, index).catch(() => { copied = false })
      if (!copied) {
        const h = await head(root)
        await ok(root, h ? ['read-tree', h] : ['read-tree', '--empty'], READ, env)
      }
      await ok(root, ['add', '-A', '--', '.'], SNAPSHOT, env)
      const tree = (await ok(root, ['write-tree'], READ, env)).trim()
      if (!isOid(tree)) throw new Error('git did not return a snapshot tree')
      return tree
    } finally {
      await rm(index, { force: true }).catch(() => {})
      await rm(`${index}.lock`, { force: true }).catch(() => {})
    }
  }

  async function resolveCommit(root: string, ref: string): Promise<string | null> {
    return maybe(root, ['rev-parse', '--verify', '-q', `${baseName(ref)}^{commit}`])
  }

  const mergeBase = (root: string, a: string, b: string): Promise<string | null> => maybe(root, ['merge-base', a, b])

  async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
    return (await inRepo(root, ['merge-base', '--is-ancestor', a, b], READ)).code === 0
  }

  async function objectType(root: string, oid: string): Promise<string | null> {
    if (!isOid(oid)) return null
    return maybe(root, ['cat-file', '-t', oid])
  }

  /**
   * The files changed between two revisions, a renamed file once, as a rename (git's own detection: at least half the
   * same). Fails rather than return a list cut short.
   */
  async function changed(root: string, from: string, to: string, section: ChangeSection): Promise<ChangedFile[]> {
    return parseNameStatus(await ok(root, ['diff', '--no-ext-diff', '-M', '--name-status', '-z', from, to, '--']), section)
  }

  /** Where each file renamed between two revisions went: old path to new. Empty when either revision is gone. */
  async function renames(root: string, from: string, to: string): Promise<Map<string, string>> {
    const out = new Map<string, string>()
    if (!isOid(from) || !isOid(to)) return out
    const r = await inRepo(root, ['diff', '--no-ext-diff', '-M', '--diff-filter=R', '--name-status', '-z', from, to, '--'], READ)
    if (r.code !== 0 || r.truncated) return out
    for (const f of parseNameStatus(r.stdout, 'local')) if (f.oldPath) out.set(f.oldPath, f.path)
    return out
  }

  /** One file's diff. A renamed file is named by both its paths, so git shows the rename and what changed in it. */
  async function diff(root: string, from: string, to: string, path: string, oldPath?: string): Promise<{ text: string; truncated: boolean }> {
    const paths = oldPath && oldPath !== path ? [repoPath(oldPath), repoPath(path)] : [repoPath(path)]
    const r = await inRepo(root, ['diff', '--no-ext-diff', '--no-color', '-M', from, to, '--', ...paths], DIFF)
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git diff failed')
    return { text: r.stdout, truncated: r.truncated }
  }

  /** A file's text at a commit or tree: null when it isn't there, 'too-large' when it's past what Patchbay reads. */
  async function fileAt(root: string, rev: string, path: string): Promise<string | null | 'too-large'> {
    if (!isOid(rev)) return null
    const r = await inRepo(root, ['cat-file', 'blob', `${rev}:${repoPath(path)}`], READ)
    if (r.truncated) return 'too-large'
    return r.code === 0 ? r.stdout : null
  }

  async function branches(root: string): Promise<string[]> {
    const out = await ok(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/remotes'])
    return out.split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD') && plainBranchName(s))
  }

  /** The branch work is usually compared with: the remote's default, as a local branch when there is one, then main, then master. */
  async function defaultBase(root: string): Promise<string | null> {
    const all = new Set(await branches(root).catch(() => [] as string[]))
    const remoteDefault = await maybe(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'])
    if (remoteDefault) {
      const local = remoteDefault.replace(/^origin\//, '')
      if (all.has(local)) return local
      if (all.has(remoteDefault)) return remoteDefault
    }
    for (const name of ['main', 'master']) if (all.has(name)) return name
    return null
  }

  /**
   * Every object the given revisions hold, through the repository and the review store both. Revisions or objects that
   * are already gone are passed over, so a half-pruned snapshot can't stop the rest being listed.
   */
  async function reachable(root: string, revisions: string[]): Promise<Set<string>> {
    const out = new Set<string>()
    const valid = [...new Set(revisions.filter(isOid))]
    // A few hundred at a time, well inside Windows' command line limit.
    for (let i = 0; i < valid.length; i += 400) {
      const text = await ok(root, ['rev-list', '--objects', '--no-object-names', '--ignore-missing', '--missing=allow-any', ...valid.slice(i, i + 400)], OBJECTS)
      for (const line of text.split('\n')) if (isOid(line.trim())) out.add(line.trim())
    }
    return out
  }

  return { objectsRoot, toplevel, head, branch, snapshot, storeDir, reachable, renames, resolveCommit, mergeBase, isAncestor, objectType, changed, diff, fileAt, branches, defaultBase }
}

export type ReviewGit = ReturnType<typeof createReviewGit>

/** `git diff --name-status -z` as files. A rename or copy (R or C, and a score) names the old path, then the new. */
export function parseNameStatus(out: string, section: ChangeSection): ChangedFile[] {
  const parts = out.split('\0')
  const files: ChangedFile[] = []
  for (let i = 0; i < parts.length; ) {
    const status = parts[i]
    if (!status) { i++; continue }
    const letter = status.slice(0, 1)
    if ((letter === 'R' || letter === 'C') && i + 2 < parts.length) {
      files.push({ status: letter, oldPath: parts[i + 1], path: parts[i + 2], section })
      i += 3
    } else if (i + 1 < parts.length) {
      files.push({ status: letter, path: parts[i + 1], section })
      i += 2
    } else break
  }
  return files
}
