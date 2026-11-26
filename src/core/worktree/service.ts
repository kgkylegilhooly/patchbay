import { execFile } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import { readdir, rmdir, unlink } from 'node:fs/promises'
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

/** `base`, a full commit id, is where the new branch starts. Absent means HEAD. */
export async function createWorktree(args: { repo: string; branch: string; path?: string; base?: string }): Promise<Worktree> {
  const repo = await repoRoot(args.repo)
  await assertValidBranch(repo, args.branch)
  await assertHasCommit(repo)
  await assertBranchIsNew(repo, args.branch)
  const path = args.path ? resolve(repo, args.path) : defaultWorktreePath(repo, args.branch)
  // A base is a commit id, so it can't be mistaken for an option.
  if (args.base !== undefined && !/^[0-9a-f]{40}([0-9a-f]{24})?$/i.test(args.base)) throw new Error(`Not a full commit id: "${args.base}"`)
  try {
    await git(repo, 'worktree', 'add', '-b', args.branch, path, ...(args.base ? [args.base] : []))
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
    const status = await git(wt.path, '-c', 'core.fsmonitor=false', 'status', '--porcelain', '--untracked-files=normal')
    return status.trim() === '' ? { ok: true } : { ok: false, reason: 'The worktree has uncommitted changes.' }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}

/**
 * Every link in a folder, not followed: symbolic links and, on Windows, junctions, which Node reports as links. The
 * worktree's own .git is a file, but a folder of that name is passed over all the same.
 */
async function linksIn(dir: string, out: string[] = []): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) out.push(path)
    else if (entry.isDirectory() && entry.name !== '.git') await linksIn(path, out)
  }
  return out
}

/**
 * Takes out each link itself. rmdir removes a junction or a folder link and nothing it points at, and can't remove a
 * real folder that has anything in it; unlink is for a link to a file, and can't remove a folder.
 */
export async function takeOutLinks(path: string): Promise<RemoveResult> {
  for (const link of await linksIn(path)) {
    try {
      await rmdir(link).catch(() => unlink(link))
    } catch (e) {
      return { ok: false, reason: `Couldn't take out the link ${link} first, so the worktree wasn't removed: ${(e as Error).message}` }
    }
  }
  return { ok: true }
}

export async function removeWorktree(wt: Worktree): Promise<RemoveResult> {
  const removable = await checkRemovable(wt)
  if (!removable.ok) return removable
  // git deletes ignored files with the worktree, and on Windows it deletes what a junction points at rather than the
  // junction (seen with git 2.45.1): a linked node_modules would empty the one it shares. So the links go first.
  const unlinked = await takeOutLinks(wt.path)
  if (!unlinked.ok) return unlinked
  try {
    // Never --force: git's own checks are a second guard against losing work.
    await git(wt.repo, 'worktree', 'remove', wt.path)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
}
