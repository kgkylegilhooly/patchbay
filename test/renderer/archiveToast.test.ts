import { expect, test } from 'vitest'
import { archivedToast } from '../../src/renderer/archiveToast'

const done = { ok: true as const, stopped: 2, stillRunning: [], freedBytes: 2048, clearedSites: [], keptSites: [] }

test('names the project and says what was stopped', () => {
  expect(archivedToast('p2', 'Website', done, false)).toEqual({ projectId: 'p2', headline: 'Archived Website. Stopped 2 sessions.', details: [], warnings: [] })
  expect(archivedToast('p2', 'Website', { ...done, stopped: 0 }, false).headline).toBe('Archived Website. Nothing was running.')
  expect(archivedToast('p2', 'Website', { ...done, stopped: 1 }, false).headline).toBe('Archived Website. Stopped 1 session.')
})

test('what was cleared is a detail, and only when it was asked for', () => {
  expect(archivedToast('p2', 'Website', done, true).details).toEqual(['Cleared 2 KB of saved terminal output.'])
  const sites = archivedToast('p2', 'Website', { ...done, clearedSites: ['http://localhost:3000'], keptSites: ['https://example.com'] }, false)
  expect(sites.details).toHaveLength(2)
  expect(sites.warnings).toEqual([])
})

test('sessions still running and a failed clear are warnings, which keep the toast up', () => {
  const t = archivedToast('p2', 'Website', { ...done, stillRunning: ['Dev server'], problem: 'Could not clear site data.' }, false)
  expect(t.warnings).toEqual(['Still running: Dev server. Stop it from the project after unarchiving.', 'Could not clear site data.'])
})
