import type { CanvasDoc, CanvasNode, ClaudeNode, TerminalNode, TriggerNode } from '../../shared/model'
import { nextRun, scheduleError } from './schedule'

/** A prompt is typed into a session, so it has to fit in one sensibly. */
export const MAX_TRIGGER_PROMPT = 20000

export type TriggerContent = Pick<TriggerNode, 'schedule' | 'prompt' | 'targetId'>

/**
 * The exact content someone agrees to by arming. Comparing this string is how arming stays tied to what was shown: any
 * change to the schedule, prompt or target makes the trigger stop matching what was agreed, however that change was made.
 */
export function canonicalSpec({ schedule, prompt, targetId }: TriggerContent): string {
  const when = schedule.type === 'cron' ? [schedule.type, schedule.expr.trim().replace(/\s+/g, ' ')] : schedule.type === 'interval' ? [schedule.type, schedule.everyMs] : [schedule.type, schedule.at]
  return JSON.stringify([when, prompt, targetId])
}

export function isArmed(node: Pick<TriggerNode, 'armedSpec' | 'schedule' | 'prompt' | 'targetId'>): boolean {
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
export function armRefusal(node: TriggerNode, doc: Pick<CanvasDoc, 'nodes'>, now: number): string | null {
  const problem = scheduleError(node.schedule)
  if (problem) return problem
  if (!node.prompt.trim()) return 'Write the prompt it should send.'
  if (node.prompt.length > MAX_TRIGGER_PROMPT) return `The prompt is too long (limit ${MAX_TRIGGER_PROMPT} characters).`
  if (!node.targetId) return 'Choose what it sends to: link it to a terminal or a Claude session, or pick one.'
  const target = doc.nodes.find((n) => n.id === node.targetId)
  if (!isTriggerTarget(target)) return 'What it sends to is gone. Choose a terminal or a Claude session.'
  if (target.projectId !== node.projectId) return 'What it sends to is in another project.'
  if (nextRun(node.schedule, now, now) === null) return node.schedule.type === 'once' ? 'That time has passed. Choose a later one.' : 'That schedule has no more runs.'
  return null
}
