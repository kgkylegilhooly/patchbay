import { randomUUID, createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import type { CanvasStore, RunResult } from '../../shared/contract'
import { isProjectArchived, type AgentStatus, type CanvasNode, type ClaudeNode, type GroupNode, type RunNode } from '../../shared/model'
import type { TaskRevision } from '../../shared/task'
import { branchFor, showArgv } from '../../shared/recipe'
import { stepOutputs, workflowIssues, type OutputValue, type Workflow, type WorkflowRun } from '../../shared/workflow'
import { advance, checkRunInputs, createRun, currentAttempt, deadline, planStep, type Effect, type RunEvent } from '../../core/workflow/engine'
import { placeInGroup, placeInProject, placeNear } from '../../core/canvas/place'
import { agentsNow } from '../agentsAllowed'
import { viewSize } from '../viewSize'
import { findWorkflow, listWorkflows, REPO_WORKFLOWS, saveWorkflowFile, type WorkflowEntry } from './files'
import type { RunStore } from './store'

/** Statuses only a session that has started reports. */
const STARTED = new Set<AgentStatus>(['starting', 'working', 'idle', 'needs-you'])
/** A file output bigger than this is refused. */
export const MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
const TICK_MS = 30_000
const STEP_SIZE = { agent: { width: 620, height: 420 }, command: { width: 560, height: 300 } }
const FRAME = { width: 1340, height: 520 }

export interface WorkflowServiceDeps {
  store: CanvasStore
  runner: { startNode(id: string): Promise<void>; stopNode(id: string): Promise<void>; runs(): Record<string, RunResult>; onRun(cb: (id: string, run: RunResult) => void): void }
  tracker: { get(id: string): AgentStatus; onChange(cb: (id: string, status: AgentStatus) => void): void }
  /** Usage-limit holds: a held step's clock stops. */
  stops?: { holding(id: string): boolean }
  runStore: RunStore
  dataDir: string
  /** resources/launch-run.cjs, which runs a command step's program with no shell. */
  launcher: string
  toplevel(folder: string): Promise<string | null>
  createWorktree(a: { repo: string; branch: string }): Promise<{ path: string; branch: string; repo: string }>
  /** The deliverable task. Absent in tests that don't use it. */
  tasks?: {
    create(projectId: string, input: { brief: string; acceptanceCriteria: string[]; assignedSessionIds: string[]; cwd: string; requiredChecks: Array<{ id: string; command: string; cwd: string }>; dependsOn: string[] }): Promise<{ id: string }>
    submit(projectId: string, id: string, sessionId: string, summary: string): Promise<unknown>
    verify(projectId: string, id: string, sessionId: string, checkId: string): Promise<unknown>
  }
  /** Through the send queue, as a person's message. */
  send(nodeId: string, text: string): { ok: boolean; reason?: string }
  revision(cwd: string): Promise<TaskRevision>
  /** Shows a Markdown file to the person in a reader node in the group. Returns its id. */
  openReader?(path: string, a: { projectId: string; groupId: string | null }): Promise<string | null>
  /** Every change to a run, for the page. */
  changed?(run: WorkflowRun): void
  log?(line: string): void
  now?: () => number
  newId?: () => string
  builtIn?: readonly Workflow[]
}

export interface StartWorkflow {
  projectId: string
  ref: string
  /** The content the form showed. Start is refused if the file changed since. */
  hash?: string
  inputs: Record<string, unknown>
  /** Who asked: the person, or an agent's node (which may only start trusted personal workflows). */
  by: { person: true } | { agent: string }
  at?: { x: number; y: number }
}

export type StartResult = { ok: true; run: WorkflowRun } | { ok: false; reason: string; problems?: string[] }

/** A file output as `patchbay job-submit` sends it: text, or a path to copy. */
export type RawOutput = { key: string; text: string } | { key: string; file: string }

export type WorkflowService = ReturnType<typeof createWorkflowService>

const quoted = (p: string): string => `"${p.replace(/\\/g, '/')}"`
const insideFolder = (folder: string, p: string): boolean => {
  const rel = relative(folder, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function createWorkflowService(d: WorkflowServiceDeps) {
  const now = d.now ?? Date.now
  const newId = d.newId ?? randomUUID
  const log = d.log ?? ((line: string) => console.error(line))
  const personalDir = join(d.dataDir, 'workflows')
  const plansDir = join(d.dataDir, 'workflow-runs', 'plans')
  const artifactsDir = join(d.dataDir, 'workflow-artifacts')

  const loaded = d.runStore.load()
  const runs = new Map(loaded.runs.map((r) => [r.id, r]))
  /** Time each attempt has spent held at a usage limit, added to its time limit. In memory: a restart forgives it. */
  const held = new Map<string, number>()
  /** One queue per run, so events apply one at a time, in order. */
  const queues = new Map<string, Promise<unknown>>()

  const projectOf = (id: string) => d.store.get().projects.find((p) => p.id === id)
  const repoFor = async (projectId: string): Promise<{ repo: string | null; folder: string }> => {
    const folder = projectOf(projectId)?.folder ?? ''
    return { repo: folder ? await d.toplevel(folder).catch(() => null) : null, folder }
  }

  const list = async (projectId: string): Promise<{ entries: WorkflowEntry[]; repo: string | null; folder: string }> => {
    const { repo, folder } = await repoFor(projectId)
    return { entries: listWorkflows(personalDir, repo, d.builtIn ?? []), repo, folder }
  }

  /** What would block starting, before anything changes: issues, inputs, agents turned off, the repository. */
  const startProblems = (wf: Workflow, inputs: Record<string, unknown>, repo: string | null): string[] => {
    const problems = workflowIssues(wf).map((i) => i.message)
    const checked = checkRunInputs(wf, inputs)
    if (!checked.ok) problems.push(...checked.problems)
    const agents = agentsNow()
    for (const s of wf.steps) {
      if (s.kind === 'agent' && !agents.enabled.includes(s.agent)) problems.push(`Step "${s.title}" uses ${s.agent === 'codex' ? 'Codex' : 'Claude Code'}, which is turned off in Settings > Agents.`)
    }
    if (wf.worktree !== false && !repo) problems.push("Each run gets its own worktree, and this project's folder isn't in a git repository.")
    return [...new Set(problems)]
  }

  // Applying events

  const persistAndRun = async (run: WorkflowRun, effects: Effect[]): Promise<void> => {
    runs.set(run.id, run)
    // On disk before anything happens: an attempt and its node id are recorded before its node exists.
    await d.runStore.save(run)
    d.changed?.(run)
    for (const e of effects) {
      try {
        await perform(run.id, e)
      } catch (err) {
        log(`Workflow run ${run.id}: ${e.kind} failed: ${(err as Error).message}`)
        if (e.kind === 'launch-agent' || e.kind === 'launch-command') {
          // The node couldn't be made or started: say so on the step rather than leave it launching.
          void apply(run.id, { type: 'node-gone', nodeId: e.nodeId })
        }
      }
    }
  }

  /**
   * Applies an event to a run, after any before it. Resolves with the outcome. An event that needs reading first (a
   * folder's revision) is given as a function, so it still takes its place in the queue at once.
   */
  const apply = (runId: string, event: RunEvent | (() => Promise<RunEvent>)): Promise<{ ok: true; run: WorkflowRun } | { ok: false; code: string; message: string }> => {
    const prev = queues.get(runId) ?? Promise.resolve()
    const next = prev.then(async () => {
      const ev = typeof event === 'function' ? await event() : event
      const run = runs.get(runId)
      if (!run) return { ok: false as const, code: 'unknown-run', message: `There's no workflow run ${runId}.` }
      const r = advance(run, ev, { now: now(), newId })
      if (!r.ok) return r
      await persistAndRun(r.run, r.effects)
      return { ok: true as const, run: runs.get(runId)! }
    })
    const tail = next.catch((e: unknown) => log(`Workflow run ${runId}: ${String(e)}`))
    queues.set(runId, tail)
    void tail.then(() => { if (queues.get(runId) === tail) queues.delete(runId) })
    return next
  }

  const groupRect = (run: WorkflowRun): GroupNode | undefined => {
    const g = d.store.get().nodes.find((n) => n.id === run.groupId)
    return g?.kind === 'group' ? g : undefined
  }

  const spotFor = (run: WorkflowRun, size: { width: number; height: number }): { x: number; y: number; parentId: string | null } => {
    const g = groupRect(run)
    if (!g) return { ...placeInProject(d.store.get(), run.projectId, size, viewSize()), parentId: null }
    return { ...placeInGroup(d.store.get(), g.id, size), parentId: g.id }
  }

  const stepNumber = (run: WorkflowRun, key: string): number => run.definition.steps.findIndex((s) => s.key === key) + 1

  async function perform(runId: string, e: Effect): Promise<void> {
    const run = runs.get(runId)!
    switch (e.kind) {
      case 'launch-agent': {
        const at = spotFor(run, STEP_SIZE.agent)
        const node: ClaudeNode = {
          id: e.nodeId, kind: 'claude', agent: e.agent, title: `${stepNumber(run, e.step)}. ${e.title}`, cwd: e.cwd, prompt: e.prompt,
          sessionId: null, transcriptPath: null, after: [], x: Math.round(at.x), y: Math.round(at.y), ...STEP_SIZE.agent, parentId: at.parentId, projectId: run.projectId
        }
        d.store.dispatch({ op: 'addNode', node: node as CanvasNode })
        await d.runner.startNode(node.id)
        void apply(runId, { type: 'launched', attemptId: e.attemptId })
        return
      }
      case 'launch-command': {
        mkdirSync(plansDir, { recursive: true })
        const planFile = join(plansDir, `${e.nodeId}.json`)
        const logFile = join(artifactsDir, run.id, e.attemptId.replace(/:/g, '_'), 'log.txt')
        const note = `Step ${stepNumber(run, e.step)} of workflow "${run.definition.name}". Its exit code decides whether the run goes on.`
        writeFileSync(planFile, JSON.stringify({ file: e.argv[0], args: e.argv.slice(1), cwd: e.cwd, env: {}, note, logFile }))
        const at = spotFor(run, STEP_SIZE.command)
        const node: RunNode = {
          id: e.nodeId, kind: 'run', title: `${stepNumber(run, e.step)}. ${e.title}`, cwd: e.cwd, command: `node ${quoted(d.launcher)} ${quoted(planFile)}`,
          x: Math.round(at.x), y: Math.round(at.y), ...STEP_SIZE.command, parentId: at.parentId, projectId: run.projectId
        }
        d.store.dispatch({ op: 'addNode', node: node as CanvasNode })
        await d.runner.startNode(node.id)
        void apply(runId, { type: 'launched', attemptId: e.attemptId })
        return
      }
      case 'open-review':
        for (const s of e.show) {
          if (s.value.type === 'file' && /\.(md|markdown)$/i.test(s.value.path) && d.openReader) await d.openReader(s.value.path, { projectId: run.projectId, groupId: run.groupId })
        }
        return
      case 'start-node':
        await d.runner.startNode(e.nodeId)
        return
      case 'stop-node':
        if (d.store.get().nodes.some((n) => n.id === e.nodeId)) await d.runner.stopNode(e.nodeId)
        return
      case 'send': {
        const r = d.send(e.nodeId, e.text)
        if (!r.ok) log(`Workflow run ${run.id}: couldn't send to ${e.nodeId}: ${r.reason}`)
        return
      }
      case 'task-check':
        if (run.taskId && d.tasks) await d.tasks.verify(run.projectId, run.taskId, lastAgentNode(run) ?? 'workflow', e.step)
        return
      case 'finished':
        if (e.state === 'succeeded' && run.taskId && d.tasks) {
          const summary = lastAgentSummary(run) ?? `Workflow "${run.definition.name}" finished every step.`
          await d.tasks.submit(run.projectId, run.taskId, lastAgentNode(run) ?? 'workflow', summary)
        }
        return
    }
  }

  const lastAgent = (run: WorkflowRun) => [...run.definition.steps].reverse().map((s) => (s.kind === 'agent' ? currentAttempt(run, s.key) : undefined)).find((a) => a?.state === 'succeeded')
  const lastAgentNode = (run: WorkflowRun): string | null => lastAgent(run)?.nodeId ?? null
  const lastAgentSummary = (run: WorkflowRun): string | null => {
    const out = lastAgent(run)?.outputs?.summary
    return out?.type === 'text' ? out.text : null
  }

  // Starting

  const start = async (req: StartWorkflow): Promise<StartResult> => {
    const project = projectOf(req.projectId)
    if (!project) return { ok: false, reason: 'That project is gone.' }
    if (isProjectArchived(project)) return { ok: false, reason: `The project ${project.name} is archived. Unarchive it to start workflows in it.` }
    const { entries, repo, folder } = await list(req.projectId)
    const found = findWorkflow(entries, req.ref)
    if (!found.ok) return { ok: false, reason: found.problem }
    const { entry } = found
    if (req.hash !== undefined && req.hash !== entry.hash) {
      return { ok: false, reason: `The workflow "${entry.name}" has changed since it was shown${entry.file ? ` (${entry.file})` : ''}. Look at it again before starting it.` }
    }
    if ('agent' in req.by) {
      if (entry.source !== 'personal') {
        return { ok: false, reason: `"${entry.name}" is a ${entry.source} workflow, so only the person can start it, after seeing what it runs. Ask them to start it from New from recipe.` }
      }
      if (!d.runStore.isTrusted(entry.hash)) {
        return { ok: false, reason: `The person hasn't started "${entry.name}" as it is now${entry.file ? ` (${entry.file})` : ''}, so an agent can't. Ask them to start it once from New from recipe; after that you can start this exact version.` }
      }
    }
    const wf = entry.workflow
    const problems = startProblems(wf, req.inputs, repo)
    if (problems.length) return { ok: false, reason: problems[0], problems }

    const runId = newId()
    const firstText = wf.inputs.map((i) => req.inputs[i.key]).find((v): v is string => typeof v === 'string' && !!v.trim())
    let worktree: { path: string; branch: string } | null = null
    let cwd = folder
    if (wf.worktree !== false) {
      const branch = `workflow/${branchFor(firstText ?? wf.name) || 'run'}-${runId.slice(0, 6)}`
      try {
        const wt = await d.createWorktree({ repo: repo!, branch })
        worktree = { path: wt.path, branch: wt.branch }
        cwd = wt.path
      } catch (e) {
        return { ok: false, reason: `The run's worktree couldn't be made: ${(e as Error).message}` }
      }
    }

    // The group first, so steps have somewhere to go.
    const doc = d.store.get()
    const title = `Workflow: ${wf.name}${firstText ? ` — ${firstText.slice(0, 60)}` : ''}`
    const opener = 'agent' in req.by ? doc.nodes.find((n) => n.id === (req.by as { agent: string }).agent) : undefined
    const at = req.at ? placeNear(doc, { at: req.at, size: FRAME, projectId: project.id }) : opener ? placeNear(doc, { at: { x: opener.x + opener.width + 40, y: opener.y }, size: FRAME, projectId: project.id }) : placeInProject(doc, project.id, FRAME, viewSize())
    const group: GroupNode = {
      id: newId(), kind: 'group', title: title.slice(0, 200), x: Math.round(at.x), y: Math.round(at.y), ...FRAME, parentId: null, projectId: project.id,
      worktree: worktree && { path: worktree.path, branch: worktree.branch, repo: repo! }, ...(opener ? { openedBy: opener.id } : {})
    } as GroupNode
    d.store.dispatch({ op: 'addNode', node: group })

    let taskId: string | undefined
    if (wf.deliverable && d.tasks) {
      try {
        const checked = checkRunInputs(wf, req.inputs)
        const values = checked.ok ? checked.inputs : {}
        const fill = (a: string): string => a.replace(/\{\{\s*in:([A-Za-z][A-Za-z0-9_-]*)\s*\}\}/g, (_w, k: string) => (values[k] === undefined ? '' : String(values[k])))
        const requiredChecks = wf.steps.flatMap((s) => (s.kind === 'command' && s.taskCheck ? [{ id: s.key, command: showArgv(s.run.map(fill).filter((a, i) => i === 0 || a !== '')), cwd: s.folder ? resolve(cwd, s.folder) : cwd }] : []))
        const task = await d.tasks.create(project.id, { brief: `${wf.name}${firstText ? `: ${firstText}` : ''}`, acceptanceCriteria: wf.deliverable.criteria, assignedSessionIds: [], cwd, requiredChecks, dependsOn: [] })
        taskId = task.id
      } catch (e) {
        log(`Workflow "${wf.name}": its deliverable task couldn't be made: ${(e as Error).message}`)
      }
    }

    const created = createRun({ workflow: wf, hash: entry.hash, ref: entry.ref, id: runId, projectId: project.id, inputs: req.inputs, cwd, worktree, groupId: group.id, ...(taskId ? { taskId } : {}) }, { now: now(), newId })
    if (!created.ok) return { ok: false, reason: created.problems[0], problems: created.problems }
    if ('person' in req.by) await d.runStore.trust(entry.hash)
    // Before the first node: the run is on disk with that node's id.
    await persistAndRun(created.run, created.effects)
    return { ok: true, run: runs.get(runId)! }
  }

  /** What starting would do, for the form and `patchbay workflows --name`: each step as it will run, so far as known. */
  const preview = (wf: Workflow, inputs: Record<string, unknown>) => {
    // Each input that's given and fits, or its default, even while others are still missing.
    const known: Record<string, unknown> = {}
    for (const i of wf.inputs) {
      const one = checkRunInputs({ ...wf, inputs: [{ ...i, required: false }] }, inputs[i.key] === undefined ? {} : { [i.key]: inputs[i.key] })
      if (one.ok && one.inputs[i.key] !== undefined) known[i.key] = one.inputs[i.key]
    }
    const sample = { id: 'preview', definition: wf, inputs: known, cwd: '<run folder>', attempts: [] } as unknown as WorkflowRun
    return wf.steps.map((s) => {
      const base = { key: s.key, kind: s.kind, title: s.title }
      if (s.kind === 'agent') return { ...base, agent: s.agent, prompt: s.prompt, outputs: s.outputs }
      if (s.kind === 'review') return { ...base, question: s.question }
      const plan = planStep(sample, s)
      return { ...base, runs: plan.ok && plan.argv ? showArgv(plan.argv) : showArgv(s.run), folder: s.folder ?? '.', how: 'no shell', ...(s.taskCheck ? { taskCheck: true } : {}) }
    })
  }

  // Reports from nodes

  const runOfNode = (nodeId: string): WorkflowRun | undefined => {
    for (const run of runs.values()) if (run.attempts.some((a) => a.nodeId === nodeId)) return run
    return undefined
  }

  /**
   * `patchbay job-submit` from a node. Files are copied, with their hash, into Patchbay's own folder, so the next step
   * reads what was submitted even if the file changes later. Only files inside the run's folder, up to a size.
   */
  const submit = async (nodeId: string, outputs: RawOutput[], step?: string): Promise<{ ok: true; run: WorkflowRun } | { ok: false; message: string }> => {
    const run = runOfNode(nodeId)
    const node = d.store.get().nodes.find((n) => n.id === nodeId)
    if (!run || !node) return { ok: false, message: "You aren't running a workflow step, so there's nothing to submit a result for." }
    const attempt = run.attempts.filter((a) => a.nodeId === nodeId).sort((a, b) => b.n - a.n)[0]
    const values: Record<string, OutputValue> = {}
    const into = join(artifactsDir, run.id, attempt.id.replace(/:/g, '_'))
    const seen = new Set<string>()
    for (const o of outputs) {
      if (seen.has(o.key)) return { ok: false, message: `--output ${o.key} is given twice.` }
      seen.add(o.key)
      if ('text' in o) { values[o.key] = { type: 'text', text: o.text }; continue }
      const source = resolve(run.cwd, o.file)
      if (!insideFolder(run.cwd, source)) return { ok: false, message: `${o.file} isn't inside the run's folder ${run.cwd}. Save the file there and submit it again.` }
      let size: number
      try {
        const st = statSync(source)
        if (!st.isFile()) return { ok: false, message: `${source} isn't a file.` }
        size = st.size
      } catch {
        return { ok: false, message: `There's no file ${source}.` }
      }
      if (size > MAX_ARTIFACT_BYTES) return { ok: false, message: `${source} is bigger than ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB.` }
      mkdirSync(into, { recursive: true })
      const kept = join(into, `${o.key}-${basename(source)}`)
      copyFileSync(source, kept)
      values[o.key] = { type: 'file', path: kept, sha256: createHash('sha256').update(readFileSync(kept)).digest('hex'), source }
    }
    let revision: TaskRevision | undefined
    try { revision = await d.revision(run.cwd) } catch { revision = undefined }
    const r = await apply(run.id, { type: 'submitted', nodeId, projectId: node.projectId ?? '', ...(step ? { step } : {}), outputs: values, ...(revision ? { revision } : {}) })
    if (!r.ok) {
      rmSync(into, { recursive: true, force: true })
      return { ok: false, message: r.message }
    }
    return { ok: true, run: r.run }
  }

  // Watching nodes

  const activeNodes = (): Map<string, WorkflowRun> => {
    const m = new Map<string, WorkflowRun>()
    for (const run of runs.values()) {
      for (const a of run.attempts) if (a.nodeId && ['launching', 'running', 'waiting-for-you'].includes(a.state) && currentAttempt(run, a.step)?.id === a.id) m.set(a.nodeId, run)
    }
    return m
  }

  const logOf = (run: WorkflowRun, nodeId: string): OutputValue | undefined => {
    const a = run.attempts.find((x) => x.nodeId === nodeId && x.state !== 'superseded')
    if (!a) return undefined
    const file = join(artifactsDir, run.id, a.id.replace(/:/g, '_'), 'log.txt')
    try {
      return { type: 'file', path: file, sha256: createHash('sha256').update(readFileSync(file)).digest('hex'), source: file }
    } catch {
      return undefined
    }
  }

  let disposed = false
  d.runner.onRun((id, result) => {
    if (disposed) return
    const run = activeNodes().get(id)
    if (!run || result.running) return
    if (result.stoppedByYou) void apply(run.id, { type: 'node-gone', nodeId: id })
    else if (result.exitCode !== null) {
      const log = logOf(run, id)
      const exitCode = result.exitCode
      void apply(run.id, async (): Promise<RunEvent> => {
        let revision: TaskRevision | undefined
        try { revision = await d.revision(run.cwd) } catch { revision = undefined }
        return { type: 'exited', nodeId: id, exitCode, ...(log ? { log } : {}), ...(revision ? { revision } : {}) }
      })
    }
  })

  d.tracker.onChange((id, status) => {
    if (disposed) return
    const run = activeNodes().get(id)
    if (!run) return
    if (status === 'idle') void apply(run.id, { type: 'idle', nodeId: id })
    else if (status === 'working') void apply(run.id, { type: 'busy', nodeId: id })
    else if (status === 'exited' && d.store.get().nodes.find((n) => n.id === id)?.kind === 'claude') void apply(run.id, { type: 'node-gone', nodeId: id })
  })

  const unsubscribe = d.store.subscribe((doc) => {
    const present = new Set(doc.nodes.map((n) => n.id))
    for (const [nodeId, run] of activeNodes()) if (!present.has(nodeId)) void apply(run.id, { type: 'node-gone', nodeId })
  })

  /** Time limits, with time held at a usage limit added back. */
  const tick = (): void => {
    const t = now()
    for (const run of runs.values()) {
      for (const a of run.attempts) {
        if (!a.nodeId || (a.state !== 'running' && a.state !== 'launching')) continue
        if (d.stops?.holding(a.nodeId)) { held.set(a.id, (held.get(a.id) ?? 0) + TICK_MS); continue }
        const due = deadline(run, a)
        if (due !== null && t > due + (held.get(a.id) ?? 0)) void apply(run.id, { type: 'timeout', attemptId: a.id })
      }
    }
  }
  const timer = setInterval(tick, TICK_MS)
  timer.unref?.()

  /**
   * After the host's run results are in (see setupGate.evaluate in index.ts): each live run's nodes are checked, and
   * steps settle by what the host kept. Called once at start-up.
   */
  const recover = async (): Promise<void> => {
    const doc = d.store.get()
    const results = d.runner.runs()
    for (const run of runs.values()) {
      if (run.stopped || run.state === 'succeeded') continue
      const nodes: Record<string, 'running' | 'stopped'> = {}
      const exits: Record<string, number> = {}
      for (const a of run.attempts) {
        if (!a.nodeId) continue
        const node = doc.nodes.find((n) => n.id === a.nodeId)
        if (!node) continue
        const r = results[a.nodeId]
        if (node.kind === 'run') {
          nodes[a.nodeId] = r?.running ? 'running' : 'stopped'
          if (r && !r.running && r.exitCode !== null && !r.stoppedByYou) exits[a.nodeId] = r.exitCode
        } else nodes[a.nodeId] = STARTED.has(d.tracker.get(a.nodeId)) ? 'running' : 'stopped'
      }
      await apply(run.id, { type: 'recovered', nodes, exits })
    }
  }

  const save = async (a: { projectId: string; workflow: unknown; where: 'personal' | 'repository'; overwrite?: boolean; file?: string }) => {
    let dir = personalDir
    if (a.where === 'repository') {
      const { repo } = await repoFor(a.projectId)
      if (!repo) return { ok: false as const, reason: "This project's folder isn't in a git repository, so the workflow can't be saved there." }
      dir = join(repo, REPO_WORKFLOWS)
    }
    // An existing file is only replaced where it lives: in the personal folder or the repository's.
    if (a.file !== undefined && !insideFolder(dir, resolve(a.file))) return { ok: false as const, reason: `${a.file} isn't in the ${a.where} workflows folder.` }
    try {
      return await saveWorkflowFile(dir, a.workflow, { overwrite: !!a.overwrite, ...(a.file ? { file: resolve(a.file) } : {}) })
    } catch (e) {
      return { ok: false as const, reason: (e as Error).message }
    }
  }

  const folderFor = async (projectId: string, where: 'personal' | 'repository'): Promise<string | null> => {
    if (where === 'personal') return personalDir
    const { repo } = await repoFor(projectId)
    return repo ? join(repo, REPO_WORKFLOWS) : null
  }

  return {
    list,
    start,
    preview,
    submit,
    recover,
    save,
    folderFor,
    /** The person's actions on a run: decide, retry, stop, remind, mark done. */
    act: (runId: string, event: Extract<RunEvent, { type: 'decide' | 'retry' | 'stop' | 'remind' | 'mark-done' }>) => apply(runId, event),
    runs: (projectId?: string): WorkflowRun[] => [...runs.values()].filter((r) => !projectId || r.projectId === projectId).sort((a, b) => b.startedAt - a.startedAt),
    get: (runId: string): WorkflowRun | undefined => runs.get(runId),
    runOfNode,
    unavailable: loaded.unavailable,
    stepOutputs,
    async flush(): Promise<void> {
      while (queues.size) await Promise.all([...queues.values()])
      await d.runStore.flush()
    },
    dispose(): void {
      disposed = true
      clearInterval(timer)
      unsubscribe()
    },
    /** For tests: the time-limit check, without waiting. */
    tick
  }
}
