import { join } from 'node:path'
import { PREFLIGHT_TIMEOUT_MS } from '../../core/trigger/events'
import type { RunResult } from '../../shared/contract'
import { createVerifyRunner } from '../compare/verifyRunner'
import { cleanEnv } from '../sessions/env'
import { watchFolder } from './fileWatch'
import type { RunPreflight } from './service'

/**
 * What event triggers need from the app: run nodes ending, a way to run a check, and folder watching. The check runs
 * as compare's verification does, through resources/launch-run.cjs: no shell, `.cmd` scripts such as npm still work.
 */
export function triggerEventDeps(d: { runner: { onRun(cb: (id: string, run: RunResult) => void): void }; dataDir: string; launcher: string }) {
  const preflight: RunPreflight = createVerifyRunner({
    launcher: d.launcher,
    planDir: join(d.dataDir, 'triggers'),
    // Electron's own binary, run as Node, so no separate Node install is needed.
    node: process.execPath,
    env: { ...cleanEnv(process.env, {}), ELECTRON_RUN_AS_NODE: '1' },
    timeoutMs: PREFLIGHT_TIMEOUT_MS,
    keepBytes: 16 * 1024
  })
  return { runs: d.runner, preflight, watch: watchFolder }
}
