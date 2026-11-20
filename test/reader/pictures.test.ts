import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { imageHrefKind, isPictureUrl } from '../../src/core/reader/pictures'
import { createImageReader, imageFolders, imagePath, MAX_IMAGE_BYTES, sniffImage } from '../../src/main/reader/images'
import type { ClaudeNode, ReaderNode } from '../../src/shared/model'
import { memoryStore } from '../control/fakes'

const SYSTEM = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])

describe('which picture addresses are remote', () => {
  it('takes only picture data: URLs as an image source', () => {
    expect(isPictureUrl('data:image/png;base64,AAAA')).toBe(true)
    expect(isPictureUrl('data:image/svg+xml;base64,AAAA')).toBe(true)
    expect(isPictureUrl('data:text/html;base64,AAAA')).toBe(false)
    expect(isPictureUrl('https://example.com/a.png')).toBe(false)
    expect(isPictureUrl('file:///C:/a.png')).toBe(false)
    expect(isPictureUrl(undefined)).toBe(false)
  })

  it('treats the web, data and other schemes as remote, and paths as local', () => {
    expect(imageHrefKind('https://example.com/a.png')).toBe('remote')
    expect(imageHrefKind('http://x/a.png')).toBe('remote')
    expect(imageHrefKind('//cdn.example.com/a.png')).toBe('remote')
    expect(imageHrefKind('data:image/png;base64,AAAA')).toBe('remote')
    expect(imageHrefKind('javascript:alert(1)')).toBe('remote')
    expect(imageHrefKind('shots/a.png')).toBe('local')
    expect(imageHrefKind('../a.png')).toBe('local')
    expect(imageHrefKind('C:\\shots\\a.png')).toBe('local')
    expect(imageHrefKind('file:///C:/shots/a.png')).toBe('local')
    expect(imageHrefKind('')).toBe('none')
  })
})

describe('sniffImage', () => {
  it('knows pictures by their bytes, not their names', () => {
    expect(sniffImage(PNG, '.png')).toBe('image/png')
    expect(sniffImage(PNG, '.jpg')).toBe('image/png')
    expect(sniffImage(JPEG, '.jpg')).toBe('image/jpeg')
    expect(sniffImage(Buffer.from('GIF89a....'), '.gif')).toBe('image/gif')
    expect(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '), '.webp')).toBe('image/webp')
    expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'), '.png')).toBeNull()
    expect(sniffImage(Buffer.from('MZ\x90\0'), '.png')).toBeNull()
  })

  it('takes SVG only when it is named .svg and is an <svg> document', () => {
    expect(sniffImage(Buffer.from('<?xml version="1.0"?>\n<!-- made by hand -->\n<svg xmlns="http://www.w3.org/2000/svg"></svg>'), '.svg')).toBe('image/svg+xml')
    expect(sniffImage(Buffer.from('\uFEFF<svg viewBox="0 0 1 1"/>'), '.svg')).toBe('image/svg+xml')
    expect(sniffImage(Buffer.from('<svg/>'), '.png')).toBeNull()
    expect(sniffImage(Buffer.from('<html><svg/></html>'), '.svg')).toBeNull()
  })
})

describe('imagePath', () => {
  const doc = 'C:\\work\\docs\\plan.md'

  it('resolves against the document folder, and takes drive paths and file URLs', () => {
    expect(imagePath(doc, 'shots/a.png')).toEqual({ ok: true, path: 'C:\\work\\docs\\shots\\a.png' })
    expect(imagePath(doc, '../assets/a%20b.png?raw=1')).toEqual({ ok: true, path: 'C:\\work\\assets\\a b.png' })
    // A # can be part of a folder's name; when no such file is there, it's read as a fragment.
    expect(imagePath(doc, '../C# samples/ui.png')).toEqual({ ok: true, path: 'C:\\work\\C# samples\\ui.png', bare: 'C:\\work\\C' })
    expect(imagePath(doc, 'ui.png#dark')).toEqual({ ok: true, path: 'C:\\work\\docs\\ui.png#dark', bare: 'C:\\work\\docs\\ui.png' })
    expect(imagePath(doc, 'D:\\pics\\x.jpg')).toEqual({ ok: true, path: 'D:\\pics\\x.jpg' })
    expect(imagePath(doc, 'file:///C:/work/x.png')).toEqual({ ok: true, path: 'C:\\work\\x.png' })
  })

  it('never fetches from the web', () => {
    expect(imagePath(doc, 'https://example.com/a.png')).toMatchObject({ ok: false, remote: true })
    expect(imagePath(doc, 'data:image/png;base64,AAAA')).toMatchObject({ ok: false, remote: true })
  })

  it('refuses network shares and device paths, however they are written', () => {
    expect(imagePath(doc, '\\\\server\\share\\a.png').ok).toBe(false)
    expect(imagePath(doc, '//server/share/a.png').ok).toBe(false)
    expect(imagePath(doc, '%5C%5Cserver%5Cshare%5Ca.png').ok).toBe(false)
    expect(imagePath(doc, 'file://server/share/a.png').ok).toBe(false)
    expect(imagePath(doc, '\\\\?\\C:\\a.png').ok).toBe(false)
  })

  it('refuses streams and names Windows would change', () => {
    expect(imagePath(doc, 'a.md:b.png').ok).toBe(false)
    expect(imagePath(doc, 'a.png.').ok).toBe(false)
    expect(imagePath(doc, 'a\0.png').ok).toBe(false)
  })
})

describe('imageFolders', () => {
  const agent: ClaudeNode = { id: 'a1', kind: 'claude', title: 'A', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: 'C:\\work\\repo', sessionId: null, transcriptPath: null, after: [], projectId: 'p1' }
  const reader = (o: Partial<ReaderNode>): ReaderNode => ({ id: 'r1', kind: 'reader', title: 'R', path: 'C:\\notes\\plan.md', x: 0, y: 0, width: 1, height: 1, parentId: null, projectId: 'p1', ...o })
  const docWith = (nodes: (ClaudeNode | ReaderNode)[]) => {
    const store = memoryStore(nodes)
    store.dispatch({ op: 'addProject', project: { id: 'p1', name: 'P', folder: 'C:\\work\\proj', viewport: { x: 0, y: 0, zoom: 1 } } })
    return store.get()
  }

  it('gives a person-opened document its own folder and its project folder', () => {
    const r = reader({})
    expect(imageFolders(docWith([r]), r, 'C:\\Users\\me')).toEqual(['C:\\notes', 'C:\\work\\proj'])
  })

  it('gives an agent-opened document the agent folders, as open-doc allows', () => {
    const r = reader({ openedBy: 'a1', path: 'C:\\work\\repo\\plan.md' })
    expect(imageFolders(docWith([agent, r]), r, 'C:\\Users\\me')).toEqual(['C:\\work\\repo', 'C:\\work\\proj', join('C:\\Users\\me', '.claude', 'plans')])
  })

  it('falls back to the document and project folders once that agent is gone', () => {
    const r = reader({ openedBy: 'gone', path: 'C:\\work\\repo\\plan.md' })
    expect(imageFolders(docWith([r]), r, 'C:\\Users\\me')).toEqual(['C:\\work\\repo', 'C:\\work\\proj'])
  })
})

describe('createImageReader', () => {
  let dir: string
  let docs: string
  let outside: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-pics-'))
    docs = join(dir, 'docs')
    outside = join(dir, 'outside')
    mkdirSync(join(docs, 'shots'), { recursive: true })
    mkdirSync(outside)
    writeFileSync(join(docs, 'plan.md'), '# Plan\n')
    writeFileSync(join(docs, 'shots', 'a.png'), PNG)
    writeFileSync(join(docs, 'diagram.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><script>alert(1)</script></svg>')
    writeFileSync(join(outside, 'secret.png'), PNG)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const make = (o: Partial<ReaderNode> = {}, extra: ClaudeNode[] = []) => {
    const r: ReaderNode = { id: 'r1', kind: 'reader', title: 'Plan', path: join(docs, 'plan.md'), x: 0, y: 0, width: 1, height: 1, parentId: null, ...o }
    const store = memoryStore([...extra, r])
    return createImageReader({ store, home: join(dir, 'home'), system: SYSTEM })
  }

  it('reads a picture beside the document as a data: URL', async () => {
    const r = await make()('r1', 'shots/a.png')
    expect(r).toEqual({ ok: true, url: `data:image/png;base64,${PNG.toString('base64')}`, path: join(docs, 'shots', 'a.png') })
  })

  it('hands an SVG over as a picture, for an <img> where its script never runs', async () => {
    const r = await make()('r1', './diagram.svg')
    expect(r).toMatchObject({ ok: true, url: expect.stringMatching(/^data:image\/svg\+xml;base64,/) })
  })

  it('refuses pictures outside the folders the document may show from', async () => {
    expect(await make()('r1', '../outside/secret.png')).toMatchObject({ ok: false, reason: expect.stringContaining('outside the folders') })
    expect(await make()('r1', join(outside, 'secret.png'))).toMatchObject({ ok: false })
  })

  it('refuses a link inside the folder that leads outside it', async () => {
    symlinkSync(outside, join(docs, 'linked'), 'junction')
    expect(await make()('r1', 'linked/secret.png')).toMatchObject({ ok: false, reason: expect.stringContaining('outside the folders') })
  })

  it('limits an agent-opened document to the agent folders', async () => {
    const agent: ClaudeNode = { id: 'a1', kind: 'claude', title: 'A', x: 0, y: 0, width: 1, height: 1, parentId: null, cwd: docs, sessionId: null, transcriptPath: null, after: [] }
    const read = make({ openedBy: 'a1' }, [agent])
    expect(await read('r1', 'shots/a.png')).toMatchObject({ ok: true })
    expect(await read('r1', join(outside, 'secret.png'))).toMatchObject({ ok: false })
  })

  it('refuses what is not a picture, is too large, is missing, or is remote', async () => {
    writeFileSync(join(docs, 'fake.png'), '<html><script>alert(1)</script></html>')
    writeFileSync(join(docs, 'big.png'), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]))
    writeFileSync(join(docs, 'notes.txt'), 'hello')
    const read = make()
    expect(await read('r1', 'fake.png')).toMatchObject({ ok: false, reason: expect.stringContaining("isn't a picture") })
    expect(await read('r1', 'big.png')).toMatchObject({ ok: false, reason: expect.stringContaining('MB') })
    expect(await read('r1', 'notes.txt')).toMatchObject({ ok: false, reason: expect.stringContaining('Only pictures') })
    expect(await read('r1', 'nope.png')).toMatchObject({ ok: false, reason: expect.stringContaining("isn't there") })
    expect(await read('r1', 'https://example.com/a.png')).toMatchObject({ ok: false, remote: true })
    expect(await read('r1', 'shots')).toMatchObject({ ok: false })
  })

  it('refuses Windows and program folders even when they are allowed folders', async () => {
    const read = make({ path: 'C:\\Windows\\Temp\\plan.md' })
    expect(await read('r1', 'C:\\Windows\\Temp\\a.png')).toMatchObject({ ok: false })
  })

  it('answers only for reader nodes on the canvas', async () => {
    expect(await make()('nope', 'shots/a.png')).toMatchObject({ ok: false, reason: expect.stringContaining('no longer on the canvas') })
  })
})
