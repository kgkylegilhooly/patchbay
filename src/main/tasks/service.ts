import { randomUUID } from 'node:crypto'
import { isAbsolute, join } from 'node:path'
import { readdirSync, rmSync, statSync } from 'node:fs'
import type { CanvasStore } from '../../shared/contract'
import { isSessionNode } from '../../shared/model'
import { emptyTasks, taskReadiness, workingState, type Task, type TaskAuthor, type TaskCheck, type TaskRecords, type TaskRevision, type TaskState, type TaskSubmission, type TaskVerification, type TaskView } from '../../shared/task'
import { executeVerification, prepareOutput, readRevision, stopVerifications } from './verification'

export interface CreateTask { brief: string; acceptanceCriteria: string[]; assignedSessionIds: string[]; cwd: string; requiredChecks: TaskCheck[]; dependsOn: string[]; createdBy?: TaskAuthor }

/** How long a folder's git identity is reused, so a board full of cards doesn't run git for each one. */
const REVISION_TTL_MS = 3000
export type TaskService = ReturnType<typeof createTaskService>
export function createTaskService(store: CanvasStore, dataDir: string, persist: () => Promise<void> = async () => {}, revision = readRevision, execute = executeVerification) {
  const records = (projectId: string): TaskRecords => {
    const project = store.get().projects.find((p) => p.id === projectId)
    if (!project) throw new Error('Project not found')
    return project.tasks ?? emptyTasks()
  }
  const save = (projectId: string, data: TaskRecords): void => store.dispatch({ op: 'setTasks', projectId, tasks: data })
  const find = (projectId: string, id: string): Task => {
    const task = records(projectId).tasks.find((t) => t.id === id)
    if (!task) throw new Error('Task not found in this project')
    return task
  }
  const replace = (projectId: string, task: Task): void => {
    const current = records(projectId)
    save(projectId, { ...current, tasks: current.tasks.map((t) => t.id === task.id ? task : t) })
  }
  /** Identity per folder, reused briefly. Anything that changes the tree through the service clears it. */
  const cache = new Map<string, { at: number; value: Promise<TaskRevision> }>()
  const revisionOf = (cwd: string): Promise<TaskRevision> => {
    const hit = cache.get(cwd)
    if (hit && Date.now() - hit.at < REVISION_TTL_MS) return hit.value
    const value = revision(cwd)
    cache.set(cwd, { at: Date.now(), value })
    return value
  }
  const fresh = (): void => cache.clear()
  /** The folders a task's readiness reads: its own, its checks', and those of the tasks it depends on. */
  const foldersFor = (data: TaskRecords, task: Task, seen = new Set<string>()): string[] => {
    if (seen.has(task.id)) return []
    seen.add(task.id)
    const upstream = task.dependsOn.flatMap((id) => {
      const t = data.tasks.find((other) => other.id === id)
      return t ? foldersFor(data, t, seen) : []
    })
    return [task.cwd, ...task.requiredChecks.map((c) => c.cwd), ...upstream]
  }
  const revisions = async (projectId: string, tasks?: Task[]): Promise<Record<string, TaskRevision>> => {
    const data = records(projectId)
    const dirs = [...new Set((tasks ?? data.tasks).flatMap((t) => foldersFor(data, t)))]
    return Object.fromEntries(await Promise.all(dirs.map(async (cwd) => [cwd, await revisionOf(cwd)])))
  }
  const readiness = (data: TaskRecords, task: Task, snapshots: Record<string, TaskRevision>) => {
    const result = taskReadiness(data, task, snapshots)
    const seen = new Set<string>()
    const checkOutput = (t: Task): void => {
      if (seen.has(t.id)) return
      seen.add(t.id)
      for (const check of t.requiredChecks) {
        const attempt = data.attempts.filter((a): a is TaskVerification => a.taskId === t.id && a.kind === 'command' && !a.comparison && a.checkId === check.id).at(-1)
        if (attempt?.status !== 'passed') continue
        try { if (!statSync(attempt.outputRef).isFile()) throw new Error('not a file') }
        catch { result.reasons.push(`${check.id}: saved command output is missing`) }
      }
      for (const id of t.dependsOn) {
        const upstream = data.tasks.find((other) => other.id === id)
        if (upstream) checkOutput(upstream)
      }
    }
    checkOutput(task)
    return { ready: result.reasons.length === 0, reasons: result.reasons, warnings: result.warnings }
  }
  const show = async (projectId: string, id: string): Promise<TaskView> => {
    const snapshots = await revisions(projectId, [find(projectId, id)])
    const task = find(projectId, id)
    const data = records(projectId)
    return { task, attempts: data.attempts.filter((a) => a.taskId === id), readiness: readiness(data, task, snapshots) }
  }
  const mutable = (task: Task): void => { if (task.state === 'cancelled' || task.state === 'accepted') throw new Error('Reopen accepted work with task state running; cancelled tasks are final') }
  const directory = (cwd: string): void => { if (!isAbsolute(cwd) || !statSync(cwd).isDirectory()) throw new Error('Task cwd must be an existing absolute directory') }
  return {
    show,
    list: (projectId: string) => records(projectId).tasks,
    /** Every task with its attempts and current readiness, from one round of git per folder. For a review inbox. */
    async views(projectId: string): Promise<TaskView[]> {
      const data = records(projectId)
      const snapshots = await revisions(projectId)
      return data.tasks.map((task) => ({ task, attempts: data.attempts.filter((a) => a.taskId === task.id), readiness: readiness(data, task, snapshots) }))
    },
    /** Removes saved output of attempts no project records any more. Returns how many files went. */
    pruneOutput(): number {
      const dir = join(dataDir, 'task-output')
      const kept = new Set(store.get().projects.flatMap((p) => (p.tasks?.attempts ?? []).flatMap((a) => (a.kind === 'command' ? [a.outputRef.toLowerCase()] : []))))
      let removed = 0
      let names: string[] = []
      try { names = readdirSync(dir) } catch { return 0 }
      for (const name of names) {
        const file = join(dir, name)
        if (kept.has(file.toLowerCase())) continue
        try { rmSync(file, { force: true }); removed++ } catch { /* In use: next time. */ }
      }
      return removed
    },
    /** Ends verification commands still running, as the app quits, so none outlives the record it reports to. */
    stopAll: () => stopVerifications(),
    async create(projectId: string, input: CreateTask): Promise<Task> {
      if (!input.brief.trim() || !input.acceptanceCriteria.length || input.acceptanceCriteria.some((c) => !c.trim())) throw new Error('A brief and acceptance criteria are required')
      directory(input.cwd)
      if (new Set(input.requiredChecks.map((c) => c.id)).size !== input.requiredChecks.length) throw new Error('Check IDs must be unique')
      for (const c of input.requiredChecks) { if (!c.id.trim() || !c.command.trim()) throw new Error('Checks need an id and command'); directory(c.cwd) }
      for (const id of input.assignedSessionIds) {
        const node = store.get().nodes.find((n) => n.id === id && n.projectId === projectId)
        if (!isSessionNode(node)) throw new Error(`Assigned session ${id} is not in this project`)
      }
      for (const id of input.dependsOn) find(projectId, id)
      // Dependencies point only to existing records; there is no dependency-edit API, so cycles cannot be created.
      const task: Task = { ...input, id: randomUUID(), projectId, state: 'planned', createdAt: Date.now(), updatedAt: Date.now(), acceptances: [] }
      if (!input.createdBy) delete task.createdBy
      const data = records(projectId)
      save(projectId, { ...data, tasks: [...data.tasks, task] })
      await persist()
      return task
    },
    async state(projectId: string, id: string, state: TaskState): Promise<Task> {
      const task = workingState(find(projectId, id), state, Date.now())
      replace(projectId, task)
      await persist()
      return task
    },
    async submit(projectId: string, id: string, sessionId: string, summary: string): Promise<TaskView> {
      if (!summary.trim()) throw new Error('A result summary is required')
      const before = find(projectId, id)
      mutable(before)
      fresh()
      const snapshot = await revisionOf(before.cwd)
      const task = find(projectId, id)
      mutable(task)
      const now = Date.now()
      const submission: TaskSubmission = { id: randomUUID(), taskId: id, sessionId, kind: 'agent-report', summary, startedAt: now, endedAt: now, revision: snapshot }
      const data = records(projectId)
      const submitted = { ...task, submissionId: submission.id, updatedAt: now, state: 'ready-for-review' as const }
      save(projectId, { ...data, tasks: data.tasks.map((t) => t.id === id ? submitted : t), attempts: [...data.attempts, submission] })
      const view = await show(projectId, id)
      if (!view.readiness.ready && find(projectId, id).submissionId === submission.id) replace(projectId, { ...find(projectId, id), state: 'blocked' })
      await persist()
      return show(projectId, id)
    },
    /** Runs one of the task's declared checks, exactly as declared. No other command can be run through a task. */
    async verify(projectId: string, id: string, sessionId: string, checkId: string): Promise<TaskVerification> {
      const declared = find(projectId, id).requiredChecks.find((c) => c.id === checkId)
      if (!declared) throw new Error(`Task has no check "${checkId}". Only the checks declared when the task was made can run`)
      const check: TaskCheck = { ...declared }
      mutable(find(projectId, id))
      directory(check.cwd)
      const attemptId = randomUUID()
      fresh()
      const snapshot = await revisionOf(check.cwd)
      const outputRef = await prepareOutput(join(dataDir, 'task-output'), attemptId)
      const task = find(projectId, id)
      mutable(task)
      const expected = task.requiredChecks.find((c) => c.id === check.id)
      if (expected && (expected.command !== check.command || expected.cwd !== check.cwd)) throw new Error('Required check command and cwd must match its definition')
      const attempt: TaskVerification = { id: attemptId, taskId: id, sessionId, kind: 'command', checkId: check.id, command: check.command, cwd: check.cwd, startedAt: Date.now(), endedAt: null, exitCode: null, status: 'running', outputRef, revision: snapshot }
      const data = records(projectId)
      save(projectId, { ...data, tasks: data.tasks.map((t) => t.id === id && t.submissionId ? { ...t, state: 'blocked' } : t), attempts: [...data.attempts, attempt] })
      await persist() // A running record reaches disk before any command starts.
      void (async () => {
        let finished: TaskVerification
        try { finished = await execute(attempt) }
        catch (e) { finished = { ...attempt, status: 'failed', endedAt: Date.now(), error: String(e) } }
        finally { fresh() }
        // Projects may be removed while a command runs. Never resurrect them.
        if (!store.get().projects.some((p) => p.id === projectId)) return
        const latest = records(projectId)
        save(projectId, { ...latest, attempts: latest.attempts.map((a) => a.id === attemptId ? finished : a) })
        const view = await show(projectId, id)
        const current = find(projectId, id)
        if (current.submissionId && current.state !== 'cancelled' && current.state !== 'accepted') replace(projectId, { ...current, state: view.readiness.ready ? 'ready-for-review' : 'blocked', updatedAt: Date.now() })
        await persist()
      })().catch((e: unknown) => console.error('Task verification could not be saved:', e))
      return attempt
    },
    /** Registered only on the trusted application UI IPC channel, never in the agent router. */
    async accept(projectId: string, id: string, submissionId: string): Promise<Task> {
      // Accepting reads the tree as it is now, never a cached identity.
      fresh()
      const snapshots = await revisions(projectId, [find(projectId, id)])
      const task = find(projectId, id)
      if (!submissionId || task.submissionId !== submissionId || !['ready-for-review', 'blocked'].includes(task.state)) throw new Error('Submission changed; review it again')
      const ready = readiness(records(projectId), task, snapshots)
      if (!ready.ready) throw new Error(ready.reasons.join('; '))
      const now = Date.now()
      const accepted: Task = { ...task, state: 'accepted', updatedAt: now, acceptances: [...task.acceptances, { submissionId, at: now, by: 'human', revision: snapshots[task.cwd] }] }
      replace(projectId, accepted)
      await persist()
      return accepted
    }
  }
}
