import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { reduce } from '../../src/core/canvas/reduce'
import { createDocStore, type DocStore } from '../../src/core/persist/docStore'
import { createAppStore } from '../../src/main/appStore'
import {
  badgeFile,
  closeAction,
  hideNotice,
  createScrollbackSaver,
  mergeSettings,
  needsQuitConfirm,
  parseSettings,
  planRestore,
  restoreSeed,
  trayState
} from '../../src/main/lifecycle'
import { createNotifier } from '../../src/main/notifier'
import {
  openTerminalLink,
  readClosedTranscript,
  reopenClosed,
  resolveTerminalPath,
  savePastedImage,
  type LinkDeps
} from '../../src/main/shellActions'
import type { CanvasStore } from '../../src/shared/contract'
import type { CanvasDoc, ClaudeNode, GroupNode, StickyNode, TerminalNode } from '../../src/shared/model'

const dirs: string[] = []
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'patchbay-main-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const base = { x: 0, y: 0, width: 100, height: 100, parentId: null }
const claude = (id: string, extra: Partial<ClaudeNode> = {}): ClaudeNode => ({
  ...base,
  id,
  kind: 'claude',
  title: id,
  cwd: 'C:\\w',
  sessionId: null,
  transcriptPath: null,
  after: [],
  ...extra
})
const terminal = (id: string): TerminalNode => ({ ...base, id, kind: 'terminal', title: id, cwd: 'C:\\w' })
const sticky = (id: string): StickyNode => ({ ...base, id, kind: 'sticky', title: id, text: '' })
const group = (id: string): GroupNode => ({ ...base, id, kind: 'group', title: id, worktree: null })
const docOf = (nodes: CanvasDoc['nodes'], closed: CanvasDoc['closed'] = []): CanvasDoc => ({
  version: 3, projects: [], activeProjectId: '',
  nodes,
  edges: [],
  closed,
  viewport: { x: 0, y: 0, zoom: 1 }
})

function memStore(doc: CanvasDoc): CanvasStore {
  let cur = doc
  return {
    get: () => cur,
    dispatch(op) {
      cur = reduce(cur, op)
    },
    subscribe: () => () => {}
  }
}

describe('restore', () => {
  test('planRestore resumes Claude nodes, restarts terminals, keeps armed nodes held', () => {
    const plan = planRestore(
      docOf([claude('c1', { sessionId: 's' }), claude('c2'), claude('c3', { after: ['c1'] }), terminal('t1'), sticky('n'), group('g')])
    )
    expect(plan).toEqual({ claude: ['c1', 'c2'], terminals: ['t1'], held: ['c3'] })
  })

  test('a terminal restore seeds saved scrollback then a divider saying the old process ended', () => {
    const seed = restoreSeed('terminal', 'old output\r\n')!
    expect(seed.startsWith('old output\r\n')).toBe(true)
    expect(seed.slice('old output\r\n'.length)).toMatch(/process ended/i)
    expect(seed.endsWith('\r\n')).toBe(true)
  })

  test('a terminal with nothing saved gets no divider', () => {
    expect(restoreSeed('terminal', null)).toBeUndefined()
    expect(restoreSeed('terminal', '')).toBeUndefined()
  })

  test('a Claude restore does not replay saved scrollback', () => {
    expect(restoreSeed('claude', 'full screen output')).toBeUndefined()
  })
})

describe('quit', () => {
  test('needsQuitConfirm is true only when a Claude node is working or needs-you', () => {
    const doc = docOf([claude('c'), terminal('t')])
    expect(needsQuitConfirm(doc, { c: 'working' })).toBe(true)
    expect(needsQuitConfirm(doc, { c: 'needs-you' })).toBe(true)
    for (const s of ['idle', 'exited', 'unknown', 'queued', 'starting'] as const) {
      expect(needsQuitConfirm(doc, { c: s })).toBe(false)
    }
    expect(needsQuitConfirm(doc, { t: 'working', gone: 'working' })).toBe(false)
  })
})

describe('openTerminalLink', () => {
  function deps(existing: string[] = []): LinkDeps & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      exists: (p) => existing.includes(p),
      openExternal: async (u) => void calls.push(`external ${u}`),
      openPath: async (p) => (calls.push(`open ${p}`), ''),
      reveal: (p) => void calls.push(`reveal ${p}`)
    }
  }

  test('openTerminalLink resolves a relative path against the node cwd', async () => {
    const want = resolve('C:\\repo', 'src\\a.ts')
    const d = deps([want])
    expect(await openTerminalLink('C:\\repo', 'src\\a.ts', d)).toEqual({ ok: true })
    expect(d.calls).toEqual([`open ${want}`])
  })

  test('a :line:col suffix is not part of the file name', async () => {
    const want = resolve('C:\\repo', 'a.ts')
    const d = deps([want])
    expect(await openTerminalLink('C:\\repo', 'a.ts:3:9', d)).toEqual({ ok: true })
    expect(d.calls).toEqual([`open ${want}`])
  })

  test.each(['tool.exe', 'run.cmd', 'run.bat', 'x.ps1', 'x.js', 'RUN.EXE', 'x.lnk', 'x.vbs', 'tool.exe.', 'tool.exe::$DATA'])(
    'openTerminalLink reveals %s instead of opening it',
    async (name) => {
      const want = resolve('C:\\repo', name)
      const d = deps([want])
      expect(await openTerminalLink('C:\\repo', name, d)).toEqual({ ok: true })
      expect(d.calls).toEqual([`reveal ${want}`])
    }
  )

  test('openTerminalLink opens http and https', async () => {
    const d = deps()
    await openTerminalLink('C:\\repo', 'https://example.com/a', d)
    await openTerminalLink('C:\\repo', 'http://example.com/b', d)
    expect(d.calls).toEqual(['external https://example.com/a', 'external http://example.com/b'])
  })

  test.each(['javascript:alert(1)', 'ms-settings:privacy', 'ftp://example.com/x'])(
    'openTerminalLink refuses the scheme of %s',
    async (target) => {
      const d = deps()
      const r = await openTerminalLink('C:\\repo', target, d)
      expect(r.ok).toBe(false)
      expect(d.calls).toEqual([])
    }
  )

  test('openTerminalLink says when a file is missing', async () => {
    const d = deps()
    const r = await openTerminalLink('C:\\repo', 'nope.txt', d)
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/not found.*nope\.txt/i) })
    expect(d.calls).toEqual([])
  })

  test('a network path is refused, since just reaching it can send credentials', async () => {
    const d = deps(['\\\\host\\share\\a.txt'])
    const r = await openTerminalLink('C:\\repo', '\\\\host\\share\\a.txt', d)
    expect(r.ok).toBe(false)
    expect(d.calls).toEqual([])
  })

  test.each([
    ['/C:/repo/src/a.ts:12', 'C:\\repo\\src\\a.ts'],
    ['/c/repo/src/a.ts', 'C:\\repo\\src\\a.ts'],
    ['C:/repo/src/a.ts#L12-L20', 'C:\\repo\\src\\a.ts'],
    ['src/a.ts#L12', 'C:\\repo\\src\\a.ts'],
    ['file:///C:/repo/src/a.ts', 'C:\\repo\\src\\a.ts'],
    ['file:///C:/My%20Docs/a%20b.md', 'C:\\My Docs\\a b.md'],
    ['C:/My%20Docs/a%20b.md', 'C:\\My Docs\\a b.md'],
    ['~/notes/todo.md', 'C:\\Users\\me\\notes\\todo.md'],
    ['~', 'C:\\Users\\me']
  ])('%s, as agents and shells write paths, opens %s', async (target, want) => {
    const d = { ...deps([want]), home: 'C:\\Users\\me' }
    expect(await openTerminalLink('C:\\repo', target, d)).toEqual({ ok: true })
    expect(d.calls).toEqual([`open ${want}`])
  })

  test('a file whose name really has %20 in it still opens', async () => {
    const d = deps(['C:\\repo\\100%20.txt'])
    expect(await openTerminalLink('C:\\repo', '100%20.txt', d)).toEqual({ ok: true })
    expect(d.calls).toEqual(['open C:\\repo\\100%20.txt'])
  })

  test('a program given as a file link is only shown, never run', async () => {
    const d = deps(['C:\\x.exe'])
    expect(await openTerminalLink('C:\\repo', 'file:///C:/x.exe', d)).toEqual({ ok: true })
    expect(d.calls).toEqual(['reveal C:\\x.exe'])
  })

  test.each(['file://host/share/a.txt', '%5C%5Chost%5Cshare%5Ca.txt', '//host/share/a.txt'])('the network path %s is refused, however it is written', async (target) => {
    const d = deps(['\\\\host\\share\\a.txt'])
    expect((await openTerminalLink('C:\\repo', target, d)).ok).toBe(false)
    expect(d.calls).toEqual([])
  })

  test('a failure from the system comes back as the reason', async () => {
    const want = resolve('C:\\repo', 'a.txt')
    const d = { ...deps([want]), openPath: async () => 'no app for this' }
    expect(await openTerminalLink('C:\\repo', 'a.txt', d)).toEqual({ ok: false, reason: 'no app for this' })
  })
})

describe('resolveTerminalPath', () => {
  const kinds = (entries: Record<string, 'file' | 'dir'>) => ({
    isDirectory: (p: string) => (p in entries ? entries[p] === 'dir' : null)
  })

  test('a file resolves against the node folder, and a terminal there opens in the folder holding it', () => {
    const file = resolve('C:\\repo', 'src\\a.ts')
    expect(resolveTerminalPath('C:\\repo', 'src\\a.ts:3:9', kinds({ [file]: 'file' }))).toEqual({
      ok: true,
      path: file,
      folder: resolve('C:\\repo', 'src')
    })
  })

  test('a folder is its own terminal folder', () => {
    const dir = resolve('C:\\other\\lib')
    expect(resolveTerminalPath('C:\\repo', 'C:\\other\\lib', kinds({ [dir]: 'dir' }))).toEqual({ ok: true, path: dir, folder: dir })
  })

  test('Show in File Explorer understands the same forms as Open', () => {
    const file = 'C:\\repo\\src\\a.ts'
    expect(resolveTerminalPath('C:\\repo', '/c/repo/src/a.ts', kinds({ [file]: 'file' }))).toEqual({ ok: true, path: file, folder: 'C:\\repo\\src' })
    expect(resolveTerminalPath('C:\\repo', '/C:/repo/src/a.ts#L4', kinds({ [file]: 'file' }))).toEqual({ ok: true, path: file, folder: 'C:\\repo\\src' })
  })

  test.each(['nope.txt', 'https://example.com/a', '\\\\host\\share\\a.txt', 'file://host/share/a.txt'])('%s does not resolve', (target) => {
    expect(resolveTerminalPath('C:\\repo', target, kinds({})).ok).toBe(false)
  })
})

describe('savePastedImage', () => {
  test('savePastedImage writes under the app data pastes folder with a unique name', () => {
    const dir = tempDir()
    const a = savePastedImage(dir, new Uint8Array([1, 2, 3]), 'image/png')
    const b = savePastedImage(dir, new Uint8Array([4]), 'image/png')
    expect(dirname(a)).toBe(join(dir, 'pastes'))
    expect(a.endsWith('.png')).toBe(true)
    expect(a).not.toBe(b)
    expect([...readFileSync(a)]).toEqual([1, 2, 3])
  })

  test('the file extension comes from a fixed list, never from what the renderer sent', () => {
    const dir = tempDir()
    expect(savePastedImage(dir, new Uint8Array([1]), 'image/jpeg').endsWith('.jpg')).toBe(true)
    expect(() => savePastedImage(dir, new Uint8Array([1]), 'image/../../evil')).toThrow(/image type/i)
  })
})

describe('closed sessions', () => {
  const entry = {
    id: 'closed-1',
    title: 'Old work',
    cwd: 'C:\\w',
    sessionId: 'sess',
    transcriptPath: 'C:\\t.jsonl',
    closedAt: 5
  }

  test('reopenClosed adds a Claude node with that sessionId and removes the history entry', () => {
    const store = memStore(docOf([], [entry]))
    const id = reopenClosed(store, 'closed-1', 'new-id')
    const node = store.get().nodes.find((n) => n.id === 'new-id') as ClaudeNode
    expect(id).toBe('new-id')
    expect(node).toMatchObject({ kind: 'claude', title: 'Old work', cwd: 'C:\\w', sessionId: 'sess', transcriptPath: 'C:\\t.jsonl', after: [] })
    expect(store.get().closed).toEqual([])
  })

  test('reopening an entry that is gone does nothing', () => {
    const store = memStore(docOf([]))
    expect(reopenClosed(store, 'nope', 'new-id')).toBeNull()
    expect(store.get().nodes).toEqual([])
  })

  test('readClosedTranscript reports a missing transcript instead of throwing', async () => {
    const dir = tempDir()
    const doc = docOf([], [
      { ...entry, transcriptPath: join(dir, 'gone.jsonl') },
      { ...entry, id: 'closed-2', transcriptPath: null }
    ])
    expect(await readClosedTranscript(doc, 'closed-1')).toEqual({ ok: false, reason: expect.stringMatching(/no longer exists/i) })
    expect((await readClosedTranscript(doc, 'closed-2')).ok).toBe(false)
    expect((await readClosedTranscript(doc, 'nope')).ok).toBe(false)
  })

  test('readClosedTranscript returns the conversation as text', async () => {
    const file = join(tempDir(), 't.jsonl')
    writeFileSync(file, `${JSON.stringify({ type: 'user', message: { content: 'hello there' } })}\n`)
    const r = await readClosedTranscript(docOf([], [{ ...entry, transcriptPath: file }]), 'closed-1')
    expect(r).toEqual({ ok: true, text: expect.stringContaining('hello there') })
  })
})

describe('createAppStore', () => {
  const fakeDocStore = (doc: CanvasDoc): DocStore & { saved: CanvasDoc[] } => {
    const saved: CanvasDoc[] = []
    return {
      saved,
      load: () => ({ doc, recoveredFrom: 'primary' }),
      save: async () => {},
      saveDebounced: (d) => void saved.push(d),
      flush: async () => {},
      flushSync: () => {}
    }
  }

  test('loads the saved doc, autosaves each change, and skips a refused op', () => {
    const docs = fakeDocStore(docOf([sticky('n')]))
    const store = createAppStore(docs)
    expect(store.get().nodes.map((n) => n.id)).toEqual(['n'])
    store.dispatch({ op: 'patchNode', id: 'n', patch: { title: 'x' } })
    store.dispatch({ op: 'patchNode', id: 'missing', patch: { title: 'x' } })
    expect(docs.saved).toHaveLength(1)
  })

  test('a load failure propagates, so the app can never start empty over a save file', () => {
    const docs = { ...fakeDocStore(docOf([])), load: () => { throw new Error('locked') } }
    expect(() => createAppStore(docs)).toThrow('locked')
  })

  test('a change made inside a subscriber reaches everyone in order, never older after newer', () => {
    const store = createAppStore(fakeDocStore(docOf([sticky('n')])))
    const seen: string[] = []
    store.subscribe((d) => {
      if (d.nodes[0].title === 'a') store.dispatch({ op: 'patchNode', id: 'n', patch: { title: 'b' } })
    })
    store.subscribe((d) => seen.push(d.nodes[0].title))
    store.dispatch({ op: 'patchNode', id: 'n', patch: { title: 'a' } })
    expect(seen).toEqual(['a', 'b'])
    expect(store.get().nodes[0].title).toBe('b')
  })

  test('unsubscribe stops further calls', () => {
    const store = createAppStore(fakeDocStore(docOf([sticky('n')])))
    const cb = vi.fn()
    store.subscribe(cb)()
    store.dispatch({ op: 'patchNode', id: 'n', patch: { title: 'a' } })
    expect(cb).not.toHaveBeenCalled()
  })

  test('survives a real doc store round trip', async () => {
    const dir = tempDir()
    const docs = createDocStore(dir)
    const store = createAppStore(docs)
    store.dispatch({ op: 'addNode', node: sticky('n') })
    await docs.flush()
    expect(createAppStore(createDocStore(dir)).get().nodes.map((n) => n.id)).toEqual(['n'])
  })
})

describe('scrollback saver', () => {
  test('writes only dirty nodes, at most once per tick, and flush writes what remains', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const saver = createScrollbackSaver({
        snapshot: (id) => `data of ${id}`,
        write: async (id) => void writes.push(id),
        intervalMs: 2000
      })
      saver.markDirty('a')
      saver.markDirty('a')
      expect(writes).toEqual([])
      vi.advanceTimersByTime(2000)
      expect(writes).toEqual(['a'])
      vi.advanceTimersByTime(4000)
      expect(writes).toEqual(['a'])
      saver.markDirty('b')
      await saver.flush()
      expect(writes).toEqual(['a', 'b'])
      saver.markDirty('c')
      saver.forget('c')
      await saver.flush()
      expect(writes).toEqual(['a', 'b'])
      saver.stop()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a failed write keeps the node dirty for the next try', async () => {
    let fail = true
    const writes: string[] = []
    const saver = createScrollbackSaver({
      snapshot: () => 'd',
      write: async (id) => {
        if (fail) throw new Error('locked')
        writes.push(id)
      },
      intervalMs: 100000
    })
    saver.markDirty('a')
    await saver.flush()
    fail = false
    await saver.flush()
    expect(writes).toEqual(['a'])
    saver.stop()
  })
})

describe('settings', () => {
  test('keeps known text fields and ignores everything else', () => {
    expect(parseSettings('{"shell":"pwsh.exe","permissionMode":"default","other":1}')).toEqual({ shell: 'pwsh.exe', permissionMode: 'default' })
    expect(parseSettings('{"shell":3}')).toEqual({})
    expect(parseSettings('not json')).toEqual({})
    expect(parseSettings(null)).toEqual({})
    expect(parseSettings('{"keepAwake":"off"}')).toEqual({ keepAwake: 'off' })
  })
})

describe('notifier', () => {
  function harness(opts: { focused?: boolean } = {}) {
    const shown: Array<{ title: string; body: string; click: () => void }> = []
    const centered: string[] = []
    const notifier = createNotifier({
      show: (n) => void shown.push(n),
      windowFocused: () => opts.focused ?? false,
      titleOf: (id) => `title ${id}`,
      reveal: (id) => void centered.push(id)
    })
    return { notifier, shown, centered }
  }

  test('fires for a finished turn and for needing you, and clicking centers the node', () => {
    const { notifier, shown, centered } = harness()
    notifier.notify('a', 'idle')
    notifier.notify('a', 'needs-you')
    expect(shown.map((s) => s.title)).toEqual(['title a', 'title a'])
    expect(shown[0].body).not.toBe(shown[1].body)
    shown[0].click()
    expect(centered).toEqual(['a'])
  })

  test('skips only when that node is focused and the window is in the foreground', () => {
    const fg = harness({ focused: true })
    fg.notifier.setFocusedNode('a')
    fg.notifier.notify('a', 'idle')
    expect(fg.shown).toHaveLength(0)
    fg.notifier.notify('b', 'idle')
    expect(fg.shown).toHaveLength(1)
    fg.notifier.setFocusedNode(null)
    fg.notifier.notify('a', 'idle')
    expect(fg.shown).toHaveLength(2)

    const bg = harness({ focused: false })
    bg.notifier.setFocusedNode('a')
    bg.notifier.notify('a', 'idle')
    expect(bg.shown).toHaveLength(1)
  })

  test('no other status notifies', () => {
    const { notifier, shown } = harness()
    notifier.notify('a', 'working')
    notifier.notify('a', 'exited')
    expect(shown).toHaveLength(0)
  })
})

describe('settings', () => {
  test('reads the Claude launch fields and ignores blanks', () => {
    expect(parseSettings('{"claudeTerminal":" pwsh.exe ","claudeCommand":""}')).toEqual({ claudeTerminal: 'pwsh.exe' })
  })

  test('saving keeps fields Patchbay does not know and removes cleared ones', () => {
    const text = mergeSettings('{"mine":1,"shell":"a.exe"}', { claudeCommand: 'claude --x', shell: '' })
    expect(JSON.parse(text!)).toEqual({ mine: 1, claudeCommand: 'claude --x' })
  })

  test('saving creates the file when there is none', () => {
    expect(JSON.parse(mergeSettings(null, { shell: 'a.exe' })!)).toEqual({ shell: 'a.exe' })
  })

  test('saving refuses to overwrite a file with a mistake in it', () => {
    expect(mergeSettings('{"shell": oops', { shell: 'a.exe' })).toBeNull()
    expect(mergeSettings('[1]', { shell: 'a.exe' })).toBeNull()
  })
})

describe('tray', () => {
  const base = { x: 0, y: 0, width: 1, height: 1, parentId: null, title: 't' }
  const doc = (ids: string[]): CanvasDoc => ({
    version: 3,
    projects: [],
    activeProjectId: '',
    nodes: [
      ...ids.map((id) => ({ ...base, id, kind: 'terminal' as const, cwd: 'c' })),
      { ...base, id: 'note', kind: 'sticky' as const, text: '' }
    ],
    edges: [],
    closed: [],
    viewport: { x: 0, y: 0, zoom: 1 }
  })

  test('closing hides to the tray only with something running', () => {
    expect(closeAction(1)).toBe('hide-to-tray')
    expect(closeAction(0)).toBe('quit')
  })

  test('counts sessions that are really running, across every project, and never notes', () => {
    const state = trayState(doc(['a', 'b', 'gone']), {}, (id) => id !== 'gone')
    expect(state).toEqual({ running: 2, attention: [], summary: '2 sessions running' })
  })

  test('says one session in the singular, and none when empty', () => {
    expect(trayState(doc(['a']), {}, () => true).summary).toBe('1 session running')
    expect(trayState(doc([]), {}, () => true).summary).toBe('No sessions running')
  })

  test('counts what to look at, ignoring a stopped session that was only waiting', () => {
    const state = trayState(doc(['a', 'b']), { a: 'needs-you', b: 'needs-you' }, (id) => id === 'a')
    expect(state).toEqual({ running: 1, attention: ['a'], summary: '1 session running, 1 to look at' })
  })

  test('a session waiting on you and unseen counts once', () => {
    expect(trayState(doc(['a']), { a: 'needs-you' }, () => true, ['a']).attention).toEqual(['a'])
  })

  test('adds sessions not yet seen, and keeps one that has since stopped', () => {
    const state = trayState(doc(['a', 'b', 'c']), { a: 'needs-you' }, (id) => id !== 'c', ['c'])
    expect(state.attention).toEqual(['a', 'c'])
  })

  test('forgets an unseen session that has been closed', () => {
    expect(trayState(doc(['a']), {}, () => true, ['closed']).attention).toEqual([])
  })

  test('the badge shows 1 to 9, then 9+, and nothing for none', () => {
    expect(badgeFile(0)).toBeNull()
    expect(badgeFile(1)).toBe('badge-1.png')
    expect(badgeFile(9)).toBe('badge-9.png')
    expect(badgeFile(10)).toBe('badge-many.png')
  })
})

describe('alerting', () => {
  const setup = (windowFocused: boolean) => {
    const alert = vi.fn()
    const show = vi.fn()
    const notifier = createNotifier({ show, alert, windowFocused: () => windowFocused, titleOf: () => 't', reveal: () => {} })
    return { alert, show, notifier }
  }

  test('a session needing you alerts and notifies', () => {
    const { alert, show, notifier } = setup(false)
    notifier.notify('a', 'needs-you')
    expect(alert).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
  })

  test('finishing a turn notifies, with no chime or flash', () => {
    const { alert, show, notifier } = setup(false)
    notifier.notify('a', 'idle')
    expect(alert).not.toHaveBeenCalled()
    expect(show).toHaveBeenCalledTimes(1)
  })

  test('nothing interrupts while the keyboard is in that very window', () => {
    const { alert, show, notifier } = setup(true)
    notifier.setFocusedNode('a')
    notifier.notify('a', 'needs-you')
    expect(alert).not.toHaveBeenCalled()
    expect(show).not.toHaveBeenCalled()
  })

  test('a session stays unseen until you look at it, and looking clears only that one', () => {
    const { notifier } = setup(false)
    notifier.notify('a', 'idle')
    notifier.notify('b', 'needs-you')
    notifier.notify('a', 'idle')
    expect(notifier.unseen()).toEqual(['a', 'b'])
    notifier.markSeen('a')
    expect(notifier.unseen()).toEqual(['b'])
  })

  test('clicking into a terminal counts as looking only while the window is in front', () => {
    const away = setup(false)
    away.notifier.notify('a', 'idle')
    away.notifier.setFocusedNode('a')
    expect(away.notifier.unseen()).toEqual(['a'])

    const here = setup(true)
    here.notifier.notify('a', 'idle')
    here.notifier.setFocusedNode('a')
    expect(here.notifier.unseen()).toEqual([])
  })

  test('coming back to the window counts as looking at the terminal that has the keyboard', () => {
    const { notifier } = setup(false)
    notifier.setFocusedNode('a')
    notifier.notify('a', 'idle')
    notifier.notify('b', 'idle')
    notifier.windowFocused()
    expect(notifier.unseen()).toEqual(['b'])
  })

  test('tells a listener only when the list really changes', () => {
    const { notifier } = setup(false)
    const changed = vi.fn()
    notifier.onUnseenChange(changed)
    notifier.notify('a', 'idle')
    notifier.notify('a', 'idle')
    notifier.markSeen('nope')
    expect(changed).toHaveBeenCalledTimes(1)
  })

  test('another window needing you still alerts while you work elsewhere in the app', () => {
    const { alert, notifier } = setup(true)
    notifier.setFocusedNode('b')
    notifier.notify('a', 'needs-you')
    expect(alert).toHaveBeenCalledTimes(1)
  })
})

test('the first hide says sessions are still running, and later ones stay quiet', () => {
  expect(hideNotice(3, false)).toMatch(/3 sessions/)
  expect(hideNotice(1, false)).toMatch(/1 session /)
  expect(hideNotice(3, true)).toBeNull()
})
