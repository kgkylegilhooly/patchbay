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
    if (verb === 'task-list') return args.readiness === true ? await tasks.views(project) : tasks.list(project)
    if (verb === 'task-create') {
      const cwd = text('cwd', 'cwd' in caller ? caller.cwd : undefined)
      let checks: TaskCheck[] = []
      if (args.checks !== undefined) {
        const parsed: unknown = JSON.parse(text('checks'))
        if (!Array.isArray(parsed) || !parsed.every((c) => c && typeof c.id === 'string' && typeof c.command === 'string' && (c.cwd === undefined || typeof c.cwd === 'string'))) throw new Error('--checks must be JSON [{id,command,cwd?}]')
        checks = parsed.map((c) => ({ id: c.id, command: c.command, cwd: c.cwd ?? cwd }))
      }
      return await tasks.create(project, { brief: text('brief'), acceptanceCriteria: list('criteria'), assignedSessionIds: args.sessions === undefined ? [caller.id] : list('sessions'), cwd, requiredChecks: checks, dependsOn: list('dependsOn'), createdBy: { kind: 'agent', sessionId: caller.id } })
    }
    const id = text('task')
    if (verb === 'task-show') return await tasks.show(project, id)
    if (verb === 'task-submit') return await tasks.submit(project, id, caller.id, text('summary'))
    if (verb === 'task-state') return await tasks.state(project, id, text('state') as TaskState)
    if (verb === 'task-verify') {
      // A check runs exactly as declared when the task was made, in Patchbay, outside the agent's own sandbox. So no
      // other command or folder can be given here: what the person sees declared is all that ever runs.
      if (args.command !== undefined || args.cwd !== undefined) throw new Error('task verify runs a declared check as it was declared; --command and --cwd are not taken. Declare checks with task create --checks')
      return await tasks.verify(project, id, caller.id, text('check'))
    }
    throw new Error('Unknown task verb. Agents can submit; acceptance is a human UI action only')
  } catch (e) {
    throw new RpcRefusal((e as Error).message)
  }
}
