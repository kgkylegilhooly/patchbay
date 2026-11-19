import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
