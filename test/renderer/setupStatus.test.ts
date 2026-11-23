import { describe, expect, test } from 'vitest'
import { agentLook } from '../../src/renderer/status/status'
import { sessionBlocked, setupHoldOf, setupLookFor } from '../../src/renderer/status/setupStatus'
import { teamStatus } from '../../src/renderer/teamStatus'
import { statusSections } from '../../src/renderer/sidebarView'
import { needsYouQueue } from '../../src/renderer/needsYou'
import { projectSignal } from '../../src/renderer/projectSignal'
import type { RunResult } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode, SetupWait } from '../../src/shared/model'

const box = { x: 0, y: 0, width: 100, height: 100 }
const viewport = { x: 0, y: 0, zoom: 1 }
const waiting: SetupWait = { steps: ['s'], after: [], recipe: 'Ship it' }
const failed: SetupWait = { ...waiting, failed: { step: 's', title: 'npm ci', exitCode: 1, why: 'exit' } }
const agent = (id: string, setupWait?: SetupWait): CanvasNode => ({ ...box, id, title: id, kind: 'claude', parentId: 'g', cwd: 'c', sessionId: null, transcriptPath: null, after: [], projectId: 'p', ...(setupWait ? { setupWait } : {}) })
const run = (id: string): CanvasNode => ({ ...box, id, title: id, kind: 'run', parentId: null, cwd: 'c', command: 'x', projectId: 'p' })
const result = (over: Partial<RunResult>): RunResult => ({ running: false, exitCode: 0, stoppedByYou: false, at: 1, ...over })
const docOf = (nodes: CanvasNode[]): CanvasDoc => ({
  version: 3, projects: [{ id: 'p', name: 'P', folder: '', viewport }], activeProjectId: 'p', nodes: [{ ...box, id: 'g', kind: 'group', title: 'Team', parentId: null, worktree: null, projectId: 'p' }, ...nodes], edges: [], closed: [], viewport
})

describe('a recipe agent held for its setup', () => {
  test('reads "Setup failed" (held) or "Waiting for setup" (pending), never "Queued"', () => {
    expect(setupHoldOf(agent('a', failed))).toBe('failed')
    expect(setupHoldOf(agent('a', waiting))).toBe('waiting')
    expect(setupHoldOf(agent('a'))).toBeUndefined()
    expect(agentLook('queued', undefined, 0, 'failed')).toMatchObject({ tone: 'held', label: 'Setup failed' })
    expect(agentLook('queued', undefined, 0, 'waiting')).toMatchObject({ tone: 'pending', label: 'Waiting for setup' })
    expect(agentLook('queued')).toMatchObject({ tone: 'pending', label: 'Queued' })
  })

  test('once it runs, its own status speaks again', () => {
    expect(setupLookFor('working', 'failed')).toBeNull()
    expect(agentLook('working', undefined, 0, 'failed').label).toBe('Working')
  })

  test('the group summary counts it as failed, first', () => {
    const team = teamStatus([agent('a', failed), agent('b', failed), agent('c')], { a: 'queued', b: 'queued', c: 'working' }, [], 'g')
    expect(team.summary).toBe('2 setup failed, 1 working')
    expect(team.members[0].look.tone).toBe('held')
    expect(teamStatus([agent('a', waiting)], { a: 'queued' }, [], 'g').summary).toBe('1 waiting for setup')
  })

  test('a failed setup is listed under Need attention, gone to by Next needing you, and lights its project tab', () => {
    const doc = docOf([agent('a', failed), agent('b', waiting)])
    const sections = Object.fromEntries(statusSections(doc, { a: 'queued', b: 'queued' }, [], '').map((s) => [s.id, s.sessions.map((n) => n.id)]))
    expect(sections['needs-you']).toEqual(['a'])
    expect(sections.starting).toEqual(['b'])
    expect(needsYouQueue(doc, { a: 'queued', b: 'queued' }, [], {}, true).map((e) => e.id)).toEqual(['a'])
    expect(projectSignal(doc, { a: 'queued', b: 'queued' }, 'p')).toBe('stopped')
    expect(projectSignal(docOf([agent('b', waiting)]), { b: 'queued' }, 'p')).toBeNull()
  })
})

describe('a failed run command', () => {
  test('is blocked only when it exited with an error the person didn\'t cause', () => {
    expect(sessionBlocked(run('r'), null, result({ exitCode: 3 }))).toBe(true)
    expect(sessionBlocked(run('r'), null, result({ exitCode: 0 }))).toBe(false)
    expect(sessionBlocked(run('r'), null, result({ exitCode: 1, stoppedByYou: true }))).toBe(false)
    expect(sessionBlocked(run('r'), null, result({ running: true, exitCode: null }))).toBe(false)
    expect(sessionBlocked(run('r'), null, undefined)).toBe(false)
  })

  test('goes under Need attention, not Unread, and lights its project tab', () => {
    const doc = docOf([run('r'), run('ok')])
    const runs = { r: result({ exitCode: 3 }), ok: result({ exitCode: 0 }) }
    const sections = Object.fromEntries(statusSections(doc, {}, ['r', 'ok'], '', {}, runs).map((s) => [s.id, s.sessions.map((n) => n.id)]))
    expect(sections['needs-you']).toEqual(['r'])
    expect(sections.unread).toEqual(['ok'])
    expect(projectSignal(doc, {}, 'p', [], {}, runs)).toBe('stopped')
  })
})
