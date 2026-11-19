import { join } from 'node:path'
import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import type { CanvasStore } from '../../shared/contract'
import { REVIEW_METHODS, type ReviewBridge } from '../../shared/reviewInbox'
import type { SendResult } from '../agentMessages'
import type { TaskService } from '../tasks/service'
import { createReviewGit } from './git'
import { createReviewService } from './service'
import { createReviewStore } from './store'

/**
 * Serves `pb:review:*` (see src/preload/review.ts) to the app's own window only. The control server has no route to
 * these, so agents can't comment, resolve or record reviews. Acceptance stays P1's own `taskAccept`.
 */
export function registerReviewIpc(s: {
  dataDir: string
  store: CanvasStore
  tasks: TaskService
  send: (sessionId: string, text: string) => SendResult
  isAppUi: (e: IpcMainInvokeEvent) => boolean
  log?: (line: string) => void
}): void {
  const service = createReviewService({ store: s.store, tasks: s.tasks, data: createReviewStore(join(s.dataDir, 'review-inbox.json'), s.log), git: createReviewGit(join(s.dataDir, 'review-objects')), send: s.send })
  for (const name of REVIEW_METHODS) {
    ipcMain.handle(`pb:review:${name}`, async (e, ...args: unknown[]): Promise<Awaited<ReturnType<ReviewBridge[typeof name]>>> => {
      if (!s.isAppUi(e)) return { ok: false, error: 'The review inbox is available only in the application UI.' } as never
      try {
        return { ok: true, value: await (service[name] as (...a: unknown[]) => unknown)(...args) } as never
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) } as never
      }
    })
  }
}
