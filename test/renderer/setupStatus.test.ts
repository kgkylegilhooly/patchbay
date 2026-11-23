import { describe, expect, test } from 'vitest'
import { agentLook } from '../../src/renderer/status/status'
import { sessionBlocked, setupHoldOf, setupHolds, setupLookFor } from '../../src/renderer/status/setupStatus'
import { DIALOG_LAYERS, syncBar } from '../../src/renderer/shell/barInert'
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
  test("is blocked only when it exited with an error the person didn't cause, and only until it's been seen", () => {
    expect(sessionBlocked(run('r'), null, result({ exitCode: 3 }), true)).toBe(true)
    expect(sessionBlocked(run('r'), null, result({ exitCode: 3 }), false)).toBe(false)
    expect(sessionBlocked(run('r'), null, result({ exitCode: 0 }), true)).toBe(false)
    expect(sessionBlocked(run('r'), null, result({ exitCode: 1, stoppedByYou: true }), true)).toBe(false)
    expect(sessionBlocked(run('r'), null, result({ running: true, exitCode: null }), true)).toBe(false)
    expect(sessionBlocked(run('r'), null, undefined, true)).toBe(false)
  })

  test('unseen, it goes under Need attention, not Unread, and lights its project tab', () => {
    const doc = docOf([run('r'), run('ok')])
    const runs = { r: result({ exitCode: 3 }), ok: result({ exitCode: 0 }) }
    const sections = Object.fromEntries(statusSections(doc, {}, ['r', 'ok'], '', {}, runs).map((s) => [s.id, s.sessions.map((n) => n.id)]))
    expect(sections['needs-you']).toEqual(['r'])
    expect(sections.unread).toEqual(['ok'])
    expect(projectSignal(doc, {}, 'p', ['r'], {}, runs)).toBe('stopped')
  })

  test('once looked at, it leaves Need attention and the tab, with the other commands', () => {
    const doc = docOf([run('r')])
    const runs = { r: result({ exitCode: 3 }) }
    const sections = Object.fromEntries(statusSections(doc, {}, [], '', {}, runs).map((s) => [s.id, s.sessions.map((n) => n.id)]))
    expect(sections['needs-you']).toEqual([])
    expect(sections.plain).toEqual(['r'])
    expect(projectSignal(doc, {}, 'p', [], {}, runs)).toBeNull()
  })
})

describe('setup holds by id', () => {
  test('are worked out once per node list, and only for held agents', () => {
    const nodes = [agent('a', failed), agent('b', waiting), agent('c')]
    const holds = setupHolds(nodes)
    expect([...holds]).toEqual([['a', 'failed'], ['b', 'waiting']])
    expect(setupHolds(nodes)).toBe(holds)
    expect(setupHolds([agent('a')]).size).toBe(0)
    expect(setupHolds(undefined).size).toBe(0)
  })
})

describe('the title bar under a dialog', () => {
  const bar = () => {
    const attrs = new Set<string>()
    const classes = new Set<string>()
    return {
      attrs,
      classes,
      toggleAttribute: (n: string, on?: boolean) => (on ? attrs.add(n) : attrs.delete(n), !!on),
      classList: { toggle: (n: string, on?: boolean) => (on ? classes.add(n) : classes.delete(n), !!on) } as unknown as DOMTokenList
    }
  }
  test('is inert and dimmed while a dialog layer is on the stage, and back once it goes', () => {
    const b = bar()
    let layer: object | null = {}
    const stage = { querySelector: (sel: string) => (sel === DIALOG_LAYERS ? layer : null) } as unknown as Element
    expect(syncBar(stage, b as unknown as Element)).toBe(true)
    expect(b.attrs.has('inert') && b.classes.has('bar-under-dialog')).toBe(true)
    layer = null
    expect(syncBar(stage, b as unknown as Element)).toBe(false)
    expect(b.attrs.size + b.classes.size).toBe(0)
  })
  test('counts the modal, confirm, palette and archive layers', () => {
    for (const cls of ['.shell-layer', '.palette-back', '.projects-scrim']) expect(DIALOG_LAYERS).toContain(`:scope > ${cls}`)
  })
})
