import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { BranchInfo, CommitRow, DiffResult, GitOutcome, RepoStatus } from '../../shared/git'
import {
  branchesArgs,
  commitArgs,
  createBranchArgs,
  diffArgs,
  discardArgs,
  fetchArgs,
  GLOBAL,
  logArgs,
  plainBranchName,
  pullArgs,
  pushArgs,
  stageArgs,
  statusArgs,
  switchArgs,
  unstageArgs
} from './args'
import { layoutGraph, parseBranches, parseLog, parseStatusV2 } from './parse'
import { runProgram, type RunResult } from './run'

const MB = 1024 * 1024
/** How long each kind of call may take before it's ended. Network calls get the longest. */
export const LIMITS = {
  read: { timeoutMs: 15000, maxBytes: 8 * MB },
  write: { timeoutMs: 30000, maxBytes: MB },
  commit: { timeoutMs: 120000, maxBytes: MB },
  network: { timeoutMs: 120000, maxBytes: MB },
  diff: { timeoutMs: 15000, maxBytes: 2 * MB }
}
const UNTRACKED_PREVIEW = 256 * 1024

export class GitFailure extends Error {}

export interface Git {
  (cwd: string, args: string[], limit: { timeoutMs: number; maxBytes: number }): Promise<RunResult>
}

/** The real git, with prompts off. `env` is already cleaned by the caller. */
export function systemGit(env: Record<string, string>): Git {
  return (cwd, args, limit) => runProgram('git', [...GLOBAL, '-C', cwd, ...args], { env, ...limit })
}

/** What went wrong, in git's own words, plus a plain hint for the failures people most often hit. */
export function describeFailure(r: RunResult, what: string): string {
  if (r.missing) return 'git was not found on PATH.'
  if (r.timedOut) return `${what} took too long and was stopped. If it was waiting to sign in, sign in with git in a terminal first.`
  const said = `${r.stderr}\n${r.stdout}`.trim() || `git ended with code ${r.code}.`
  const auth = /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey\)|HTTP 401|HTTP 403|Repository not found/i
  if (auth.test(said)) return `${said}\n\nThis looks like a sign-in problem. Patchbay never asks for passwords: set up a credential helper or SSH key, then try again.`
  return said
}

export function createGitService(git: Git) {
  const ok = async (cwd: string, args: string[], limit = LIMITS.read, what = `git ${args[0]}`): Promise<string> => {
    const r = await git(cwd, args, limit)
    if (r.code !== 0) throw new GitFailure(describeFailure(r, what))
    return r.stdout
  }
  const outcome = async (cwd: string, args: string[], limit: { timeoutMs: number; maxBytes: number }): Promise<GitOutcome> => {
    const r = await git(cwd, args, limit)
    if (r.code !== 0) return { ok: false, error: describeFailure(r, `git ${args[0]}`) }
    return { ok: true, output: `${r.stdout}${r.stderr}`.trim() }
  }

  async function status(root: string): Promise<RepoStatus> {
    return parseStatusV2(await ok(root, statusArgs()))
  }

  async function toplevel(folder: string): Promise<string | null> {
    if (!folder || !isAbsolute(folder)) return null
    const r = await git(folder, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000, maxBytes: 64 * 1024 })
    return r.code === 0 && r.stdout.trim() ? resolve(r.stdout.trim()) : null
  }

  /** The path must be inside the repository, so nothing outside it can be read. */
  function inside(root: string, path: string): string {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new GitFailure(`Not a file in this repository: ${path}`)
    return full
  }

  async function diff(root: string, path: string, staged: boolean): Promise<DiffResult> {
    const s = await status(root)
    if (!staged && s.unstaged.some((e) => e.path === path && e.area === 'untracked')) {
      const full = inside(root, path)
      const size = (await stat(full)).size
      const bytes = (await readFile(full)).subarray(0, UNTRACKED_PREVIEW)
      if (bytes.includes(0)) return { text: '', truncated: false, binary: true }
      const body = bytes.toString('utf8').split('\n').map((l) => `+${l}`).join('\n')
      return { text: `New, untracked file: ${path}\n${body}`, truncated: size > UNTRACKED_PREVIEW, binary: false }
    }
    const r = await git(root, diffArgs(path, staged), LIMITS.diff)
    if (r.code !== 0) throw new GitFailure(describeFailure(r, 'git diff'))
    return { text: r.stdout, truncated: r.truncated, binary: /^Binary files /m.test(r.stdout) }
  }

  async function stage(root: string, paths: string[] | 'all'): Promise<GitOutcome> {
    if (paths !== 'all' && paths.length === 0) return { ok: true, output: '' }
    return outcome(root, stageArgs(paths), LIMITS.write)
  }

  async function unstage(root: string, paths: string[] | 'all'): Promise<GitOutcome> {
    if (paths !== 'all' && paths.length === 0) return { ok: true, output: '' }
    const s = await status(root)
    return outcome(root, unstageArgs(paths, s.oid !== null), LIMITS.write)
  }

  /** Checks each path against the status now, so a list that has gone stale can't delete something it didn't show. */
  async function discard(root: string, paths: string[]): Promise<GitOutcome> {
    const s = await status(root)
    const tracked = new Set(s.unstaged.filter((e) => e.area === 'unstaged').map((e) => e.path))
    const untracked = new Set(s.unstaged.filter((e) => e.area === 'untracked').map((e) => e.path))
    const unknown = paths.filter((p) => !tracked.has(p) && !untracked.has(p))
    if (unknown.length) return { ok: false, error: `These no longer have changes to discard, so nothing was done: ${unknown.join(', ')}` }
    let output = ''
    for (const args of discardArgs(paths.filter((p) => tracked.has(p)), paths.filter((p) => untracked.has(p)))) {
      const r = await outcome(root, args, LIMITS.write)
      if (!r.ok) return r
      output += r.output
    }
    return { ok: true, output }
  }

  async function commit(root: string, message: string): Promise<GitOutcome> {
    if (!message.trim()) return { ok: false, error: 'Write a commit message first.' }
    const s = await status(root)
    if (s.staged.length === 0) return { ok: false, error: 'Nothing is staged. Stage the changes to commit first.' }
    return outcome(root, commitArgs(message), LIMITS.commit)
  }

  async function branches(root: string): Promise<BranchInfo[]> {
    return parseBranches(await ok(root, branchesArgs()))
  }

  async function switchTo(root: string, branch: string): Promise<GitOutcome> {
    const all = await branches(root)
    const target = all.find((b) => b.name === branch)
    if (!target) return { ok: false, error: `There is no branch "${branch}".` }
    // A remote branch someone already has locally is just switched to.
    const local = target.remote ? all.find((b) => !b.remote && b.upstream === target.name) : undefined
    // Never --force or --discard-changes: git's own refusal is what keeps uncommitted work safe.
    return outcome(root, local ? switchArgs(local.name, false) : switchArgs(target.name, target.remote), LIMITS.write)
  }

  async function createBranch(root: string, branch: string): Promise<GitOutcome> {
    if (!plainBranchName(branch)) return { ok: false, error: `"${branch}" can't be a branch name. Use letters, numbers, - _ . and /.` }
    const check = await git(root, ['check-ref-format', '--branch', branch], LIMITS.read)
    if (check.code !== 0 || check.stdout.trim() !== branch) return { ok: false, error: `"${branch}" can't be a branch name.` }
    if ((await branches(root)).some((b) => !b.remote && b.name === branch)) return { ok: false, error: `A branch named "${branch}" already exists.` }
    return outcome(root, createBranchArgs(branch), LIMITS.write)
  }

  async function push(root: string): Promise<GitOutcome> {
    const s = await status(root)
    if (!s.branch) return { ok: false, error: 'HEAD is detached, so there is no branch to push. Switch to a branch first.' }
    const remotes = (await ok(root, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean)
    if (!s.upstream && remotes.length === 0) return { ok: false, error: 'This repository has no remote to push to.' }
    const remote = remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : null
    if (!s.upstream && !remote) return { ok: false, error: `This branch has no upstream, and there are several remotes (${remotes.join(', ')}). Push it once from a terminal to choose.` }
    const r = await outcome(root, pushArgs({ branch: s.branch, upstream: s.upstream, remote }), LIMITS.network)
    return r.ok && !r.output ? { ok: true, output: 'Pushed.' } : r
  }

  const pull = (root: string, mode: 'ff-only' | 'merge'): Promise<GitOutcome> => outcome(root, pullArgs(mode), LIMITS.network)
  const fetch = async (root: string): Promise<GitOutcome> => {
    const r = await outcome(root, fetchArgs(), LIMITS.network)
    return r.ok && !r.output ? { ok: true, output: 'Fetched. Nothing new.' } : r
  }

  async function log(root: string): Promise<{ rows: CommitRow[]; truncated: boolean }> {
    const s = await status(root)
    if (s.oid === null) return { rows: [], truncated: false }
    const r = await git(root, logArgs(), LIMITS.read)
    if (r.code !== 0) throw new GitFailure(describeFailure(r, 'git log'))
    return { rows: layoutGraph(parseLog(r.stdout)), truncated: r.truncated }
  }

  async function originUrl(root: string): Promise<string | null> {
    const r = await git(root, ['remote', 'get-url', 'origin'], LIMITS.read)
    return r.code === 0 ? r.stdout.trim() : null
  }

  return { status, toplevel, diff, stage, unstage, discard, commit, branches, switchTo, createBranch, push, pull, fetch, log, originUrl }
}

export type GitService = ReturnType<typeof createGitService>
