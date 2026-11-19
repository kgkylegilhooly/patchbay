import { expect, test } from 'vitest'
import { dropTarget } from '../../src/renderer/projectTabDrag'
import { archiveLines, daysAgo, projectRows, sortRows } from '../../src/renderer/projectsView'
import type { CanvasDoc, CanvasNode, Project } from '../../src/shared/model'
import type { ArchivePreview } from '../../src/shared/projects'

const DAY = 24 * 3600_000
const NOW = 1_000 * DAY
const view = { x: 0, y: 0, zoom: 1 }
const project = (id: string, over: Partial<Project> = {}): Project => ({ id, name: id, folder: '', viewport: view, ...over })
const term = (id: string, projectId: string): CanvasNode => ({
  id,
  kind: 'terminal',
  title: id,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  parentId: null,
  cwd: 'C:/x',
  projectId
})
const doc: CanvasDoc = {
  version: 3,
  projects: [project('here'), project('stale', { closedAt: 1 }), project('fresh'), project('gone', { closedAt: 1, archivedAt: 2 })],
  activeProjectId: 'here',
  nodes: [term('a', 'here'), term('b', 'stale'), term('c', 'stale')],
  edges: [],
  closed: [],
  viewport: view
}
const stats = [
  { id: 'here', scrollbackBytes: 10, running: 1, lastActiveAt: NOW },
  { id: 'stale', scrollbackBytes: 5000, running: 0, lastActiveAt: NOW - 45 * DAY },
  { id: 'fresh', scrollbackBytes: 0, running: 0, lastActiveAt: NOW - 3 * DAY },
  { id: 'gone', scrollbackBytes: 0, running: 0, lastActiveAt: NOW - 400 * DAY }
]

test('rows say each state, and count nodes and sessions', () => {
  const rows = projectRows(doc, stats, 0, NOW)
  expect(rows.map((r) => [r.project.id, r.state, r.nodes, r.sessions])).toEqual([
    ['here', 'open', 1, 1],
    ['stale', 'closed', 2, 2],
    ['fresh', 'open', 0, 0],
    ['gone', 'archived', 0, 0]
  ])
})

test('suggesting is off by default, and never flags the project on screen or an archived one', () => {
  expect(projectRows(doc, stats, 0, NOW).every((r) => r.unusedDays === null)).toBe(true)
  const flagged = projectRows(doc, stats, 30, NOW).filter((r) => r.unusedDays !== null)
  expect(flagged.map((r) => [r.project.id, r.unusedDays])).toEqual([['stale', 45]])
})

test('nothing is flagged before the measurements arrive', () => {
  expect(projectRows(doc, null, 14, NOW).every((r) => r.unusedDays === null && r.scrollbackBytes === null)).toBe(true)
})

test('sorting by a column, with unknown values last and ties in tab order', () => {
  const rows = projectRows(doc, stats, 0, NOW)
  expect(sortRows(rows, 'storage', true).map((r) => r.project.id)).toEqual(['stale', 'here', 'fresh', 'gone'])
  expect(sortRows(rows, 'lastActive', false).map((r) => r.project.id)).toEqual(['gone', 'stale', 'fresh', 'here'])
  expect(sortRows(rows, 'state', false).map((r) => r.project.id)).toEqual(['here', 'fresh', 'stale', 'gone'])
  expect(sortRows(projectRows(doc, null, 0, NOW), 'storage', false).map((r) => r.project.id)).toEqual(['here', 'stale', 'fresh', 'gone'])
})

test('last active reads as days', () => {
  expect(daysAgo(NOW, NOW)).toBe('today')
  expect(daysAgo(NOW - DAY, NOW)).toBe('yesterday')
  expect(daysAgo(NOW - 12 * DAY, NOW)).toBe('12 days ago')
  expect(daysAgo(NOW - 95 * DAY, NOW)).toBe('3 months ago')
  expect(daysAgo(null, NOW)).toBe('—')
})

test('the drop marker shows only where a drop would move the tab', () => {
  const tabs = [
    { id: 'a', mid: 50 },
    { id: 'b', mid: 150 },
    { id: 'c', mid: 250 }
  ]
  expect(dropTarget(tabs, 'c', 10)).toEqual({ before: 'a' })
  expect(dropTarget(tabs, 'a', 300)).toEqual({ before: null })
  expect(dropTarget(tabs, 'a', 200)).toEqual({ before: 'c' })
  // Over itself, or just after itself: it would stay where it is.
  expect(dropTarget(tabs, 'b', 120)).toBeNull()
  expect(dropTarget(tabs, 'b', 200)).toBeNull()
  expect(dropTarget(tabs, 'c', 300)).toBeNull()
})

test('the confirmation says what stops, what resumes and what is kept', () => {
  const preview: Extract<ArchivePreview, { ok: true }> = {
    ok: true,
    projectId: 'p',
    name: 'Old work',
    sessions: [
      { id: 'x', title: 'Fixer', kind: 'claude', running: true, resumable: true },
      { id: 'y', title: 'Dev shell', kind: 'terminal', running: true, resumable: false }
    ],
    browsers: [{ id: 'b', title: 'Docs', url: 'https://docs.test' }],
    triggers: [{ id: 't', title: 'Nightly' }],
    kept: { notes: 2, whiteboards: 1, groups: 0, board: true },
    scrollbackBytes: 0,
    sites: []
  }
  const lines = archiveLines(preview).join('\n')
  expect(lines).toContain('Stops 2 running sessions: “Fixer”, “Dev shell”.')
  expect(lines).toContain('Its agent keeps its conversation and resumes when you start it again. Transcripts are never deleted.')
  expect(lines).toContain('Closes 1 browser page.')
  expect(lines).toContain('Disarms 1 trigger: “Nightly”.')
  expect(lines).toContain('Keeps every node, 2 notes, 1 whiteboard, its board and the layout, as they are.')
})
