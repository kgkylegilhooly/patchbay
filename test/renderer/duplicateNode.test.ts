import { expect, test } from 'vitest'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'
import { duplicateOf } from '../../src/renderer/duplicateNode'

const box = { x: 100, y: 100, width: 560, height: 340, parentId: null, projectId: 'p' }
const nodes = {
  shell: { ...box, id: 't', kind: 'terminal', title: 'PowerShell 7', cwd: 'C:\\w', profile: 'pwsh', command: 'npm test' },
  ssh: { ...box, id: 's', kind: 'terminal', title: 'build', cwd: '/home/me', sshHost: 'me@build' },
  codex: { ...box, id: 'c', kind: 'claude', agent: 'codex', title: 'Review', cwd: 'C:\\w', prompt: 'Review it', sessionId: 'x', transcriptPath: 'C:\\t', after: [] },
  run: { ...box, id: 'r', kind: 'run', title: 'npm test', cwd: 'C:\\w', command: 'npm test' }
} as unknown as Record<string, CanvasNode>
const doc = { version: 3, projects: [{ id: 'p', name: 'P', folder: 'C:\\w', viewport: { x: 0, y: 0, zoom: 1 } }], activeProjectId: 'p', nodes: Object.values(nodes), edges: [], closed: [], viewport: { x: 0, y: 0, zoom: 1 } } as unknown as CanvasDoc
const at = (src: CanvasNode) => ({ beside: src, group: null, doc, view: null })
const profiles = (id: string | undefined) => (id === 'pwsh' ? { id: 'pwsh', name: 'PowerShell 7' } : undefined)

test('a terminal duplicates as a fresh shell in the same folder and profile, never its command', () => {
  const copy = duplicateOf(nodes.shell, at(nodes.shell), 'new', profiles)
  expect(copy).toMatchObject({ id: 'new', kind: 'terminal', cwd: 'C:\\w', profile: 'pwsh' })
  expect(copy).not.toHaveProperty('command')
  // Beside the original, not on top of it.
  expect(copy!.x === nodes.shell.x && copy!.y === nodes.shell.y).toBe(false)
})

test('an SSH terminal duplicates to the same host; an agent to the same kind and folder with nothing to do yet', () => {
  expect(duplicateOf(nodes.ssh, at(nodes.ssh), 'new', profiles)).toMatchObject({ kind: 'terminal', sshHost: 'me@build', cwd: '/home/me' })
  const agent = duplicateOf(nodes.codex, at(nodes.codex), 'new', profiles)
  expect(agent).toMatchObject({ kind: 'claude', agent: 'codex', cwd: 'C:\\w', sessionId: null, transcriptPath: null })
  expect((agent as { prompt?: string }).prompt ?? '').toBe('')
  expect(duplicateOf(nodes.run, at(nodes.run), 'new', profiles)).toBeNull()
})
