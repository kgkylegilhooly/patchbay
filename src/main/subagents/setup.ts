import { ipcMain } from 'electron'
import { join } from 'node:path'
import type { CanvasStore } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import { AGENT_ID } from '../../shared/subagents'
import { readSubagentTranscript } from './transcript'
import { createSubagentWatcher, subagentDir, watchedParents } from './watcher'

/** Subagent cards. One call from src/main/index.ts. See docs/plans/subagent-cards.md. */
export function setupSubagents(d: {
  store: CanvasStore
  tracker: { get(id: string): AgentStatus; onChange(cb: (id: string, status: AgentStatus) => void): void }
  broadcast(channel: string, ...args: unknown[]): void
  log?(line: string): void
}): void {
  const watcher = createSubagentWatcher({
    parents: () => watchedParents(d.store, (id) => d.tracker.get(id)),
    push: (snapshot) => d.broadcast('pb:subagents:onCards', snapshot),
    log: d.log
  })
  // A turn starts when a window goes to work from anything but waiting on the person, which is the same turn.
  const before = new Map<string, AgentStatus>()
  d.tracker.onChange((id, status) => {
    const was = before.get(id)
    before.set(id, status)
    if (status === 'working' && was !== 'working' && was !== 'needs-you') watcher.turnStarted(id)
    void watcher.tick()
  })

  ipcMain.handle('pb:subagents:get', () => watcher.snapshot())
  ipcMain.handle('pb:subagents:transcript', async (_e, nodeId: unknown, agentId: unknown) => {
    const node = d.store.get().nodes.find((n) => n.id === nodeId)
    if (node?.kind !== 'claude' || !node.transcriptPath) return { ok: false, reason: 'That window has no conversation.' }
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return { ok: false, reason: 'No such subagent.' }
    try {
      const text = await readSubagentTranscript(join(subagentDir(node.transcriptPath), `agent-${agentId}.jsonl`))
      return { ok: true, text }
    } catch (e) {
      return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'This subagent left no transcript.' : `The transcript couldn't be read: ${(e as Error).message}` }
    }
  })
}
