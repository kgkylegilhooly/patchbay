import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { asMarkdownPath, createHandoffSaver, handoffFileName } from '../../src/main/search/saveHandoff'
import { memoryStore } from '../control/fakes'

const SYSTEM = ['C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData']

describe('handoff file names', () => {
  it('makes a plain name from the title', () => {
    expect(handoffFileName('Handoff Billing: phase 2 (café)')).toBe('handoff-billing-phase-2-cafe.md')
    expect(handoffFileName('***')).toBe('handoff.md')
    expect(handoffFileName('x'.repeat(200))).toBe(`${'x'.repeat(60)}.md`)
  })

  it('saves as Markdown whatever the person typed', () => {
    expect(asMarkdownPath('C:\\a\\notes.md')).toBe('C:\\a\\notes.md')
    expect(asMarkdownPath('C:\\a\\notes.MARKDOWN')).toBe('C:\\a\\notes.MARKDOWN')
    expect(asMarkdownPath('C:\\a\\notes')).toBe('C:\\a\\notes.md')
    expect(asMarkdownPath('C:\\a\\notes.exe')).toBe('C:\\a\\notes.exe.md')
    expect(asMarkdownPath('C:\\a\\notes. ')).toBe('C:\\a\\notes.md')
  })
})

describe('saveHandoff', () => {
  let dir: string
  let asked: string[]
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pb-handoff-'))
    asked = []
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  const make = (answer: (defaultPath: string) => string | null) => {
    const store = memoryStore([])
    store.dispatch({ op: 'addProject', project: { id: 'p1', name: 'P', folder: dir, viewport: { x: 0, y: 0, zoom: 1 } } })
    store.dispatch({ op: 'addProject', project: { id: 'p2', name: 'Q', folder: '', viewport: { x: 0, y: 0, zoom: 1 } } })
    return createHandoffSaver({
      store,
      home: 'C:\\Users\\me',
      system: SYSTEM,
      writeFile: (p, t) => writeFile(p, t, 'utf8'),
      pickFile: async (p) => {
        asked.push(p)
        return answer(p)
      }
    })
  }

  it('starts in the project folder and writes the Markdown where the person picked', async () => {
    const save = make((p) => p.replace(/\.md$/, ''))
    const r = await save({ text: '# Handoff: X', title: 'Handoff X', projectId: 'p1' })
    expect(asked).toEqual([join(dir, 'handoff-x.md')])
    expect(r).toEqual({ ok: true, path: join(dir, 'handoff-x.md') })
    expect(readFileSync(join(dir, 'handoff-x.md'), 'utf8')).toBe('# Handoff: X\n')
  })

  it('starts in the home folder when the project has none', async () => {
    const save = make(() => null)
    expect(await save({ text: 'x', title: 'T', projectId: 'p2' })).toMatchObject({ ok: false, cancelled: true })
    expect(await save({ text: 'x', title: 'T' })).toMatchObject({ ok: false, cancelled: true })
    expect(asked).toEqual([join('C:\\Users\\me', 't.md'), join('C:\\Users\\me', 't.md')])
  })

  it('refuses places the Reader could not open the file from', async () => {
    expect(await make(() => 'C:\\Windows\\handoff.md')({ text: 'x', title: 'T' })).toMatchObject({ ok: false, reason: expect.stringContaining('C:\\Windows') })
    expect(await make(() => '\\\\server\\share\\handoff.md')({ text: 'x', title: 'T' })).toMatchObject({ ok: false, reason: expect.stringContaining('Network') })
  })

  it('refuses an empty handoff without asking where', async () => {
    const save = make(() => join(dir, 'a.md'))
    expect(await save({ text: '  ', title: 'T' })).toMatchObject({ ok: false, reason: 'The handoff is empty.' })
    expect(await save(null as never)).toMatchObject({ ok: false })
    expect(asked).toEqual([])
  })

  it('says why a write failed', async () => {
    const save = make(() => join(dir, 'missing-folder', 'a.md'))
    expect(await save({ text: 'x', title: 'T' })).toMatchObject({ ok: false, reason: expect.stringContaining("couldn't be saved") })
  })
})
