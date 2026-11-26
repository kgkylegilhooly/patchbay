import { isAbsolute, join, resolve } from 'node:path'
import { gitEnvFrom } from '../../core/git/args'
import { LIMITS, type GitService } from '../../core/git/service'
import { createWorktree, removeWorktree } from '../../core/worktree/service'
import type { CanvasStore } from '../../shared/contract'
import { cleanEnv } from '../sessions/env'
import { knownFolders } from '../workIpc'
import { registerCompareIpc } from './ipc'
import { compareGit, createCompareReads } from './reads'
import { createCompareService } from './service'
import { createVerifyRunner } from './verifyRunner'
import { createCompareTaskLink } from './taskLink'

/** Comparisons of two attempts in separate worktrees. One call from src/main/index.ts. See docs/plans/compare.md. */
export function setupCompare(d: {
  store: CanvasStore
  runner: { startNode(id: string): Promise<void>; stopNode(id: string): Promise<void> }
  git: GitService
  dataDir: string
  launcher: string
  /** Saves the canvas document, where task records live, after a comparison writes to a task. */
  persist?: () => Promise<void>
}): void {
  const git = compareGit(gitEnvFrom(cleanEnv(process.env, {})))
  const reads = createCompareReads(git, d.git)
  const service = createCompareService({
    store: d.store,
    runner: d.runner,
    reads,
    file: join(d.dataDir, 'comparisons.json'),
    createWorktree,
    removeWorktree,
    git: (cwd, args) => git(cwd, args, LIMITS.write),
    // Electron's own binary, run as Node, so no separate Node install is needed.
    tasks: createCompareTaskLink({ store: d.store, dataDir: d.dataDir, persist: d.persist }),
    runVerify: createVerifyRunner({ launcher: d.launcher, planDir: join(d.dataDir, 'compare'), node: process.execPath, env: { ...cleanEnv(process.env, {}), ELECTRON_RUN_AS_NODE: '1' } })
  })
  // As with the git panel: only folders the canvas itself names can be read or worked from.
  const known = (folder: string): boolean => !!folder && isAbsolute(folder) && knownFolders(d.store.get()).has(resolve(folder).toLowerCase())
  registerCompareIpc({ service, inspect: (folder) => reads.source(folder), known })
}
