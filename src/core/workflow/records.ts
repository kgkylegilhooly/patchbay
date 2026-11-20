import { readDefinition, WORKFLOW_SCHEMA, WorkflowShapeError, type DefinitionRevision, type DraftRecord } from '../../shared/workflow'
import { definitionHash } from './revision'

/** Why a stored record can't be used: damaged (set aside), or from a newer Patchbay (left alone). */
export type RecordProblem = { kind: 'damaged' | 'newer'; message: string }

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A workflow id that's also a safe file name. */
export const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/

function schemaProblem(raw: Raw): RecordProblem | null {
  if (typeof raw.schema === 'number' && raw.schema > WORKFLOW_SCHEMA) {
    return { kind: 'newer', message: `Saved by a newer Patchbay (schema ${raw.schema}); this one reads schema ${WORKFLOW_SCHEMA}.` }
  }
  if (raw.schema !== WORKFLOW_SCHEMA) return { kind: 'damaged', message: `"schema" must be ${WORKFLOW_SCHEMA}.` }
  return null
}

function definitionProblem(v: unknown): { def: ReturnType<typeof readDefinition> } | RecordProblem {
  try {
    return { def: readDefinition(v) }
  } catch (e) {
    if (!(e instanceof WorkflowShapeError)) throw e
    return { kind: isObject(v) && typeof v.schema === 'number' && v.schema > WORKFLOW_SCHEMA ? 'newer' : 'damaged', message: e.message }
  }
}

/** Reads a stored draft from parsed JSON. */
export function readDraftRecord(raw: unknown, expectedId?: string): { ok: true; record: DraftRecord } | { ok: false; problem: RecordProblem } {
  if (!isObject(raw)) return { ok: false, problem: { kind: 'damaged', message: 'Not a workflow record.' } }
  const schema = schemaProblem(raw)
  if (schema) return { ok: false, problem: schema }
  const { id, version, createdAt, updatedAt, published } = raw
  if (typeof id !== 'string' || !WORKFLOW_ID.test(id)) return { ok: false, problem: { kind: 'damaged', message: '"id" is missing or not a valid workflow id.' } }
  if (expectedId !== undefined && id !== expectedId) return { ok: false, problem: { kind: 'damaged', message: `The file is named for ${expectedId} but holds ${id}.` } }
  if (!Number.isInteger(version) || (version as number) < 1) return { ok: false, problem: { kind: 'damaged', message: '"version" must be a whole number from 1.' } }
  if (!isTime(createdAt) || !isTime(updatedAt)) return { ok: false, problem: { kind: 'damaged', message: '"createdAt" and "updatedAt" must be times.' } }
  if (!Array.isArray(published) || !published.every((n) => Number.isInteger(n) && n > 0)) return { ok: false, problem: { kind: 'damaged', message: '"published" must be a list of revision numbers.' } }
  const read = definitionProblem(raw.definition)
  if ('kind' in read) return { ok: false, problem: read }
  if (read.def.id !== id) return { ok: false, problem: { kind: 'damaged', message: `The definition's id ${read.def.id} doesn't match the record's ${id}.` } }
  const extra = Object.keys(raw).filter((k) => !['schema', 'id', 'version', 'createdAt', 'updatedAt', 'published', 'definition'].includes(k))
  if (extra.length) return { ok: false, problem: { kind: 'newer', message: `Has fields this Patchbay doesn't know (${extra.join(', ')}).` } }
  return { ok: true, record: { schema: WORKFLOW_SCHEMA, id, version: version as number, createdAt, updatedAt, published: [...(published as number[])], definition: read.def } }
}

/** Reads a stored revision. Its hash must still match its definition, so an edited revision file is never trusted. */
export function readRevisionRecord(raw: unknown, workflowId: string, revision: number): { ok: true; revision: DefinitionRevision } | { ok: false; problem: RecordProblem } {
  if (!isObject(raw)) return { ok: false, problem: { kind: 'damaged', message: 'Not a workflow revision.' } }
  const schema = schemaProblem(raw)
  if (schema) return { ok: false, problem: schema }
  if (raw.workflowId !== workflowId || raw.revision !== revision) return { ok: false, problem: { kind: 'damaged', message: `Expected revision ${revision} of ${workflowId}.` } }
  if (!isTime(raw.publishedAt) || typeof raw.hash !== 'string') return { ok: false, problem: { kind: 'damaged', message: '"publishedAt" and "hash" are required.' } }
  const read = definitionProblem(raw.definition)
  if ('kind' in read) return { ok: false, problem: read }
  if (definitionHash(read.def) !== raw.hash) return { ok: false, problem: { kind: 'damaged', message: "The revision's content no longer matches its hash, so it was changed after it was published." } }
  return { ok: true, revision: { schema: WORKFLOW_SCHEMA, workflowId, revision, publishedAt: raw.publishedAt, hash: raw.hash, definition: read.def } }
}
