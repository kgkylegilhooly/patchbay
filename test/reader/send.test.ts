import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { formatComments } from '../../src/core/reader/comments'
import { outline } from '../../src/core/reader/outline'
import { sendToAgent } from '../../src/main/agentMessages'
import { createSendQueue } from '../../src/main/control/sendQueue'
import type { AgentStatus, ClaudeNode } from '../../src/shared/model'
import type { ReaderComment } from '../../src/shared/reader'
import { memoryStore } from '../control/fakes'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const doc = outline('# Plan\n\n## Rollout\n\nEvery user at once.\n')
const comments: ReaderComment[] = [
  { id: '1', anchor: null, text: 'Looks right.', createdAt: 1, resolved: false },
  { id: '2', anchor: { section: ['Plan', 'Rollout'], quote: 'Every user at once.' }, text: 'Batches of 100.\nStaff first.', createdAt: 2, resolved: false }
]

test("a reader's comments reach the agent as one paste, line breaks intact, then Enter", () => {
  const agent: ClaudeNode = { id: 'a', kind: 'claude', title: 'Planner', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:/w', sessionId: null, transcriptPath: null, after: [] }
  const store = memoryStore([agent])
  const writes: string[] = []
  let status: AgentStatus = 'idle'
  const listeners: Array<(id: string, s: AgentStatus) => void> = []
  const queue = createSendQueue({
    host: { write: (_id, data) => void writes.push(data), isRunning: () => true },
    tracker: { get: () => status, onChange: (cb) => void listeners.push(cb) },
    exists: () => true
  })
  const text = formatComments({ title: 'Plan', path: 'C:\\w\\plan.md', comments, doc })

  expect(sendToAgent({ store, status: () => status, queue }, 'a', text)).toEqual({ ok: true, queued: false })
  // The agent takes it and starts working, as Claude Code does, so no second Enter goes.
  vi.advanceTimersByTime(250)
  status = 'working'
  for (const cb of listeners) cb('a', 'working')
  vi.advanceTimersByTime(5000)

  expect(writes).toEqual([`\x1b[200~${text}\x1b[201~`, '\r'])
  expect(writes[0]).toContain('\n\n1. On the whole document:\n   Looks right.\n2. In "Plan > Rollout", on: "Every user at once."\n   Batches of 100.\n   Staff first.')
})
