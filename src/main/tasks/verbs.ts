import type { CanvasNode } from '../../shared/model'
import type { TaskCheck, TaskState } from '../../shared/task'
import { RpcRefusal } from '../control/server'
import type { TaskService } from './service'

export async function taskVerb(tasks: TaskService, caller: CanvasNode, verb: string, args: Record<string, unknown>): Promise<unknown> {
  const text = (key: string, fallback?: string): string => {
    const v = args[key] ?? fallback
    if (typeof v !== 'string' || !v.trim()) throw new Error(`--${key} is required`)
    return v
  }
  const list = (key: string): string[] => {
    const v = args[key] ?? []
    if (!Array.isArray(v) || !v.every((s) => typeof s === 'string' && !!s.trim())) throw new Error(`--${key} must be a list`)
    return v
  }
  try {
    const project = caller.projectId
    if (!project) throw new Error('Caller has no project')
    if (verb === 'task-list') return tasks.list(project)
    if (verb === 'task-create') {
      const cwd = text('cwd', 'cwd' in caller ? caller.cwd : undefined)
      let checks: TaskCheck[] = []
      if (args.checks !== undefined) {
        const parsed: unknown = JSON.parse(text('checks'))
        if (!Array.isArray(parsed) || !parsed.every((c) => c && typeof c.id === 'string' && typeof c.command === 'string' && (c.cwd === undefined || typeof c.cwd === 'string'))) throw new Error('--checks must be JSON [{id,command,cwd?}]')
        checks = parsed.map((c) => ({ id: c.id, command: c.command, cwd: c.cwd ?? cwd }))
      }
      return await tasks.create(project, { brief: text('brief'), acceptanceCriteria: list('criteria'), assignedSessionIds: args.sessions === undefined ? [caller.id] : list('sessions'), cwd, requiredChecks: checks, dependsOn: list('dependsOn') })
    }
    const id = text('task')
    if (verb === 'task-show') return await tasks.show(project, id)
    if (verb === 'task-submit') return await tasks.submit(project, id, caller.id, text('summary'))
    if (verb === 'task-state') return await tasks.state(project, id, text('state') as TaskState)
    if (verb === 'task-verify') {
      const task = tasks.list(project).find((t) => t.id === id)
      if (!task) throw new Error('Task not found in this project')
      const checkId = text('check')
      const check = task.requiredChecks.find((c) => c.id === checkId)
      return await tasks.verify(project, id, caller.id, { id: checkId, command: text('command', check?.command), cwd: text('cwd', check?.cwd ?? task.cwd) })
    }
    throw new Error('Unknown task verb. Agents can submit; acceptance is a human UI action only')
  } catch (e) {
    throw new RpcRefusal((e as Error).message)
  }
}
