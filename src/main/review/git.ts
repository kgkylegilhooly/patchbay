import { randomUUID } from 'node:crypto'
import { copyFile, rm } from 'node:fs/promises'
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

export function createReviewGit(run: RunGit = systemReviewGit()) {
  const ok = async (root: string, args: string[], limit = READ, extraEnv?: Record<string, string>): Promise<string> => {
    const r = await run(root, args, limit, extraEnv)
    if (r.code !== 0) throw new Error(r.missing ? 'git was not found on PATH.' : r.timedOut ? `git ${args[0]} took too long.` : (r.stderr.trim() || `git ${args[0]} ended with code ${r.code}`))
    return r.stdout
  }
  const maybe = async (root: string, args: string[]): Promise<string | null> => {
    const r = await run(root, args, READ)
    return r.code === 0 ? r.stdout.trim() : null
  }

  async function toplevel(folder: string): Promise<string | null> {
    if (!folder || !isAbsolute(folder)) return null
    const out = await maybe(folder, ['rev-parse', '--show-toplevel'])
    return out ? resolve(out) : null
  }

  const head = (root: string): Promise<string | null> => maybe(root, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'])
  const branch = (root: string): Promise<string | null> => maybe(root, ['symbolic-ref', '--short', '-q', 'HEAD'])

  /**
   * A tree of the whole working tree as it is, untracked files included and ignored ones left out, written through a
   * copy of the checkout's index. The real index, the files and the refs are never touched: only git objects are added.
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
    return (await run(root, ['merge-base', '--is-ancestor', a, b], READ)).code === 0
  }

  async function objectType(root: string, oid: string): Promise<string | null> {
    if (!isOid(oid)) return null
    return maybe(root, ['cat-file', '-t', oid])
  }

  async function changed(root: string, from: string, to: string, section: ChangeSection): Promise<ChangedFile[]> {
    const out = await ok(root, ['diff', '--no-ext-diff', '--no-renames', '--name-status', '-z', from, to, '--'])
    const parts = out.split('\0')
    const files: ChangedFile[] = []
    for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i]) files.push({ status: parts[i].slice(0, 1), path: parts[i + 1], section })
    return files
  }

  async function diff(root: string, from: string, to: string, path: string): Promise<{ text: string; truncated: boolean }> {
    const r = await run(root, ['diff', '--no-ext-diff', '--no-color', '--no-renames', from, to, '--', repoPath(path)], DIFF)
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'git diff failed')
    return { text: r.stdout, truncated: r.truncated }
  }

  /** A file's text at a commit or tree, or null when it isn't there. */
  async function fileAt(root: string, rev: string, path: string): Promise<string | null> {
    if (!isOid(rev)) return null
    const r = await run(root, ['cat-file', 'blob', `${rev}:${repoPath(path)}`], READ)
    return r.code === 0 && !r.truncated ? r.stdout : null
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

  return { toplevel, head, branch, snapshot, resolveCommit, mergeBase, isAncestor, objectType, changed, diff, fileAt, branches, defaultBase }
}

export type ReviewGit = ReturnType<typeof createReviewGit>
