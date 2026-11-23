import { describe, expect, test } from 'vitest'
import { hiddenTabs, moreLabel, scrollToShow } from '../../src/renderer/tabOverflow'
import { blockedReason, emptyProjectHint, folderToKeep } from '../../src/renderer/startHints'
import { whenNodeDrawn } from '../../src/renderer/newNodeFocus'
import { failedStart, FIX_LABELS, FIX_SECTIONS, startFailureLook, startFailureOf } from '../../src/renderer/status/startFailure'
import { isReconnecting, RECONNECTING } from '../../src/renderer/status/launchSettle'
import { agentLook } from '../../src/renderer/status/status'
import { sessionBlocked } from '../../src/renderer/status/setupStatus'
import { statusMapColor } from '../../src/renderer/minimapColors'
import { statusSections } from '../../src/renderer/sidebarView'
import { needsYouQueue } from '../../src/renderer/needsYou'
import { projectSignal } from '../../src/renderer/projectSignal'
import { takeSettingsSection, openSettingsAt } from '../../src/renderer/settingsAsk'
import type { NodeError } from '../../src/shared/contract'
import type { CanvasDoc, CanvasNode } from '../../src/shared/model'

const box = { x: 0, y: 0, width: 100, height: 100 }
const viewport = { x: 0, y: 0, zoom: 1 }
const agent = (id: string, projectId = 'p'): CanvasNode => ({ ...box, id, title: id, kind: 'claude', parentId: null, cwd: 'C:\\repo', sessionId: null, transcriptPath: null, after: [], projectId })
const terminal = (id: string): CanvasNode => ({ ...box, id, title: id, kind: 'terminal', parentId: null, cwd: 'C:\\repo', projectId: 'p' })
const docOf = (nodes: CanvasNode[], folder = ''): CanvasDoc => ({
  version: 3,
  projects: [{ id: 'p', name: 'My project', folder, viewport }],
  activeProjectId: 'p',
  nodes,
  edges: [],
  closed: [],
  viewport
})
const missing: NodeError = { code: 'spawn-failed', message: 'The Claude Code command "claude-x" was not found. Check it in Settings.', fix: 'agents' }
const gone: NodeError = { code: 'cwd-missing', message: 'Folder not found: C:\\gone', fix: 'folder' }

describe('#1 many projects: the tab strip scrolls and says what is out of sight', () => {
  const tabs = [
    { id: 'a', left: 300, right: 400 },
    { id: 'b', left: 402, right: 520 },
    { id: 'c', left: 522, right: 700 },
    { id: 'd', left: 702, right: 800 }
  ]

  test('tabs wholly inside the strip are shown; any cut off, either side, are hidden', () => {
    expect(hiddenTabs({ left: 300, right: 800 }, tabs)).toEqual([])
    expect(hiddenTabs({ left: 300, right: 650 }, tabs)).toEqual(['c', 'd'])
    expect(hiddenTabs({ left: 450, right: 800 }, tabs)).toEqual(['a', 'b'])
  })

  test('a tab cut off by a pixel or two still counts as shown', () => {
    expect(hiddenTabs({ left: 300, right: 799 }, tabs)).toEqual([])
  })

  test('the tab on screen is scrolled into view by as little as it takes', () => {
    // Already in view: no move.
    expect(scrollToShow(0, 500, { left: 100, right: 200 })).toBe(0)
    // Off the right end: scrolled until its right edge and a margin show.
    expect(scrollToShow(0, 500, { left: 900, right: 1000 })).toBe(524)
    // Off the left: scrolled back to just before it, never below zero.
    expect(scrollToShow(600, 500, { left: 300, right: 400 })).toBe(276)
    expect(scrollToShow(600, 500, { left: 10, right: 100 })).toBe(0)
  })

  test('the overflow button counts what is hidden', () => {
    expect(moreLabel(4)).toBe('4 more')
  })
})

describe('#13 the sidebar says the empty-project help once', () => {
  test('under the project on screen, and a quiet None under the rest', () => {
    expect(emptyProjectHint(true)).toBe('No sessions here. Right-click the canvas to open one.')
    expect(emptyProjectHint(false)).toBe('None')
  })
})

describe('#2 first run: an agent needs a folder, and the one chosen is kept', () => {
  test('a blocked form says why', () => {
    expect(blockedReason('claude', { cwd: '', text: 'fix it' })).toBe('Choose a folder first')
    expect(blockedReason('codex', { cwd: '', text: '' })).toBe('Choose a folder first')
    expect(blockedReason('team', { cwd: 'C:\\repo', text: ' ' })).toBe('Describe the task first')
    expect(blockedReason('run', { cwd: '', text: '' })).toBe('Type a command first')
    // A terminal starts in the home folder, so it's never blocked.
    expect(blockedReason('terminal', { cwd: '', text: '' })).toBeNull()
    expect(blockedReason('claude', { cwd: 'C:\\repo', text: '' })).toBeNull()
  })

  test('a folder chosen for an agent becomes the folder of a project that has none', () => {
    expect(folderToKeep(docOf([]), 'claude', { cwd: 'C:\\repo', chose: true })).toEqual({ projectId: 'p', folder: 'C:\\repo', name: 'My project' })
    expect(folderToKeep(docOf([]), 'team', { cwd: 'C:\\repo', chose: true })?.folder).toBe('C:\\repo')
  })

  test('never over a folder the project has, from a folder not chosen, for a terminal, or for a worktree', () => {
    expect(folderToKeep(docOf([], 'C:\\other'), 'claude', { cwd: 'C:\\repo', chose: true })).toBeNull()
    expect(folderToKeep(docOf([]), 'claude', { cwd: 'C:\\repo' })).toBeNull()
    expect(folderToKeep(docOf([]), 'terminal', { cwd: 'C:\\repo', chose: true })).toBeNull()
    const tree: CanvasNode = { ...box, id: 'g', kind: 'group', title: 'G', parentId: null, worktree: { path: 'C:\\wt', branch: 'b', repo: 'C:\\repo' } as never, projectId: 'p' }
    expect(folderToKeep(docOf([tree]), 'claude', { cwd: 'C:\\wt', chose: true })).toBeNull()
  })
})

describe('#3 a new node is selected once it is drawn', () => {
  const clock = () => {
    let t = 0
    const queue: Array<[number, () => void]> = []
    return {
      now: () => t,
      later: (fn: () => void, ms: number) => queue.push([t + ms, fn]),
      run(until: number) {
        while (queue.length) {
          queue.sort((a, b) => a[0] - b[0])
          if (queue[0][0] > until) break
          const [at, fn] = queue.shift()!
          t = at
          fn()
        }
      }
    }
  }

  test('acts once, when it appears', () => {
    const c = clock()
    let drawnAt = 50
    const acted: string[] = []
    whenNodeDrawn('n', () => c.now() >= drawnAt, (id) => acted.push(id), { later: c.later, now: c.now })
    c.run(40)
    expect(acted).toEqual([])
    c.run(200)
    expect(acted).toEqual(['n'])
    drawnAt = 0
    c.run(1000)
    expect(acted).toEqual(['n'])
  })

  test('gives up when it never appears', () => {
    const c = clock()
    const acted: string[] = []
    whenNodeDrawn('n', () => false, (id) => acted.push(id), { later: c.later, now: c.now, timeoutMs: 100 })
    c.run(10_000)
    expect(acted).toEqual([])
  })
})

describe("#4 an agent that couldn't start", () => {
  test("only an exited agent with a start error is \"Couldn't start\"", () => {
    expect(startFailureOf(agent('a'), 'exited', missing)).toBe(missing)
    expect(failedStart('exited', gone)).toBe(gone)
    // Running, starting or with no error: its own status speaks.
    expect(failedStart('working', missing)).toBeNull()
    expect(failedStart('exited', undefined)).toBeNull()
    // A failed resume has its own words.
    expect(failedStart('exited', { code: 'resume-failed', message: 'x' })).toBeNull()
    // A terminal's error can be a notice on a live shell, so terminals keep their look.
    expect(startFailureOf(terminal('t'), 'exited', missing)).toBeNull()
  })

  test('reads "Couldn\'t start", held, not a grey Exited', () => {
    expect(agentLook('exited')).toMatchObject({ tone: 'ended', label: 'Exited' })
    expect(agentLook('exited', undefined, 0, undefined, missing)).toMatchObject({ tone: 'held', label: "Couldn't start" })
    expect(startFailureLook(missing).detail).toContain('was not found')
    // On the minimap and a zoomed-out window it's the held colour, as a failed setup is, not the ended grey.
    expect(statusMapColor('exited', undefined, undefined, 0, undefined, missing)).toBe(statusMapColor('queued', undefined, undefined, 0, 'failed'))
    expect(statusMapColor('exited', undefined, undefined, 0, undefined, missing)).not.toBe(statusMapColor('exited', undefined))
  })

  test('is under Need attention, in the tab signal and in Next needing you', () => {
    const doc = docOf([agent('a'), agent('b')], 'C:\\repo')
    const statuses = { a: 'exited' as const, b: 'exited' as const }
    expect(sessionBlocked(doc.nodes[0], 'exited', undefined, false, missing)).toBe(true)
    expect(sessionBlocked(doc.nodes[0], 'exited', undefined, false)).toBe(false)
    const sections = statusSections(doc, statuses, [], '', {}, {}, { a: missing })
    expect(sections.find((s) => s.id === 'needs-you')?.sessions.map((s) => s.id)).toEqual(['a'])
    expect(sections.find((s) => s.id === 'stopped')?.sessions.map((s) => s.id)).toEqual(['b'])
    expect(projectSignal(doc, statuses, 'p', [], {}, {}, { a: missing })).toBe('stopped')
    expect(projectSignal(doc, statuses, 'p')).toBeNull()
    expect(needsYouQueue(doc, statuses, [], {}, false, {}, { a: missing }).map((e) => e.id)).toEqual(['a'])
  })

  test('offers the fix: Settings at the right section, or a new folder', () => {
    expect(FIX_LABELS.agents).toBe('Open Settings › Agents')
    expect(FIX_LABELS.folder).toBe('Choose folder…')
    expect(FIX_SECTIONS).toEqual({ agents: 'claude', sessions: 'sessions' })
  })

  test('Settings opens at the section asked for, once', () => {
    openSettingsAt('claude')
    expect(takeSettingsSection()).toBe('claude')
    expect(takeSettingsSection()).toBeNull()
  })
})

describe('#16 just after launch, an agent with no status yet is reconnecting', () => {
  test('only while settling, for an agent there at launch, with no status and no stop', () => {
    expect(isReconnecting(true, true, 'unknown', false)).toBe(true)
    expect(isReconnecting(true, true, undefined, false)).toBe(true)
    expect(isReconnecting(false, true, 'unknown', false)).toBe(false)
    expect(isReconnecting(true, false, 'unknown', false)).toBe(false)
    expect(isReconnecting(true, true, 'idle', false)).toBe(false)
    expect(isReconnecting(true, true, 'unknown', true)).toBe(false)
  })

  test('says so as a pending look, not "No status yet"', () => {
    expect(RECONNECTING).toMatchObject({ tone: 'pending', label: 'Reconnecting…' })
    expect(agentLook('unknown').label).toBe('No status yet')
  })
})

describe('review fixes', () => {
  test('L1: a held modifier or a repeat keydown does not take the keyboard from a new agent', async () => {
    const { cancelsPendingFocus } = await import('../../src/renderer/terminalRegistry')
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'Control', repeat: true })).toBe(false)
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'Shift' })).toBe(false)
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'a', repeat: true })).toBe(false)
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'a' })).toBe(true)
    expect(cancelsPendingFocus({ type: 'pointerdown', isTrusted: true })).toBe(true)
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: false, key: 'a' })).toBe(false)
    // Ctrl+Enter pressed again is the start key, not a key meant elsewhere; plain Enter is.
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'Enter', ctrlKey: true })).toBe(false)
    expect(cancelsPendingFocus({ type: 'keydown', isTrusted: true, key: 'Enter' })).toBe(true)
  })

  test('M2: one folder picker at a time, and one start per form', async () => {
    const { oneOpen, once } = await import('../../src/renderer/startHints')
    let asked = 0
    let answer: (v: string) => void = () => {}
    const pick = oneOpen(() => {
      asked++
      return new Promise<string>((r) => (answer = r))
    })
    const first = pick()
    const second = await pick()
    expect(second).toBeUndefined()
    expect(asked).toBe(1)
    answer('C:\repo')
    expect(await first).toBe('C:\repo')
    // Once it's closed, it can be asked again.
    void pick()
    expect(asked).toBe(2)
    const started: string[] = []
    const start = once((cwd: string) => started.push(cwd))
    start('C:\a')
    start('C:\b')
    expect(started).toEqual(['C:\a'])
  })
})
