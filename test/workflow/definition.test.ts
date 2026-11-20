import { describe, expect, test } from 'vitest'
import { readDefinition, WorkflowShapeError, jobDependencies } from '../../src/shared/workflow'
import { readAndValidate } from '../../src/core/workflow/validate'
import { canonicalJson, definitionHash, snapshotRevision } from '../../src/core/workflow/revision'
import { featureWorkflow } from './fixtures'

const shapeError = (raw: unknown): WorkflowShapeError => {
  try {
    readDefinition(raw)
  } catch (e) {
    if (e instanceof WorkflowShapeError) return e
    throw e
  }
  throw new Error('read without error')
}

describe('reading definitions', () => {
  test('a valid definition round-trips through JSON without losing meaning', () => {
    const def = featureWorkflow()
    const back = readDefinition(JSON.parse(JSON.stringify(def)))
    expect(back).toEqual(def)
    expect(definitionHash(back)).toBe(definitionHash(def))
    // And again, so reading is stable.
    expect(readDefinition(JSON.parse(JSON.stringify(back)))).toEqual(def)
  })

  test('file and workspace values keep their identity', () => {
    const def = featureWorkflow()
    def.jobs[0].inputs.workspace = { from: 'const', value: { kind: 'workspace', path: 'C:/a', revision: null } }
    def.inputs.push({ key: 'spec', label: 'Spec', type: 'file', default: { kind: 'file', path: 'spec.md', sha256: 'abc' } })
    expect(readDefinition(JSON.parse(JSON.stringify(def)))).toEqual(def)
  })

  test('fields this version doesn\'t know are refused, never dropped', () => {
    const raw = JSON.parse(JSON.stringify(featureWorkflow()))
    raw.jobs[3].shell = 'rm -rf /'
    const e = shapeError(raw)
    expect(e.code).toBe('unknown-field')
    expect(e.path).toBe('jobs.3.shell')
    expect(e.message).toContain('"shell"')
  })

  test('a newer schema says so', () => {
    const e = shapeError({ ...featureWorkflow(), schema: 2 })
    expect(e.message).toMatch(/newer Patchbay/)
  })

  test('wrong JSON types name the field', () => {
    const raw = JSON.parse(JSON.stringify(featureWorkflow()))
    raw.jobs[0].inputs.agent = { from: 'variable', name: 'x' }
    expect(shapeError(raw).path).toBe('jobs.plan.inputs.agent.from')
    raw.jobs[0].inputs.agent = { from: 'const', value: null }
    expect(shapeError(raw).path).toBe('jobs.plan.inputs.agent.value')
    expect(shapeError({ ...featureWorkflow(), inputs: {} }).path).toBe('inputs')
  })

  test('lists of lists are refused', () => {
    const raw = JSON.parse(JSON.stringify(featureWorkflow()))
    raw.jobs[3].inputs.args = { from: 'list', items: [{ from: 'list', items: [] }] }
    expect(shapeError(raw).message).toMatch(/can't hold another list/)
  })

  test('readAndValidate turns a shape problem into an issue', () => {
    const r = readAndValidate({ schema: 1, id: 'x', name: 'X', inputs: [], jobs: 'nope' })
    expect(r.definition).toBeUndefined()
    expect(r.issues).toEqual([expect.objectContaining({ code: 'shape', path: 'jobs' })])
  })

  test('dependencies come from bindings, template chips and wait-for, without duplicates', () => {
    const [, approve, implement, tests, review] = featureWorkflow().jobs
    expect(jobDependencies(approve)).toEqual(['plan'])
    expect(jobDependencies(implement)).toEqual(['plan', 'approve'])
    expect(jobDependencies(tests)).toEqual(['implement'])
    expect(jobDependencies(review)).toEqual(['implement', 'tests'])
  })
})

describe('revisions', () => {
  test('a revision is a frozen copy with a stable hash', () => {
    const def = featureWorkflow()
    const snap = snapshotRevision(def, 3, 42)
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.revision).toMatchObject({ workflowId: 'feature', revision: 3, publishedAt: 42 })
    expect(Object.isFrozen(snap.revision.definition.jobs[0].inputs)).toBe(true)
    def.jobs[0].name = 'Changed later'
    expect(snap.revision.definition.jobs[0].name).toBe('Plan')
    expect(snap.revision.hash).toBe(definitionHash(featureWorkflow()))
  })

  test('the hash ignores key order', () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }))
  })

  test('an invalid definition can\'t be published', () => {
    const def = featureWorkflow()
    def.jobs[0].action = 'email'
    const snap = snapshotRevision(def, 1, 0)
    expect(snap.ok).toBe(false)
    if (!snap.ok) expect(snap.issues.map((i) => i.code)).toContain('action-unavailable')
  })
})
