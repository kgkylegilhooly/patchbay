import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { createWorkflowStore } from '../../src/main/workflows/store'
import type { WorkflowDefinition } from '../../src/shared/workflow'
import { featureWorkflow } from './fixtures'

let dir: string
let clock: number
let logs: string[]
const store = () => createWorkflowStore(dir, { now: () => clock++, log: (l) => logs.push(l) })
const drafts = () => join(dir, 'drafts')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pb-workflows-'))
  clock = 1000
  logs = []
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const brokenDraft = (): WorkflowDefinition => {
  const d = featureWorkflow()
  delete d.jobs[0].inputs.instructions
  return d
}

describe('saving drafts', () => {
  test('a draft saves and reads back unchanged, apart from the canvas document', async () => {
    const s = store()
    const saved = await s.saveDraft(featureWorkflow(), null)
    expect(saved).toMatchObject({ ok: true, issues: [], record: { id: 'feature', version: 1, createdAt: 1000, updatedAt: 1000, published: [] } })
    const fresh = store().get('feature')
    expect(fresh.ok && fresh.record.definition).toEqual(featureWorkflow())
    expect(readdirSync(dir)).toEqual(['drafts'])
    expect(readdirSync(drafts())).toEqual(['feature.json'])
  })

  test('an invalid draft still saves, with its issues', async () => {
    const saved = await store().saveDraft(brokenDraft(), null)
    expect(saved.ok).toBe(true)
    expect(saved.ok && saved.issues.map((i) => i.code)).toEqual(['missing-input'])
    expect(store().list().workflows).toEqual([{ id: 'feature', name: 'Feature', version: 1, updatedAt: 1000, published: [], issues: 1 }])
  })

  test('something that can\'t be represented isn\'t saved', async () => {
    const raw = { ...featureWorkflow(), runAt: 'midnight' }
    const saved = await store().saveDraft(raw, null)
    expect(saved).toMatchObject({ ok: false, code: 'shape' })
    expect(existsSync(drafts())).toBe(false)
    expect(await store().saveDraft({ ...featureWorkflow(), id: '../escape' }, null)).toMatchObject({ ok: false, code: 'bad-id' })
  })

  test('an edit against an older version is refused, with the current record', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    const agentEdit = { ...featureWorkflow(), name: 'Agent edit' }
    const uiEdit = { ...featureWorkflow(), name: 'UI edit' }
    expect(await s.saveDraft(agentEdit, 1)).toMatchObject({ ok: true, record: { version: 2 } })
    const late = await s.saveDraft(uiEdit, 1)
    expect(late).toMatchObject({ ok: false, code: 'conflict', current: { version: 2, definition: { name: 'Agent edit' } } })
    expect(!late.ok && late.message).toContain('Reload it and make the edit again')
    expect(await s.saveDraft(featureWorkflow(), null)).toMatchObject({ ok: false, code: 'conflict' })
    expect(await s.saveDraft({ ...featureWorkflow(), id: 'other' }, 3)).toMatchObject({ ok: false, code: 'conflict' })
  })

  test('saves to one workflow happen one at a time: of two concurrent edits from the same version, one wins', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    const [a, b] = await Promise.all([s.saveDraft({ ...featureWorkflow(), name: 'A' }, 1), s.saveDraft({ ...featureWorkflow(), name: 'B' }, 1)])
    expect([a.ok, b.ok]).toEqual([true, false])
    expect(store().get('feature')).toMatchObject({ ok: true, record: { version: 2, definition: { name: 'A' } } })
  })

  test('writes leave no temporary files', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    await s.saveDraft(featureWorkflow(), 1)
    await s.flush()
    expect(readdirSync(drafts())).toEqual(['feature.json'])
  })
})

describe('damaged and unsupported files', () => {
  test('a damaged file is moved aside and the rest still load', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    writeFileSync(join(drafts(), 'broken.json'), '{"schema": 1, "id": "broken", ')
    writeFileSync(join(drafts(), 'wrong.json'), JSON.stringify({ schema: 1, id: 'wrong', version: 'one' }))
    const listed = store().list()
    expect(listed.workflows.map((w) => [w.id, w.problem ? 'unavailable' : 'ok'])).toEqual([['broken', 'unavailable'], ['feature', 'ok'], ['wrong', 'unavailable']])
    expect(listed.workflows[0].problem).toMatch(/Not valid JSON/)
    expect(listed.workflows[2].problem).toBe('"version" must be a whole number from 1.')
    expect(listed.workflows[0].setAside).toMatch(/broken\.json\.bad-\d+$/)
    expect(logs).toHaveLength(2)
    // Moved aside, and still reported as kept aside afterwards.
    const again = store().list()
    expect(again.workflows.map((w) => w.id)).toEqual(['feature'])
    expect(again.setAside).toHaveLength(2)
    expect(readFileSync(again.setAside[0], 'utf8')).toBe('{"schema": 1, "id": "broken", ')
  })

  test('a file whose definition has an unknown field is set aside rather than run with a changed meaning', () => {
    mkdirSync(drafts(), { recursive: true })
    const record = { schema: 1, id: 'feature', version: 1, createdAt: 1, updatedAt: 1, published: [], definition: { ...featureWorkflow(), cron: '* * * * *' } }
    writeFileSync(join(drafts(), 'feature.json'), JSON.stringify(record))
    const got = store().get('feature')
    expect(got).toMatchObject({ ok: false })
    expect(!got.ok && got.message).toContain('"cron"')
  })

  test('a newer Patchbay\'s file is left alone, listed, and not overwritten', async () => {
    mkdirSync(drafts(), { recursive: true })
    const file = join(drafts(), 'feature.json')
    const newer = JSON.stringify({ schema: 2, id: 'feature', version: 7 })
    writeFileSync(file, newer)
    const s = store()
    expect(s.list().workflows).toEqual([{ id: 'feature', problem: 'Saved by a newer Patchbay (schema 2); this one reads schema 1.' }])
    expect(await s.saveDraft(featureWorkflow(), null)).toMatchObject({ ok: false, code: 'newer' })
    expect(readFileSync(file, 'utf8')).toBe(newer)
    expect(readdirSync(drafts())).toEqual(['feature.json'])
  })

  test('a file named for one workflow holding another is damaged', () => {
    mkdirSync(drafts(), { recursive: true })
    const record = { schema: 1, id: 'feature', version: 1, createdAt: 1, updatedAt: 1, published: [], definition: featureWorkflow() }
    writeFileSync(join(drafts(), 'other.json'), JSON.stringify(record))
    expect(store().get('other')).toMatchObject({ ok: false, message: 'The file is named for other but holds feature.' })
  })

  test('nothing there is fine', () => {
    expect(store().list()).toEqual({ workflows: [], setAside: [] })
    expect(store().get('nope')).toMatchObject({ ok: false, message: "There's no workflow nope." })
  })
})

describe('publishing revisions', () => {
  test('publishes an immutable numbered revision, and saving never runs or publishes anything', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    expect(existsSync(join(dir, 'revisions'))).toBe(false)
    const p1 = await s.publish('feature', 1)
    expect(p1).toMatchObject({ ok: true, revision: { workflowId: 'feature', revision: 1 }, record: { version: 1, published: [1] } })
    await s.saveDraft({ ...featureWorkflow(), name: 'Feature v2' }, 1)
    const p2 = await s.publish('feature', 2)
    expect(p2.ok && p2.record.published).toEqual([1, 2])
    const r1 = store().getRevision('feature', 1)
    expect(r1.ok && r1.revision.definition.name).toBe('Feature')
    const r2 = store().getRevision('feature', 2)
    expect(r2.ok && r2.revision.definition.name).toBe('Feature v2')
  })

  test('an invalid draft can\'t be published', async () => {
    const s = store()
    await s.saveDraft(brokenDraft(), null)
    const p = await s.publish('feature', 1)
    expect(p).toMatchObject({ ok: false, code: 'invalid' })
    expect(!p.ok && p.issues?.[0].code).toBe('missing-input')
  })

  test('publishing what was checked: a changed draft is refused', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    await s.saveDraft(featureWorkflow(), 1)
    expect(await s.publish('feature', 1)).toMatchObject({ ok: false, code: 'conflict' })
    expect(await s.publish('ghost', 1)).toMatchObject({ ok: false, code: 'missing' })
  })

  test('a revision left over from a crash isn\'t overwritten', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    await s.publish('feature', 1)
    // As if Patchbay stopped after writing revision 2 but before recording it in the draft.
    const orphan = join(dir, 'revisions', 'feature', '2.json')
    writeFileSync(orphan, readFileSync(join(dir, 'revisions', 'feature', '1.json'), 'utf8').replace('"revision": 1', '"revision": 2'))
    const p = await s.publish('feature', 1)
    expect(p.ok && p.revision.revision).toBe(3)
  })

  test('a revision edited after publishing is never trusted', async () => {
    const s = store()
    await s.saveDraft(featureWorkflow(), null)
    await s.publish('feature', 1)
    const file = join(dir, 'revisions', 'feature', '1.json')
    writeFileSync(file, readFileSync(file, 'utf8').replace('"npm"', '"curl"'))
    const got = store().getRevision('feature', 1)
    expect(got).toMatchObject({ ok: false })
    expect(!got.ok && got.message).toContain('changed after it was published')
    expect(readdirSync(join(dir, 'revisions', 'feature'))[0]).toMatch(/^1\.json\.bad-/)
  })
})
