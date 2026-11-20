import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { pictureBudget, pictureKey } from '../../src/core/reader/pictures'
import { createImageReader, limiter, PICTURE_READS_AT_ONCE, type ImageFs } from '../../src/main/reader/images'
import { linksStayLocal, localTarget, type LinkFs } from '../../src/main/reader/links'
import { createCommentStore } from '../../src/main/reader/commentStore'
import { createDocsService } from '../../src/main/reader/service'
import { spotNear } from '../../src/main/control/verbs'
import type { ReaderNode } from '../../src/shared/model'
import { memoryStore } from '../control/fakes'

const SYSTEM = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const reader: ReaderNode = { id: 'r1', kind: 'reader', title: 'Plan', path: 'C:\\work\\plan.md', x: 0, y: 0, width: 1, height: 1, parentId: null }

/** A file system of links only: `links` maps a path to its link target; anything else is a plain folder or file. */
function linkFs(links: Record<string, string>, seen: string[] = []): LinkFs {
  const map = new Map(Object.entries(links).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    lstat: async (p) => {
      seen.push(p)
      return { isSymbolicLink: () => map.has(p.toLowerCase()) }
    },
    readlink: async (p) => map.get(p.toLowerCase())!
  }
}

/** A picture reader over `files` (lowercased paths), with links. */
function fakeFs(files: string[], links: Record<string, string> = {}, onRead?: (p: string) => Promise<void>): ImageFs & { realpaths: string[] } {
  const known = new Set(files.map((f) => f.toLowerCase()))
  const realpaths: string[] = []
  return {
    ...linkFs(links),
    realpaths,
    realpath: async (p) => {
      realpaths.push(p)
      if (!known.has(p.toLowerCase())) throw Object.assign(new Error('gone'), { code: 'ENOENT' })
      return p
    },
    stat: async () => ({ isFile: () => true, size: PNG.length }),
    readBytes: async (p) => {
      await onRead?.(p)
      return PNG
    }
  }
}

const readerOver = (fs: ImageFs) => createImageReader({ store: memoryStore([reader]), home: 'C:\\Users\\me', system: SYSTEM, fs })

describe('linksStayLocal', () => {
  it('reads link targets as local paths, or not', () => {
    expect(localTarget('C:\\real\\x', 'C:\\a\\l')).toBe('C:\\real\\x')
    expect(localTarget('\\\\?\\C:\\real', 'C:\\a\\l')).toBe('C:\\real')
    expect(localTarget('..\\up', 'C:\\a\\b\\l')).toBe('C:\\a\\up')
    expect(localTarget('\\\\host\\share\\x.png', 'C:\\a\\l')).toBeNull()
    expect(localTarget('//host/share/x.png', 'C:\\a\\l')).toBeNull()
    expect(localTarget('\\\\?\\UNC\\host\\share', 'C:\\a\\l')).toBeNull()
    expect(localTarget('\\\\.\\pipe\\x', 'C:\\a\\l')).toBeNull()
  })

  it('passes a path with no links, or links that stay on this PC', async () => {
    expect(await linksStayLocal('C:\\work\\docs\\a.png', linkFs({}))).toEqual({ ok: true })
    expect(await linksStayLocal('C:\\work\\docs\\img\\a.png', linkFs({ 'C:\\work\\docs\\img': 'D:\\pics', 'D:\\pics\\a.png': '..\\b.png' }))).toEqual({ ok: true })
  })

  it('refuses a picture, or a folder above it, that links to a network share, and looks no further', async () => {
    const seen: string[] = []
    expect(await linksStayLocal('C:\\work\\docs\\img\\logo.png', linkFs({ 'C:\\work\\docs\\img': '\\\\attacker\\s' }, seen))).toMatchObject({ ok: false, reason: expect.stringContaining('network') })
    expect(seen.some((p) => p.startsWith('\\\\'))).toBe(false)
    expect(await linksStayLocal('C:\\w\\logo.png', linkFs({ 'C:\\w\\logo.png': '\\\\attacker\\s\\logo.png' }))).toMatchObject({ ok: false })
  })

  it('follows a chain of links, and refuses one that ends on a share', async () => {
    expect(await linksStayLocal('C:\\a\\l1\\l2\\p.png', linkFs({ 'C:\\a\\l1': 'C:\\b', 'C:\\b\\l2': '\\\\host\\x' }))).toMatchObject({ ok: false })
  })

  it('gives up on a loop', async () => {
    expect(await linksStayLocal('C:\\a\\l\\p.png', linkFs({ 'C:\\a\\l': 'C:\\a\\l' }))).toMatchObject({ ok: false, reason: expect.stringContaining('too many links') })
  })

  it('never calls realpath on a picture behind a share link', async () => {
    const fs = fakeFs(['C:\\work\\img\\logo.png'], { 'C:\\work\\img': '\\\\attacker\\s' })
    expect(await readerOver(fs)('r1', 'img/logo.png')).toMatchObject({ ok: false, reason: expect.stringContaining('network') })
    expect(fs.realpaths).toEqual([])
  })

  it('never calls realpath on a document behind a share link either', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pb-links-'))
    try {
      writeFileSync(join(dir, 'plan.md'), '# Plan\n')
      let realpaths = 0
      const service = createDocsService({
        store: memoryStore([]),
        dataDir: join(dir, 'data'),
        home: dir,
        comments: createCommentStore(join(dir, 'data', 'reader')),
        fs: { realpath: async (p) => (realpaths++, p), stat: async () => ({ isFile: () => true, size: 1, mtimeMs: 1 }), readFile: async () => '', writeFile: async () => {}, mkdir: async () => {}, exists: () => true },
        watcher: { watch: () => {}, unwatch: () => {} },
        changed: () => {},
        near: spotNear,
        link: { exists: () => true, openExternal: async () => {}, openPath: async () => '', reveal: () => {} },
        system: SYSTEM,
        linkFs: linkFs({ [join(dir, 'plan.md')]: '\\\\attacker\\s\\plan.md' })
      })
      expect(await service.open({ path: join(dir, 'plan.md') })).toMatchObject({ ok: false, reason: expect.stringContaining('network') })
      expect(realpaths).toBe(0)
      service.stop()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('reading many pictures', () => {
  it('runs a few jobs at a time', async () => {
    const run = limiter(2)
    let now = 0
    let most = 0
    const job = (): Promise<void> =>
      run(async () => {
        most = Math.max(most, ++now)
        await new Promise((r) => setTimeout(r, 5))
        now--
      })
    await Promise.all(Array.from({ length: 9 }, job))
    expect(most).toBe(2)
    expect(PICTURE_READS_AT_ONCE).toBeLessThanOrEqual(4)
  })

  it('reads one file once however its address varies, and at most a few at a time', async () => {
    const reads: string[] = []
    let now = 0
    let most = 0
    const names = ['C:\\work\\shot.png', ...Array.from({ length: 12 }, (_, i) => `C:\\work\\s${i}.png`)]
    const read = readerOver(
      fakeFs(names, {}, async (p) => {
        reads.push(p)
        most = Math.max(most, ++now)
        await new Promise((r) => setTimeout(r, 5))
        now--
      })
    )
    const same = await Promise.all(Array.from({ length: 20 }, (_, i) => read('r1', `shot.png?${i}`)))
    expect(same.every((x) => x.ok)).toBe(true)
    expect(reads).toEqual(['C:\\work\\shot.png'])
    reads.length = 0
    await Promise.all(Array.from({ length: 12 }, (_, i) => read('r1', `s${i}.png`)))
    expect(reads).toHaveLength(12)
    expect(most).toBeLessThanOrEqual(PICTURE_READS_AT_ONCE)
  })

  it('reads "x.png#dark" as x.png unless a file has that name, and keeps # in folder names', async () => {
    const read = readerOver(fakeFs(['C:\\work\\x.png', 'C:\\work\\C# samples\\ui.png']))
    expect(await read('r1', 'x.png#dark')).toMatchObject({ ok: true, path: 'C:\\work\\x.png' })
    expect(await read('r1', 'C# samples/ui.png')).toMatchObject({ ok: true, path: 'C:\\work\\C# samples\\ui.png' })
    expect(await read('r1', 'y.png#dark')).toMatchObject({ ok: false, reason: expect.stringContaining("isn't there") })
  })

  it('caps the pictures, and the data, one document shows', () => {
    const b = pictureBudget(3, 100)
    expect(['a', 'b', 'c', 'a'].map((k) => b.admit(k))).toEqual([true, true, true, true])
    expect(b.admit('d')).toBe(false)
    expect(b.charge('a', 60)).toBe(true)
    expect(b.charge('a', 60)).toBe(true)
    expect(b.charge('b', 60)).toBe(false)
    expect(b.charge('c', 40)).toBe(true)
  })

  it('counts shot.png?1 and shot.png?2 as one picture', () => {
    expect(pictureKey('shot.png?1')).toBe('shot.png')
    expect(pictureKey(' C# samples/ui.png ')).toBe('C# samples/ui.png')
    expect(pictureKey('file:///C:/a.png?x')).toBe('file:///C:/a.png?x')
  })
})
