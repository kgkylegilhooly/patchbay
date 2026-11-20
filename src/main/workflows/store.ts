import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readIfPresentSync, writeAtomic } from '../../core/persist/atomicFile'
import { BUILT_IN_ACTIONS, type ActionCatalog } from '../../core/workflow/catalog'
import { readDraftRecord, readRevisionRecord, WORKFLOW_ID, type RecordProblem } from '../../core/workflow/records'
import { snapshotRevision } from '../../core/workflow/revision'
import { validateDefinition } from '../../core/workflow/validate'
import { readDefinition, WORKFLOW_SCHEMA, WorkflowShapeError, type DefinitionRevision, type DraftRecord, type ValidationIssue } from '../../shared/workflow'

/**
 * Workflow drafts and published revisions under the profile, apart from the canvas document:
 *   <dir>/drafts/<id>.json            the editable draft (DraftRecord)
 *   <dir>/revisions/<id>/<n>.json     published revisions, written once and never changed
 * Every write is atomic, and writes to one workflow are queued so two saves can't interleave. Saving never runs
 * anything. Reading never throws: a damaged file is moved aside to `<file>.bad-<time>` and reported, and a newer
 * Patchbay's file is reported and left as it is.
 */

export interface WorkflowListing {
  id: string
  name?: string
  version?: number
  updatedAt?: number
  published?: number[]
  /** How many validation issues the draft has. A draft with issues can be saved but not published or run. */
  issues?: number
  /** Why it can't be used, when it can't. */
  problem?: string
  /** Where a damaged file was moved to. */
  setAside?: string
}

export type SaveResult =
  | { ok: true; record: DraftRecord; issues: ValidationIssue[] }
  | { ok: false; code: 'shape' | 'bad-id' | 'conflict' | 'newer'; message: string; current?: DraftRecord }

export type PublishResult =
  | { ok: true; revision: DefinitionRevision; record: DraftRecord }
  | { ok: false; code: 'missing' | 'conflict' | 'invalid'; message: string; issues?: ValidationIssue[] }

type Loaded = { ok: true; record: DraftRecord } | { ok: false; missing: true } | { ok: false; missing?: false; problem: RecordProblem; setAside?: string }

export function createWorkflowStore(dir: string, opts: { now?: () => number; log?: (line: string) => void; catalog?: ActionCatalog } = {}) {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.error(line))
  const catalog = opts.catalog ?? BUILT_IN_ACTIONS
  const draftsDir = join(dir, 'drafts')
  const draftFile = (id: string): string => join(draftsDir, `${id}.json`)
  const revisionsDir = (id: string): string => join(dir, 'revisions', id)
  const revisionFile = (id: string, n: number): string => join(revisionsDir(id), `${n}.json`)

  const setAside = (file: string, why: string): string | undefined => {
    let target = `${file}.bad-${now()}`
    for (let n = 1; readIfPresentSync(target) !== null; n++) target = `${file}.bad-${now()}-${n}`
    try {
      renameSync(file, target)
      log(`Workflows: ${file} couldn't be used (${why}); it was moved to ${target}.`)
      return target
    } catch (e) {
      log(`Workflows: ${file} couldn't be used (${why}), and couldn't be moved aside (${(e as Error).message}).`)
      return undefined
    }
  }

  const load = (id: string): Loaded => {
    const file = draftFile(id)
    let text: string | null
    try { text = readIfPresentSync(file) } catch (e) {
      return { ok: false, problem: { kind: 'damaged', message: `Couldn't be read: ${(e as Error).message}` } }
    }
    if (text === null) return { ok: false, missing: true }
    let raw: unknown
    try { raw = JSON.parse(text) } catch (e) {
      const problem: RecordProblem = { kind: 'damaged', message: `Not valid JSON: ${(e as Error).message}` }
      return { ok: false, problem, setAside: setAside(file, problem.message) }
    }
    const read = readDraftRecord(raw, id)
    if (read.ok) return read
    if (read.problem.kind === 'newer') return { ok: false, problem: read.problem }
    return { ok: false, problem: read.problem, setAside: setAside(file, read.problem.message) }
  }

  /** One queue per workflow, so saves and publishes of it happen one at a time, in order. */
  const queues = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, work: () => Promise<T>): Promise<T> => {
    const prev = queues.get(id) ?? Promise.resolve()
    const next = prev.then(work, work)
    const tail = next.catch(() => undefined)
    queues.set(id, tail)
    void tail.then(() => { if (queues.get(id) === tail) queues.delete(id) })
    return next
  }

  const write = (record: DraftRecord): Promise<void> => writeAtomic(draftFile(record.id), `${JSON.stringify(record, null, 2)}\n`)

  const revisionNumbers = (id: string): number[] => {
    try {
      return readdirSync(revisionsDir(id)).flatMap((f) => (/^\d+\.json$/.test(f) ? [Number(f.slice(0, -5))] : []))
    } catch {
      return []
    }
  }

  return {
    /** Every draft, each with its validation issue count or why it can't be used. Also lists files already set aside. */
    list(): { workflows: WorkflowListing[]; setAside: string[] } {
      let files: string[] = []
      try { files = readdirSync(draftsDir) } catch { /* No drafts yet. */ }
      const workflows: WorkflowListing[] = []
      for (const f of files.filter((f) => f.endsWith('.json')).sort()) {
        const id = f.slice(0, -5)
        if (!WORKFLOW_ID.test(id)) continue
        const got = load(id)
        if (got.ok) {
          const { record } = got
          workflows.push({ id, name: record.definition.name, version: record.version, updatedAt: record.updatedAt, published: record.published, issues: validateDefinition(record.definition, catalog).length })
        } else if (!got.missing) {
          workflows.push({ id, problem: got.problem.message, ...(got.setAside ? { setAside: got.setAside } : {}) })
        }
      }
      const aside = files.filter((f) => /\.json\.bad-/.test(f)).map((f) => join(draftsDir, f)).sort()
      return { workflows, setAside: aside }
    },

    get(id: string): { ok: true; record: DraftRecord; issues: ValidationIssue[] } | { ok: false; message: string; setAside?: string } {
      if (!WORKFLOW_ID.test(id)) return { ok: false, message: `"${id}" isn't a workflow id.` }
      const got = load(id)
      if (got.ok) return { ok: true, record: got.record, issues: validateDefinition(got.record.definition, catalog) }
      if (got.missing) return { ok: false, message: `There's no workflow ${id}.` }
      return { ok: false, message: got.problem.message, ...(got.setAside ? { setAside: got.setAside } : {}) }
    },

    /**
     * Saves a draft. `expectedVersion` is the version the edit was made against (null for a new workflow), so an
     * edit made against an older copy is refused rather than overwriting someone else's change. A draft with
     * validation issues still saves; they come back with it.
     */
    saveDraft(raw: unknown, expectedVersion: number | null): Promise<SaveResult> {
      let definition: DraftRecord['definition']
      try { definition = readDefinition(raw) } catch (e) {
        if (e instanceof WorkflowShapeError) return Promise.resolve({ ok: false, code: 'shape', message: e.message })
        throw e
      }
      if (!WORKFLOW_ID.test(definition.id)) {
        return Promise.resolve({ ok: false, code: 'bad-id', message: `"${definition.id}" can't be a workflow id: use letters, digits, - and _ (up to 64).` })
      }
      return serial(definition.id, async (): Promise<SaveResult> => {
        const got = load(definition.id)
        if (!got.ok && !got.missing && got.problem.kind === 'newer') {
          return { ok: false, code: 'newer', message: `${definition.id} was saved by a newer Patchbay, so this one won't overwrite it. ${got.problem.message}` }
        }
        const current = got.ok ? got.record : null
        if ((current?.version ?? null) !== expectedVersion) {
          return {
            ok: false,
            code: 'conflict',
            message: current
              ? `The workflow changed since this edit was made (now version ${current.version}, the edit was against ${expectedVersion ?? 'a new workflow'}). Reload it and make the edit again.`
              : `There's no saved workflow ${definition.id} to update; save it as new.`,
            ...(current ? { current } : {})
          }
        }
        const at = now()
        const record: DraftRecord = {
          schema: WORKFLOW_SCHEMA,
          id: definition.id,
          version: (current?.version ?? 0) + 1,
          createdAt: current?.createdAt ?? at,
          updatedAt: at,
          published: current?.published ?? [],
          definition
        }
        await write(record)
        return { ok: true, record, issues: validateDefinition(definition, catalog) }
      })
    },

    /** Publishes the draft at `expectedVersion` as the next revision. Refused while it has validation issues. */
    publish(id: string, expectedVersion: number): Promise<PublishResult> {
      if (!WORKFLOW_ID.test(id)) return Promise.resolve({ ok: false, code: 'missing', message: `"${id}" isn't a workflow id.` })
      return serial(id, async (): Promise<PublishResult> => {
        const got = load(id)
        if (!got.ok) return { ok: false, code: 'missing', message: got.missing ? `There's no workflow ${id}.` : got.problem.message }
        const { record } = got
        if (record.version !== expectedVersion) {
          return { ok: false, code: 'conflict', message: `The workflow changed since it was checked (now version ${record.version}, not ${expectedVersion}). Check it again before publishing.` }
        }
        const n = Math.max(0, ...record.published, ...revisionNumbers(id)) + 1
        const snap = snapshotRevision(record.definition, n, now(), catalog)
        if (!snap.ok) return { ok: false, code: 'invalid', message: `Fix ${snap.issues.length} problem(s) before publishing.`, issues: snap.issues }
        // The revision first: a crash before the draft is updated leaves an extra revision, never a missing one.
        await writeAtomic(revisionFile(id, n), `${JSON.stringify(snap.revision, null, 2)}\n`)
        const next: DraftRecord = { ...record, published: [...record.published, n] }
        await write(next)
        return { ok: true, revision: snap.revision, record: next }
      })
    },

    /** A published revision, checked against its hash. A damaged one is set aside; it is never repaired. */
    getRevision(id: string, n: number): { ok: true; revision: DefinitionRevision } | { ok: false; message: string } {
      if (!WORKFLOW_ID.test(id) || !Number.isInteger(n) || n < 1) return { ok: false, message: 'Not a workflow revision.' }
      const file = revisionFile(id, n)
      let text: string | null
      try { text = readIfPresentSync(file) } catch (e) { return { ok: false, message: (e as Error).message } }
      if (text === null) return { ok: false, message: `Workflow ${id} has no revision ${n}.` }
      let raw: unknown
      try { raw = JSON.parse(text) } catch (e) {
        setAside(file, (e as Error).message)
        return { ok: false, message: `Revision ${n} of ${id} is damaged.` }
      }
      const read = readRevisionRecord(raw, id, n)
      if (read.ok) return read
      if (read.problem.kind === 'damaged') setAside(file, read.problem.message)
      return { ok: false, message: read.problem.message }
    },

    /** Resolves when every queued write has finished. */
    async flush(): Promise<void> {
      await Promise.all([...queues.values()])
    }
  }
}

export type WorkflowStore = ReturnType<typeof createWorkflowStore>
