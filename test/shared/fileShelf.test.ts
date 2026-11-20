import { describe, expect, test } from 'vitest'
import {
  checkAgentPath,
  fileKind,
  fileName,
  filterEntries,
  folderHint,
  forgetEntry,
  isNetworkPath,
  isShelfEntry,
  noteEntry,
  parentFolder,
  pathKey,
  quotePathFor,
  samePath,
  withoutLongPrefix,
  type ShelfEntry
} from '../../src/shared/fileShelf'

const entry = (path: string, at: number, source: ShelfEntry['source'] = 'drop'): ShelfEntry => ({ path, source, at })

describe('the shelf list', () => {
  test('is newest first, one entry per file however the path is written', () => {
    let list: ShelfEntry[] = []
    list = noteEntry(list, entry('C:\\work\\a.png', 1))
    list = noteEntry(list, entry('C:\\work\\b.pdf', 2))
    list = noteEntry(list, entry('c:/WORK/A.png', 3, 'paste'))
    expect(list.map((e) => [e.path, e.source])).toEqual([
      ['c:/WORK/A.png', 'paste'],
      ['C:\\work\\b.pdf', 'drop']
    ])
  })

  test('keeps at most the limit, dropping the oldest', () => {
    let list: ShelfEntry[] = []
    for (let i = 0; i < 2005; i++) list = noteEntry(list, entry(`C:\\f\\${i}.txt`, i))
    expect(list).toHaveLength(2000)
    expect(list[0].path).toBe('C:\\f\\2004.txt')
    expect(list[list.length - 1].path).toBe('C:\\f\\5.txt')
    expect(noteEntry(list, entry('C:\\x.txt', 9999), 3)).toHaveLength(3)
  })

  test('forgets a file by any spelling of its path, and leaves the rest', () => {
    const list = [entry('C:\\a\\x.txt', 2), entry('C:\\a\\y.txt', 1)]
    expect(forgetEntry(list, '\\\\?\\C:\\A\\X.TXT').map((e) => e.path)).toEqual(['C:\\a\\y.txt'])
  })

  test('only well-formed entries are read back', () => {
    expect(isShelfEntry(entry('C:\\a.txt', 1))).toBe(true)
    expect(isShelfEntry({ path: 'C:\\a.txt', source: 'nonsense', at: 1 })).toBe(false)
    expect(isShelfEntry({ path: '', source: 'drop', at: 1 })).toBe(false)
    expect(isShelfEntry({ path: 'C:\\a.txt', source: 'drop', at: Number.NaN })).toBe(false)
    expect(isShelfEntry(null)).toBe(false)
  })
})

describe('Windows paths', () => {
  test('the long-path prefix changes nothing about which file it is', () => {
    expect(withoutLongPrefix('\\\\?\\C:\\very\\long')).toBe('C:\\very\\long')
    expect(withoutLongPrefix('\\\\?\\UNC\\server\\share\\x')).toBe('\\\\server\\share\\x')
    expect(samePath('\\\\?\\C:\\A\\b.txt', 'c:/a/B.TXT')).toBe(true)
    expect(pathKey('C:\\a\\')).toBe('c:\\a')
  })

  test('a long path is kept whole', () => {
    const deep = `C:\\${Array.from({ length: 40 }, (_, i) => `folder${i}`).join('\\')}\\report.pdf`
    expect(deep.length).toBeGreaterThan(260)
    expect(fileName(deep)).toBe('report.pdf')
    expect(folderHint(deep)).toBe('…\\folder39')
    expect(noteEntry([], entry(deep, 1))[0].path).toBe(deep)
  })

  test('network shares are told apart from drive and device paths', () => {
    expect(isNetworkPath('\\\\server\\share\\a.txt')).toBe(true)
    expect(isNetworkPath('//server/share/a.txt')).toBe(true)
    expect(isNetworkPath('\\\\?\\UNC\\server\\share\\a.txt')).toBe(true)
    expect(isNetworkPath('\\\\?\\C:\\a.txt')).toBe(false)
    expect(isNetworkPath('\\\\.\\PhysicalDrive0')).toBe(false)
    expect(isNetworkPath('C:\\a.txt')).toBe(false)
  })

  test('names, folder hints and parents, with spaces and non-ASCII names', () => {
    expect(fileName('C:\\Users\\Zoë\\Mes documents\\résumé final.docx')).toBe('résumé final.docx')
    expect(folderHint('C:\\Users\\Zoë\\Mes documents\\résumé final.docx')).toBe('…\\Mes documents')
    expect(folderHint('C:\\top.txt')).toBe('C:\\')
    expect(folderHint('\\\\nas\\team\\plan.md')).toBe('\\\\nas\\team')
    expect(folderHint('\\\\nas\\team\\q3\\plan.md')).toBe('…\\q3')
    expect(fileName('C:\\写真\\猫.png')).toBe('猫.png')
    expect(parentFolder('C:\\a\\b.txt')).toBe('C:\\a')
    expect(parentFolder('C:\\b.txt')).toBe('C:\\')
  })

  test('kinds come from the extension', () => {
    expect(fileKind('C:\\a\\shot.PNG')).toBe('image')
    expect(fileKind('C:\\a\\spec.pdf')).toBe('pdf')
    expect(fileKind('C:\\a\\main.ts')).toBe('code')
    expect(fileKind('C:\\a\\data.csv')).toBe('data')
    expect(fileKind('C:\\a\\setup.exe')).toBe('program')
    expect(fileKind('C:\\a\\Makefile')).toBe('other')
    expect(fileKind('C:\\a\\.env')).toBe('other')
  })
})

describe('search and type filter', () => {
  const list = [entry('C:\\shots\\login page.png', 3), entry('C:\\docs\\Plan.md', 2), entry('C:\\src\\login.ts', 1)]
  test('every word must match the name or folder, any case', () => {
    expect(filterEntries(list, 'LOGIN', 'all').map(fileNameOf)).toEqual(['login page.png', 'login.ts'])
    expect(filterEntries(list, 'login shots', 'all').map(fileNameOf)).toEqual(['login page.png'])
    expect(filterEntries(list, '', 'documents').map(fileNameOf)).toEqual(['Plan.md'])
    expect(filterEntries(list, 'login', 'code').map(fileNameOf)).toEqual(['login.ts'])
    expect(filterEntries(list, 'nothing', 'all')).toEqual([])
  })
})
const fileNameOf = (e: ShelfEntry): string => fileName(e.path)

describe('typing a path into a window', () => {
  const p = "C:\\My Files\\it's ‘q’.txt"
  test('PowerShell gets single quotes, with every kind of single quote doubled', () => {
    expect(quotePathFor(p, 'powershell')).toBe("'C:\\My Files\\it''s ‘‘q’’.txt' ")
  })
  test('cmd gets double quotes', () => {
    expect(quotePathFor('C:\\a b\\x & y.txt', 'cmd')).toBe('"C:\\a b\\x & y.txt" ')
  })
  test('Git Bash gets forward slashes in single quotes', () => {
    expect(quotePathFor(p, 'git-bash')).toBe("'C:/My Files/it'\\''s ‘q’.txt' ")
  })
  test('WSL gets the /mnt form', () => {
    expect(quotePathFor('C:\\Users\\me\\a b.txt', 'wsl')).toBe("'/mnt/c/Users/me/a b.txt' ")
  })
  test('an agent gets quotes only when it needs them, and never the long-path prefix', () => {
    expect(quotePathFor('C:\\a\\b.txt', 'agent')).toBe('C:\\a\\b.txt ')
    expect(quotePathFor('C:\\a b\\c.txt', 'agent')).toBe('"C:\\a b\\c.txt" ')
    expect(quotePathFor('\\\\?\\C:\\a\\b.txt', 'agent')).toBe('C:\\a\\b.txt ')
  })
})

describe('what an agent may pin', () => {
  test('a full path on a drive', () => {
    expect(checkAgentPath('C:\\work\\a.txt')).toEqual({ ok: true, path: 'C:\\work\\a.txt' })
    expect(checkAgentPath('\\\\?\\D:\\deep\\b.txt')).toEqual({ ok: true, path: 'D:\\deep\\b.txt' })
  })
  test('not a network share, a device or a relative path', () => {
    expect(checkAgentPath('\\\\attacker\\share\\x.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/Network paths/) })
    expect(checkAgentPath('\\\\?\\UNC\\attacker\\share\\x.png')).toMatchObject({ ok: false, reason: expect.stringMatching(/Network paths/) })
    expect(checkAgentPath('\\\\.\\PhysicalDrive0')).toMatchObject({ ok: false, reason: expect.stringMatching(/device/) })
    expect(checkAgentPath('notes\\a.txt')).toMatchObject({ ok: false, reason: expect.stringMatching(/full path/) })
    expect(checkAgentPath('  ')).toMatchObject({ ok: false })
  })
})
