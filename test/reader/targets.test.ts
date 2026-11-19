import { describe, expect, it } from 'vitest'
import type { CanvasDoc, ClaudeNode } from '../../src/shared/model'
import { changedAgo, readerTargets, slug } from '../../src/renderer/reader/targets'

const agent = (id: string, cwd: string): ClaudeNode => ({ id, kind: 'claude', title: id, x: 0, y: 0, width: 1, height: 1, parentId: null, cwd, sessionId: null, transcriptPath: null, after: [] })
const doc = (nodes: ClaudeNode[], edges: CanvasDoc['edges'] = []): CanvasDoc => ({ version: 3, projects: [], activeProjectId: 'p', nodes, edges, closed: [], viewport: { x: 0, y: 0, zoom: 1 } })

describe('readerTargets', () => {
  const reader = { id: 'r', path: 'C:/work/app/docs/plan.md', fromNodeId: 'writer' }

  it('puts the agent the document came from first, then linked agents, then agents working where the file is', () => {
    const d = doc([agent('other', 'D:/elsewhere'), agent('local', 'C:/work/app'), agent('linked', 'D:/x'), agent('writer', 'D:/y')], [{ id: 'e', from: 'linked', to: 'r', kind: 'link' }])
    expect(readerTargets(d, reader).map((a) => a.id)).toEqual(['writer', 'linked', 'local', 'other'])
  })

  it('does not count a folder that only starts with the same letters', () => {
    const d = doc([agent('near', 'C:/work/ap'), agent('local', 'c:/work/app/')])
    expect(readerTargets(d, { id: 'r', path: reader.path }).map((a) => a.id)).toEqual(['local', 'near'])
  })

  it('has no one to send to without agents', () => {
    expect(readerTargets(null, reader)).toEqual([])
  })
})

describe('changedAgo', () => {
  it('says how long ago in plain words', () => {
    expect(changedAgo(0, 10_000)).toBe('just now')
    expect(changedAgo(0, 5 * 60_000)).toBe('5 min ago')
    expect(changedAgo(0, 3 * 3600_000)).toBe('3 h ago')
    expect(changedAgo(0, 30 * 3600_000)).toBe('yesterday')
    expect(changedAgo(0, 4 * 86400_000)).toBe('4 days ago')
  })
})

describe('slug', () => {
  it('makes GitHub-style heading anchors', () => {
    expect(slug('Phase 2: switch reads')).toBe('phase-2-switch-reads')
    expect(slug('Risks & rollback')).toBe('risks--rollback')
  })
})
