import { join } from 'node:path'
import { gitEnvFrom } from '../../core/git/args'
import { LIMITS, systemGit, type GitService } from '../../core/git/service'
import { createWorktree, removeWorktree } from '../../core/worktree/service'
import type { CanvasStore } from '../../shared/contract'
import { cleanEnv } from '../sessions/env'
import { registerCompareIpc } from './ipc'
import { createCompareReads } from './reads'
import { createCompareService } from './service'
import { createVerifyRunner } from './verifyRunner'

/** Comparisons of two attempts in separate worktrees. One call from src/main/index.ts. See docs/plans/compare.md. */
export function setupCompare(d: {
  store: CanvasStore
  runner: { startNode(id: string): Promise<void>; stopNode(id: string): Promise<void> }
  git: GitService
  dataDir: string
  launcher: string
}): void {
  const git = systemGit(gitEnvFrom(cleanEnv(process.env, {})))
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
    runVerify: createVerifyRunner({ launcher: d.launcher, planDir: join(d.dataDir, 'compare'), node: process.execPath, env: { ...cleanEnv(process.env, {}), ELECTRON_RUN_AS_NODE: '1' } })
  })
  registerCompareIpc({ service, inspect: (folder) => reads.source(folder) })
}
