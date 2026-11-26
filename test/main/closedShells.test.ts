import { expect, test } from 'vitest'
import { outputKeptFor } from '../../src/shared/closedShells'
import type { CanvasDoc } from '../../src/shared/model'

// F48: a terminal's or run's saved output is kept while it's on the canvas or in the closed list, and only then.
test('saved output is kept for terminals and runs on the canvas or closed, not for agents', () => {
  const box = { x: 0, y: 0, width: 1, height: 1, parentId: null }
  const doc = {
    nodes: [
      { ...box, id: 't', kind: 'terminal', title: 't', cwd: 'C:/' },
      { ...box, id: 'r', kind: 'run', title: 'r', cwd: 'C:/', command: 'x' },
      { ...box, id: 'c', kind: 'claude', title: 'c', cwd: 'C:/', sessionId: null, transcriptPath: null, after: [] }
    ],
    closedShells: [{ node: { ...box, id: 'old', kind: 'terminal', title: 'old', cwd: 'C:/' }, closedAt: 1 }]
  } as unknown as CanvasDoc
  expect([...outputKeptFor(doc)].sort()).toEqual(['old', 'r', 't'])
})
