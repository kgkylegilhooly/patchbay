import { readdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { readIfPresentSync, writeAtomic } from '../../core/persist/atomicFile'
import {
  ACTIVE_STATES, readWorkflowShape, WORKFLOW_SCHEMA, type AttemptState, type OutputValue, type RunState, type StepAttempt, type WorkflowRun
} from '../../shared/workflow'

/**
 * Workflow runs, one JSON file each, and the hashes the person has started ("trusted"), apart from the canvas
 * document:
 *   <dir>/runs/<runId>.json
 *   <dir>/trusted.json
 * Each file is written whole, atomically, one write at a time (as agentStops.ts's stopFile). Loading never throws: a
 * damaged run file is moved to `<file>.bad-<time>` and reported, and a newer Patchbay's is left where it is.
 */

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isTime = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const ATTEMPT_STATES: readonly AttemptState[] = ['launching', 'running', 'waiting-for-you', 'succeeded', 'failed', 'interrupted', 'superseded']
const RUN_STATES: readonly RunState[] = ['running', 'waiting-for-you', 'succeeded', 'failed', 'stopped', 'needs-attention']

function isOutput(v: unknown): v is OutputValue {
  if (!isObject(v)) return false
  if (v.type === 'text') return isText(v.text)
  return v.type === 'file' && isText(v.path) && isText(v.sha256) && isText(v.source)
}

function isAttempt(v: unknown): v is StepAttempt {
  if (!isObject(v)) return false
  return isText(v.id) && isText(v.step) && Number.isInteger(v.n) && (v.nodeId === null || isText(v.nodeId)) &&
    ATTEMPT_STATES.includes(v.state as AttemptState) && isTime(v.startedAt) && (v.endedAt === undefined || isTime(v.endedAt)) &&
    (v.outputs === undefined || (isObject(v.outputs) && Object.values(v.outputs).every(isOutput))) &&
    (v.exitCode === undefined || Number.isInteger(v.exitCode)) && (v.why === undefined || isText(v.why)) &&
    (v.decidedBy === undefined || v.decidedBy === 'person') && (v.via === undefined || v.via === 'retry' || v.via === 'changes')
}

/** A run from parsed JSON, or why it can't be used. */
export function readRun(raw: unknown): { ok: true; run: WorkflowRun } | { ok: false; newer: boolean; problem: string } {
  if (!isObject(raw)) return { ok: false, newer: false, problem: 'Not a workflow run.' }
  if (raw.schema !== WORKFLOW_SCHEMA) {
    const newer = typeof raw.schema === 'number' && raw.schema > WORKFLOW_SCHEMA
    return { ok: false, newer, problem: newer ? `Saved by a newer Patchbay (schema ${raw.schema}).` : `Unknown schema ${JSON.stringify(raw.schema)}.` }
  }
  try { readWorkflowShape(raw.definition) } catch (e) { return { ok: false, newer: false, problem: `Its definition: ${(e as Error).message}` } }
  const wt = raw.worktree
  const ok = isText(raw.id) && RUN_ID.test(raw.id) && isText(raw.projectId) && isText(raw.ref) && isText(raw.hash) && isText(raw.cwd) &&
    (wt === null || (isObject(wt) && isText(wt.path) && isText(wt.branch))) && (raw.groupId === null || isText(raw.groupId)) &&
    (raw.taskId === undefined || isText(raw.taskId)) && RUN_STATES.includes(raw.state as RunState) && isObject(raw.inputs) &&
    Object.values(raw.inputs).every((v) => ['string', 'number', 'boolean'].includes(typeof v)) &&
    Array.isArray(raw.attempts) && raw.attempts.every(isAttempt) && isTime(raw.startedAt) && (raw.endedAt === undefined || isTime(raw.endedAt)) &&
    (raw.stopped === undefined || typeof raw.stopped === 'boolean')
  if (!ok) return { ok: false, newer: false, problem: 'A field is missing or of the wrong kind.' }
  return { ok: true, run: raw as unknown as WorkflowRun }
}

export interface RunStoreLoad {
  runs: WorkflowRun[]
  /** Files that couldn't be used: moved aside (damaged) or left (newer). */
  unavailable: Array<{ file: string; problem: string; setAside?: string }>
}

export function createRunStore(dir: string, opts: { now?: () => number; log?: (line: string) => void } = {}) {
  const now = opts.now ?? Date.now
  const log = opts.log ?? ((line: string) => console.error(line))
  const runsDir = join(dir, 'runs')
  const trustFile = join(dir, 'trusted.json')
  const writes = new Map<string, Promise<void>>()

  /** Queues a whole-file write after any earlier one to the same file. Resolves when it is on disk. */
  const write = (file: string, text: string): Promise<void> => {
    const next = (writes.get(file) ?? Promise.resolve()).then(() => writeAtomic(file, text))
    const tail = next.catch((e: unknown) => log(`Workflows: ${file} couldn't be saved: ${String(e)}`))
    writes.set(file, tail)
    void tail.then(() => { if (writes.get(file) === tail) writes.delete(file) })
    return next
  }

  let trusted: Set<string> | null = null
  const trust = (): Set<string> => {
    if (trusted) return trusted
    trusted = new Set()
    try {
      const raw = JSON.parse(readIfPresentSync(trustFile) ?? 'null') as { hashes?: unknown } | null
      if (raw && Array.isArray(raw.hashes)) for (const h of raw.hashes) if (isText(h)) trusted.add(h)
    } catch (e) {
      log(`Workflows: the trusted list couldn't be read (${(e as Error).message}); agents can't start workflows until you start them again.`)
    }
    return trusted
  }

  return {
    /** Every saved run. Damaged files are moved aside; none of this stops the app. */
    load(): RunStoreLoad {
      const out: RunStoreLoad = { runs: [], unavailable: [] }
      let files: string[] = []
      try { files = readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort() } catch { return out }
      for (const f of files) {
        const file = join(runsDir, f)
        let raw: unknown
        let problem: string
        let newer = false
        try {
          raw = JSON.parse(readIfPresentSync(file) ?? 'null')
          const read = readRun(raw)
          if (read.ok && `${read.run.id}.json` === f) { out.runs.push(read.run); continue }
          problem = read.ok ? `The file is named ${f} but holds run ${read.run.id}.` : read.problem
          newer = !read.ok && read.newer
        } catch (e) {
          problem = `Not valid JSON: ${(e as Error).message}`
        }
        if (newer) { out.unavailable.push({ file, problem }); continue }
        const target = `${file}.bad-${now()}`
        try {
          renameSync(file, target)
          log(`Workflows: the run file ${file} couldn't be used (${problem}); it was moved to ${target}.`)
          out.unavailable.push({ file, problem, setAside: target })
        } catch (e) {
          log(`Workflows: the run file ${file} couldn't be used (${problem}) or moved aside (${(e as Error).message}).`)
          out.unavailable.push({ file, problem })
        }
      }
      return out
    },

    /** Saves a run. Resolves once it is on disk: effects are only carried out after that. */
    save(run: WorkflowRun): Promise<void> {
      if (!RUN_ID.test(run.id)) return Promise.reject(new Error(`Bad run id ${run.id}`))
      return write(join(runsDir, `${run.id}.json`), `${JSON.stringify(run)}\n`)
    },

    isTrusted(hash: string): boolean {
      return trust().has(hash)
    },

    /** Records that the person started this exact content. */
    trust(hash: string): Promise<void> {
      const set = trust()
      if (set.has(hash)) return Promise.resolve()
      set.add(hash)
      return write(trustFile, `${JSON.stringify({ hashes: [...set] })}\n`)
    },

    async flush(): Promise<void> {
      await Promise.all([...writes.values()])
    }
  }
}

export type RunStore = ReturnType<typeof createRunStore>

/** Whether a run still has anything going on. */
export const isLive = (run: WorkflowRun): boolean => run.attempts.some((a) => ACTIVE_STATES.includes(a.state))
