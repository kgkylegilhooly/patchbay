import type { CanvasDoc, CanvasNode, ClaudeNode, TerminalNode, TriggerNode, TriggerSchedule } from '../../shared/model'
import { eventRefusal, isEventSchedule, limitsOf, loopRefusal } from './events'
import { nextRun, scheduleError } from './schedule'

/** A prompt is typed into a session, so it has to fit in one sensibly. */
export const MAX_TRIGGER_PROMPT = 20000

export type TriggerContent = Pick<TriggerNode, 'schedule' | 'prompt' | 'targetId' | 'preflight' | 'limits'>

function whenOf(s: TriggerSchedule): unknown[] {
  switch (s.type) {
    case 'cron':
      return [s.type, s.expr.trim().replace(/\s+/g, ' ')]
    case 'interval':
      return [s.type, s.everyMs]
    case 'once':
      return [s.type, s.at]
    case 'agent':
      return [s.type, s.nodeId, s.on]
    case 'run':
      return [s.type, s.nodeId, s.failedOnly]
    case 'files':
      return [s.type, s.folder.trim(), s.glob.trim(), s.quietMs]
  }
}

/**
 * The exact content someone agrees to by arming. Comparing this string is how arming stays tied to what was shown: any
 * change to the schedule, prompt or target makes the trigger stop matching what was agreed, however that change was made.
 * A check before firing and an event's limits are part of it too. They're added only when there are any, so a trigger
 * saved before they existed keeps the same string and stays armed.
 */
export function canonicalSpec(node: TriggerContent): string {
  const { schedule, prompt, targetId, preflight } = node
  const limits = limitsOf(node)
  const extras = { ...(preflight && { preflight: [preflight.argv, preflight.cwd.trim()] }), ...(limits && { limits: [limits.gapMs, limits.perHour] }) }
  return JSON.stringify(Object.keys(extras).length ? [whenOf(schedule), prompt, targetId, extras] : [whenOf(schedule), prompt, targetId])
}

export function isArmed(node: Pick<TriggerNode, 'armedSpec' | 'schedule' | 'prompt' | 'targetId' | 'preflight' | 'limits'>): boolean {
  return node.armedSpec !== null && node.armedSpec === canonicalSpec(node)
}

export type TriggerTarget = TerminalNode | ClaudeNode

export function isTriggerTarget(n: CanvasNode | undefined): n is TriggerTarget {
  return n?.kind === 'terminal' || n?.kind === 'claude'
}

/** What a trigger may send to: a terminal or Claude session in its own project. */
export function targetsFor(doc: Pick<CanvasDoc, 'nodes'>, trigger: Pick<TriggerNode, 'projectId'>): TriggerTarget[] {
  return doc.nodes.filter((n): n is TriggerTarget => isTriggerTarget(n) && n.projectId === trigger.projectId)
}

/** Why this trigger can't be armed, or null if it can. */
export function armRefusal(node: TriggerNode, doc: Pick<CanvasDoc, 'nodes'> & Partial<Pick<CanvasDoc, 'projects'>>, now: number): string | null {
  const problem = scheduleError(node.schedule)
  if (problem) return problem
  if (!node.prompt.trim()) return 'Write the prompt it should send.'
  if (node.prompt.length > MAX_TRIGGER_PROMPT) return `The prompt is too long (limit ${MAX_TRIGGER_PROMPT} characters).`
  if (!node.targetId) return 'Choose what it sends to: link it to a terminal or a Claude session, or pick one.'
  const target = doc.nodes.find((n) => n.id === node.targetId)
  if (!isTriggerTarget(target)) return 'What it sends to is gone. Choose a terminal or a Claude session.'
  if (target.projectId !== node.projectId) return 'What it sends to is in another project.'
  const event = eventRefusal(node, { nodes: doc.nodes, projects: doc.projects ?? [] })
  if (event) return event
  if (isEventSchedule(node.schedule)) {
    const armed = doc.nodes.filter((n): n is TriggerNode => n.kind === 'trigger' && n.id !== node.id && isArmed(n))
    return loopRefusal(node, armed, doc.nodes)
  }
  if (nextRun(node.schedule, now, now) === null) return node.schedule.type === 'once' ? 'That time has passed. Choose a later one.' : 'That schedule has no more runs.'
  return null
}
