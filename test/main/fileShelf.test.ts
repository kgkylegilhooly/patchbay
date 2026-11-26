import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { checkFiles, openFile, revealFile, type FileDeps } from '../../src/main/fileShelf/files'
import { FileShelfStore } from '../../src/main/fileShelf/store'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'patchbay shelf ü '))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('the shelf store', () => {
  test('keeps each project apart, survives a restart, and never holds more than the limit', async () => {
    const file = join(dir, 'file-shelf.json')
    const shelf = new FileShelfStore(file, { limit: 3, writeDelayMs: 0 })
    const changed: string[] = []
    shelf.onChange((id) => changed.push(id))
    for (let i = 0; i < 5; i++) shelf.note('p1', { path: `C:\\a\\${i}.png`, source: 'paste', at: i })
    shelf.note('p2', { path: 'D:\\b.pdf', source: 'drop', at: 9, nodeTitle: 'Dev shell' })
    expect(shelf.list('p1').map((e) => e.path)).toEqual(['C:\\a\\4.png', 'C:\\a\\3.png', 'C:\\a\\2.png'])
    expect(changed).toEqual(['p1', 'p1', 'p1', 'p1', 'p1', 'p2'])
    await shelf.flush()
    await new Promise((r) => setTimeout(r, 20))
    await shelf.flush()
    const again = new FileShelfStore(file)
    expect(again.list('p1')).toHaveLength(3)
    expect(again.list('p2')).toEqual([{ path: 'D:\\b.pdf', source: 'drop', at: 9, nodeTitle: 'Dev shell' }])
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })

  test('forgets a file, and drops the shelves of removed projects', () => {
    const shelf = new FileShelfStore(join(dir, 's.json'), { writeDelayMs: 60_000 })
    shelf.note('p1', { path: 'C:\\a.txt', source: 'pin', at: 1 })
    shelf.note('p1', { path: 'C:\\b.txt', source: 'pin', at: 2 })
    shelf.note('gone', { path: 'C:\\c.txt', source: 'pin', at: 3 })
    shelf.forget('p1', 'c:/A.TXT')
    expect(shelf.list('p1').map((e) => e.path)).toEqual(['C:\\b.txt'])
    shelf.keepOnly(['p1'])
    expect(shelf.list('gone')).toEqual([])
  })

  test('a damaged file starts it empty and says why, and bad entries are left out', () => {
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{ not json')
    const shelf = new FileShelfStore(bad)
    expect(shelf.list('p1')).toEqual([])
    expect(shelf.loadProblem).toMatch(/couldn't be read/)
    const mixed = join(dir, 'mixed.json')
    writeFileSync(mixed, JSON.stringify({ version: 1, projects: { p1: [{ path: 'C:\\ok.txt', source: 'drop', at: 1 }, { path: 5 }, 'x'], p2: 'nope' } }))
    expect(new FileShelfStore(mixed).list('p1')).toEqual([{ path: 'C:\\ok.txt', source: 'drop', at: 1 }])
  })

  // FS1b: the next change wrote over a file that couldn't be read, so whatever was in it was gone for good.
  test('a file that cannot be read is moved aside before anything is written over it', async () => {
    const file = join(dir, 'file-shelf.json')
    writeFileSync(file, '{ "version": 1, "projects": { "p1": [ cut off')
    const shelf = new FileShelfStore(file, { writeDelayMs: 0 })
    expect(shelf.loadProblem).toMatch(/kept at .*file-shelf\.corrupt-\d+\.json/)
    shelf.note('p1', { path: 'C:\\new.txt', source: 'drop', at: 2 })
    await shelf.flush()
    await new Promise((r) => setTimeout(r, 20))
    await shelf.flush()
    const kept = readdirSync(dir).filter((f) => f.startsWith('file-shelf.corrupt-'))
    expect(kept).toHaveLength(1)
    expect(readFileSync(join(dir, kept[0]), 'utf8')).toBe('{ "version": 1, "projects": { "p1": [ cut off')
    expect(new FileShelfStore(file).list('p1').map((e) => e.path)).toEqual(['C:\\new.txt'])
  })

  test('refuses entries that are not well formed', () => {
    const shelf = new FileShelfStore(join(dir, 's.json'), { writeDelayMs: 60_000 })
    shelf.note('p1', { path: '', source: 'drop', at: 1 })
    shelf.note('', { path: 'C:\\a.txt', source: 'drop', at: 1 })
    expect(shelf.list('p1')).toEqual([])
  })
})

function fakeDeps(files: Record<string, 'file' | 'folder'>): FileDeps & { opened: string[]; revealed: string[] } {
  const opened: string[] = []
  const revealed: string[] = []
  return {
    opened,
    revealed,
    kind: async (p) => files[p] ?? null,
    openPath: async (p) => (opened.push(p), ''),
    reveal: (p) => void revealed.push(p)
  }
}

describe('opening and revealing', () => {
  test('a document opens with its default app; a program, script or shortcut is only revealed', async () => {
    const deps = fakeDeps({ 'C:\\a\\notes.md': 'file', 'C:\\a\\run.cmd': 'file', 'C:\\a\\tool.EXE': 'file', 'C:\\a\\link.lnk': 'file', 'C:\\a': 'folder' })
    expect(await openFile('C:\\a\\notes.md', deps)).toEqual({ ok: true })
    expect(await openFile('C:\\a\\run.cmd', deps)).toEqual({ ok: true, revealed: true })
    expect(await openFile('C:\\a\\tool.EXE', deps)).toEqual({ ok: true, revealed: true })
    expect(await openFile('C:\\a\\link.lnk', deps)).toEqual({ ok: true, revealed: true })
    expect(await openFile('C:\\a', deps)).toEqual({ ok: true })
    expect(deps.opened).toEqual(['C:\\a\\notes.md', 'C:\\a'])
    expect(deps.revealed).toEqual(['C:\\a\\run.cmd', 'C:\\a\\tool.EXE', 'C:\\a\\link.lnk'])
  })

  test('only documents, pictures and media open: every other type is revealed, including ones Windows runs or connects out with', async () => {
    const risky = ['notes.library-ms', 'x.search-ms', 'y.searchConnector-ms', 'help.chm', 'box.rdp', 'app.appinstaller', 'app.msix', 'disk.iso', 'disk.vhdx', 'sb.wsb', 'add.xll', 'page.mht', 'run.js', 'run.py', 'tool.rb', 'noext', 'page.html', 'pic.svg', 'Makefile', 'evil.cmd .', 'evil.exe:stream']
    const files = Object.fromEntries(risky.map((n) => [`C:\\w\\${n}`, 'file' as const]))
    const deps = fakeDeps(files)
    for (const n of risky) expect(await openFile(`C:\\w\\${n}`, deps), n).toEqual({ ok: true, revealed: true })
    expect(deps.opened).toEqual([])
    const safe = ['a.pdf', 'b.PNG', 'c.docx', 'd.md', 'e.csv', 'f.mp4', 'g.ts', 'h.txt']
    const deps2 = fakeDeps(Object.fromEntries(safe.map((n) => [`C:\\w\\${n}`, 'file' as const])))
    for (const n of safe) expect(await openFile(`C:\\w\\${n}`, deps2), n).toEqual({ ok: true })
    expect(deps2.revealed).toEqual([])
  })

  test('a path past MAX_PATH goes to the app with the long-path prefix, and a failure says to reveal it instead', async () => {
    const deep = `C:\\${Array.from({ length: 30 }, (_, i) => `folder-${i}`).join('\\')}\\report.pdf`
    const opened: string[] = []
    const deps: FileDeps = { kind: async () => 'file', openPath: async (p) => (opened.push(p), 'Access is denied.'), reveal: () => {} }
    const r = await openFile(deep, deps)
    expect(opened).toEqual([`\\\\?\\${deep}`])
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/too long .* Reveal in File Explorer/) })
  })

  test('a missing file says so, and never errors', async () => {
    const deps = fakeDeps({})
    expect(await openFile('C:\\gone.txt', deps)).toEqual({ ok: false, reason: 'File not found: C:\\gone.txt' })
    expect(await openFile('relative.txt', deps)).toMatchObject({ ok: false })
    expect(await openFile('\\\\.\\PhysicalDrive0', deps)).toMatchObject({ ok: false })
  })

  test('the long-path prefix is taken off before opening', async () => {
    const deps = fakeDeps({ 'C:\\deep\\x.pdf': 'file' })
    expect(await openFile('\\\\?\\C:\\deep\\x.pdf', deps)).toEqual({ ok: true })
    expect(deps.opened).toEqual(['C:\\deep\\x.pdf'])
  })

  test('revealing a file that moved opens the nearest folder still there', async () => {
    const deps = fakeDeps({ 'C:\\work': 'folder', 'C:\\work\\b.txt': 'file' })
    expect(await revealFile('C:\\work\\b.txt', deps)).toEqual({ ok: true })
    expect(deps.revealed).toEqual(['C:\\work\\b.txt'])
    const r = await revealFile('C:\\work\\old\\deeper\\a.txt', deps)
    expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/its folder was opened: C:\\work$/) })
    expect(deps.opened).toEqual(['C:\\work'])
    expect(await revealFile('Q:\\nowhere\\a.txt', fakeDeps({}))).toMatchObject({ ok: false, reason: expect.stringMatching(/nor is its folder/) })
  })
})

describe('checking what is there', () => {
  test('real files: there, a folder, or missing, with spaces, non-ASCII names and long paths', async () => {
    const real = join(dir, 'Zoë notes', 'résumé final.txt')
    mkdirSync(join(dir, 'Zoë notes'))
    writeFileSync(real, 'x')
    let deep = dir
    while (deep.length < 280) deep = join(deep, 'a-fairly-long-folder-name')
    mkdirSync(deep, { recursive: true })
    const long = join(deep, 'long.txt')
    writeFileSync(long, 'x')
    const { stat } = await import('node:fs/promises')
    const kind: FileDeps['kind'] = async (p) => {
      try {
        return (await stat(p)).isDirectory() ? 'folder' : 'file'
      } catch {
        return null
      }
    }
    const found = await checkFiles([{ path: real }, { path: join(dir, 'Zoë notes') }, { path: join(dir, 'gone.txt') }, { path: long }, { path: `\\\\?\\${long}` }], { kind })
    expect(found).toEqual({ [real]: 'file', [join(dir, 'Zoë notes')]: 'folder', [join(dir, 'gone.txt')]: 'missing', [long]: 'file', [`\\\\?\\${long}`]: 'file' })
  })

  test('a network path is only touched when the person added it, and only for a moment', async () => {
    const touched: string[] = []
    const kind: FileDeps['kind'] = (p) => {
      touched.push(p)
      return p.includes('slow') ? new Promise(() => {}) : Promise.resolve('file')
    }
    const found = await checkFiles(
      [
        { path: '\\\\attacker\\share\\x.png' },
        { path: '\\\\nas\\team\\plan.md', network: true },
        { path: '\\\\slow\\share\\big.zip', network: true }
      ],
      { kind },
      30
    )
    expect(found).toEqual({ '\\\\attacker\\share\\x.png': 'unchecked', '\\\\nas\\team\\plan.md': 'file', '\\\\slow\\share\\big.zip': 'unchecked' })
    expect(touched).not.toContain('\\\\attacker\\share\\x.png')
  })
})

describe('documents opened in a Reader', () => {
  test('go on their project shelf as the doc viewer source, with the node they came from; ones already open are added once', async () => {
    const { noteReaders } = await import('../../src/main/fileShelf/readers')
    const { memoryStore } = await import('../control/fakes')
    const base = { x: 0, y: 0, width: 10, height: 10, parentId: null }
    const store = memoryStore([
      { ...base, id: 'a', kind: 'claude', title: 'Planner', cwd: 'C:/', sessionId: null, transcriptPath: null, after: [], projectId: 'p1' },
      { ...base, id: 'r0', kind: 'reader', title: 'Old', path: 'C:/docs/old.md', projectId: 'p1' }
    ])
    const shelf = new FileShelfStore(join(dir, 's.json'), { writeDelayMs: 60_000 })
    shelf.note('p1', { path: 'C:/docs/old.md', source: 'drop', at: 1 })
    const stop = noteReaders(store, shelf, () => 500)
    expect(shelf.list('p1')).toEqual([{ path: 'C:/docs/old.md', source: 'drop', at: 1 }])
    store.dispatch({ op: 'addNode', node: { ...base, id: 'r1', kind: 'reader', title: 'Plan', path: 'C:/docs/plan.md', fromNodeId: 'a', projectId: 'p1' } })
    store.dispatch({ op: 'patchNode', id: 'r1', patch: { title: 'Plan v2' } })
    expect(shelf.list('p1')[0]).toEqual({ path: 'C:/docs/plan.md', source: 'doc', at: 500, nodeTitle: 'Planner' })
    expect(shelf.list('p1')).toHaveLength(2)
    stop()
  })
})
