import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export interface Worktree {
  path: string
  branch: string
  repo: string
}

export type RemoveResult = { ok: true } | { ok: false; reason: string }

class GitError extends Error {}

/** Without this, an inherited variable would point every command at some other repository. */
function gitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[name]
  return env
}

/** Arguments go straight to git as an array, so no shell ever parses them. */
function git(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((done, fail) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      { env: gitEnv(), windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (!error) return done(stdout)
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail(new GitError('git was not found on PATH'))
        }
        fail(new GitError(stderr.trim().replace(/^(fatal|error): /gm, '') || error.message))
      }
    )
  })
}

function repoRoot(repo: string): Promise<string> {
  return git(repo, 'rev-parse', '--show-toplevel').then(
    (out) => resolve(out.trim()),
    () => {
      throw new Error(`Not a git repository: ${repo}`)
    }
  )
}

/** `--branch` also expands shorthand like `@{-1}`, so anything it changes isn't a literal name. */
async function assertValidBranch(root: string, branch: string): Promise<void> {
  const normalized = await git(root, 'check-ref-format', '--branch', branch).catch(() => null)
  if (normalized?.trim() !== branch) throw new Error(`Invalid branch name: "${branch}"`)
}

async function assertHasCommit(root: string): Promise<void> {
  await git(root, 'rev-parse', '--verify', '--quiet', 'HEAD^{commit}').catch(() => {
    throw new Error(`This repository has no commits yet: ${root}`)
  })
}

async function assertBranchIsNew(root: string, branch: string): Promise<void> {
  const found = await git(root, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`).then(
    () => true,
    () => false
  )
  if (found) throw new Error(`A branch named "${branch}" already exists`)
}

export function defaultWorktreePath(repo: string, branch: string): string {
  const root = resolve(repo)
  return join(dirname(root), `${basename(root)}-worktrees`, branch.replaceAll('/', '-'))
}

export async function createWorktree(args: { repo: string; branch: string; path?: string }): Promise<Worktree> {
  const repo = await repoRoot(args.repo)
  await assertValidBranch(repo, args.branch)
  await assertHasCommit(repo)
  await assertBranchIsNew(repo, args.branch)
  const path = args.path ? resolve(repo, args.path) : defaultWorktreePath(repo, args.branch)
  try {
    await git(repo, 'worktree', 'add', '-b', args.branch, path)
  } catch (e) {
    // git creates the branch before it checks the folder. Plain -d can't lose commits.
    await git(repo, 'branch', '-d', args.branch).catch(() => {})
    throw new Error(`Could not create worktree: ${(e as Error).message}`)
  }
  return { path, branch: args.branch, repo }
}

/** Whether removal would be refused. Lets a caller check before stopping the sessions in the folder. */
export async function checkRemovable(wt: Worktree): Promise<RemoveResult> {
  if (!existsSync(wt.path)) return { ok: false, reason: `The worktree folder no longer exists: ${wt.path}` }
  try {
    // The flag overrides a status.showUntrackedFiles setting that would hide new files.
    const status = await git(wt.path, 'status', '--porcelain', '--untracked-files=normal')
    return status.trim() === '' ? { ok: true } : { ok: false, reason: 'The worktree has uncommitted changes.' }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

export async function removeWorktree(wt: Worktree): Promise<RemoveResult> {
  const removable = await checkRemovable(wt)
  if (!removable.ok) return removable
  try {
    // Never --force: git's own checks are a second guard against losing work.
    await git(wt.repo, 'worktree', 'remove', wt.path)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}
