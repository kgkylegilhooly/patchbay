import { ipcMain } from 'electron'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import type { CanvasStore } from '../../shared/contract'
import type { AgentStatus } from '../../shared/model'
import { AGENT_ID } from '../../shared/subagents'
import { readSubagentTranscript } from './transcript'
import { readTranscriptAsync } from '../../core/transcript/read'
import { createSubagentWatcher, subagentDir, watchedParents } from './watcher'
import { createCodexCards, type CodexCards } from './codexCards'
import { agentOf } from '../../shared/model'

let codexCards: CodexCards | null = null
let nudge: (() => void) | null = null
/**
 * A hook from a window, for Codex's subagent cards (SubagentStart, SubagentStop). Called from the control server's
 * hook route; does nothing before setupSubagents has run, or for any other hook.
 */
export function noteSubagentHook(nodeId: string, payload: Record<string, unknown>, parentTranscript: string | null): void {
  if (!codexCards || (payload.hook_event_name !== 'SubagentStart' && payload.hook_event_name !== 'SubagentStop')) return
  codexCards.noteHook(nodeId, payload, parentTranscript)
  nudge?.()
}

/** Subagent cards. One call from src/main/index.ts. See docs/plans/subagent-cards.md. */
export function setupSubagents(d: {
  store: CanvasStore
  tracker: { get(id: string): AgentStatus; onChange(cb: (id: string, status: AgentStatus) => void): void }
  broadcast(channel: string, ...args: unknown[]): void
  log?(line: string): void
}): void {
  const codex = createCodexCards({ log: d.log })
  codexCards = codex
  const codexParents = () =>
    d.store.get().nodes.flatMap((n) => {
      if (n.kind !== 'claude' || agentOf(n) !== 'codex') return []
      const s = d.tracker.get(n.id)
      return [{ nodeId: n.id, transcriptPath: n.transcriptPath, busy: s === 'working' || s === 'needs-you', exited: s === 'exited' }]
    })
  const watcher = createSubagentWatcher({
    parents: () => watchedParents(d.store, (id) => d.tracker.get(id)),
    push: (snapshot) => d.broadcast('pb:subagents:onCards', snapshot),
    log: d.log,
    also: { refresh: () => codex.refresh(codexParents()), snapshot: () => codex.snapshot() }
  })
  nudge = () => void watcher.tick()
  // A turn starts when a window goes to work from anything but waiting on the person, which is the same turn.
  const before = new Map<string, AgentStatus>()
  d.tracker.onChange((id, status) => {
    const was = before.get(id)
    before.set(id, status)
    if (status === 'working' && was !== 'working' && was !== 'needs-you') {
      watcher.turnStarted(id)
      codex.turnStarted(id)
    }
    void watcher.tick()
  })

  ipcMain.handle('pb:subagents:get', () => watcher.snapshot())
  ipcMain.handle('pb:subagents:transcript', async (_e, nodeId: unknown, agentId: unknown) => {
    const node = d.store.get().nodes.find((n) => n.id === nodeId)
    if (node?.kind !== 'claude' || !node.transcriptPath) return { ok: false, reason: 'That window has no conversation.' }
    if (typeof agentId !== 'string' || !AGENT_ID.test(agentId)) return { ok: false, reason: 'No such subagent.' }
    if (agentOf(node) === 'codex') {
      // Only a rollout a hook or the search beside the parent named for this card: never a path the page gives.
      const rollout = codex.transcriptOf(node.id, agentId)
      if (!rollout) return { ok: false, reason: "Codex hasn't said where this subagent's conversation is yet. It does when the subagent stops." }
      const size = await stat(rollout).then((s) => s.size, () => -1)
      if (size < 0) return { ok: false, reason: 'This subagent left no transcript.' }
      if (size > 64 * 1024 * 1024) return { ok: false, reason: "This subagent's transcript is too large to show here." }
      return readTranscriptAsync(rollout).then((text) => ({ ok: true as const, text }), (e: unknown) => ({ ok: false as const, reason: `The transcript couldn't be read: ${(e as Error).message}` }))
    }
    try {
      const text = await readSubagentTranscript(join(subagentDir(node.transcriptPath), `agent-${agentId}.jsonl`))
      return { ok: true, text }
    } catch (e) {
      return { ok: false, reason: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'This subagent left no transcript.' : `The transcript couldn't be read: ${(e as Error).message}` }
    }
  })
}
