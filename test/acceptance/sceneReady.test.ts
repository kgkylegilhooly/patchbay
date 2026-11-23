import { createRequire } from 'node:module'
import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const { expectedStatus, agentsToWaitFor, waitForAgents } = require('./sceneReady.cjs') as {
  expectedStatus(prompt: string | undefined): string | null
  agentsToWaitFor(doc: unknown): Array<{ id: string; want: string | null }>
  waitForAgents(page: unknown, doc: unknown, opts?: { timeoutMs?: number; everyMs?: number; log?: (line: string) => void }): Promise<boolean>
}
const { canvas } = require('./scenes.cjs') as { canvas(cwd: string): { nodes: Array<Record<string, unknown>>; projects: Array<Record<string, unknown>> } }

test("each fake-claude prompt's status, as fake-claude.cjs reaches it", () => {
  expect(expectedStatus('needs context=71')).toBe('needs-you')
  expect(expectedStatus('permission')).toBe('needs-you')
  expect(expectedStatus('working context=38')).toBe('working')
  expect(expectedStatus('fanout=6 working')).toBe('working')
  expect(expectedStatus('idle context=12')).toBe('idle')
  expect(expectedStatus('chat')).toBe('idle')
  expect(expectedStatus(undefined)).toBe('idle')
  expect(expectedStatus('unknown')).toBe('unknown')
  expect(expectedStatus('limit')).toBe('unknown')
  expect(expectedStatus('loginfail')).toBe('unknown')
  expect(expectedStatus('exit')).toBe('exited')
  // Changes on its own later, so only past starting.
  expect(expectedStatus('later=5')).toBeNull()
})

test("the canvas scene's agents, and only those the app starts by itself", () => {
  const doc = canvas('C:\\x')
  doc.nodes.push({ id: 'held', kind: 'claude', prompt: 'idle', after: ['idle'], projectId: 'p1' })
  doc.nodes.push({ id: 'cx', kind: 'claude', agent: 'codex', prompt: 'working', after: [], projectId: 'p1' })
  doc.projects.push({ id: 'p9', archivedAt: 1, closedAt: 1 })
  doc.nodes.push({ id: 'archived', kind: 'claude', prompt: 'idle', after: [], projectId: 'p9' })
  expect(agentsToWaitFor(doc)).toEqual([
    { id: 'needs', want: 'needs-you' },
    { id: 'work', want: 'working' },
    { id: 'idle', want: 'idle' },
    { id: 'unk', want: 'unknown' },
    { id: 'w-idle', want: 'idle' },
    // Codex's states come from fake-codex.cjs, so only past starting.
    { id: 'cx', want: null }
  ])
})

/** A page whose agents' statuses move on each time they're asked, as a busy machine's do: idle, then the real one. */
function slowPage(steps: Array<Record<string, string>>) {
  let i = 0
  return { evaluate: async () => steps[Math.min(i++, steps.length - 1)] }
}

test('waits until every agent shows what its prompt leads to, past the idle a busy machine shows first', async () => {
  const doc = { nodes: [{ id: 'needs', kind: 'claude', prompt: 'needs', after: [] }, { id: 'work', kind: 'claude', prompt: 'working', after: [] }], projects: [] }
  const page = slowPage([{}, { needs: 'starting', work: 'starting' }, { needs: 'idle', work: 'idle' }, { needs: 'working', work: 'working' }, { needs: 'needs-you', work: 'working' }])
  expect(await waitForAgents(page, doc, { everyMs: 1 })).toBe(true)
})

test('gives up after its limit, saying which agents never got there', async () => {
  const doc = { nodes: [{ id: 'needs', kind: 'claude', prompt: 'needs', after: [] }], projects: [] }
  const said: string[] = []
  expect(await waitForAgents(slowPage([{ needs: 'idle' }]), doc, { timeoutMs: 30, everyMs: 5, log: (l) => said.push(l) })).toBe(false)
  expect(said.join('\n')).toMatch(/needs.*needs-you.*idle/)
})

test("an agent that ended, as when the scene's settings turn Claude off, counts as settled at once", async () => {
  const doc = { nodes: [{ id: 'off', kind: 'claude', prompt: 'idle', after: [] }], projects: [] }
  expect(await waitForAgents(slowPage([{ off: 'exited' }]), doc, { timeoutMs: 30, everyMs: 5, log: () => {} })).toBe(true)
})
