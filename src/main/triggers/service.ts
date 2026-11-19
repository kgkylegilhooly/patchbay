import { randomUUID } from 'node:crypto'
import { armRefusal, canonicalSpec, isArmed, isTriggerTarget } from '../../core/trigger/arming'
import { nextRun, slotsUpTo } from '../../core/trigger/schedule'
import type { CanvasStore, SessionHost } from '../../shared/contract'
import { agentOf, DISARMED, type TriggerNode, type TriggerRun, type TriggerState } from '../../shared/model'
import { plainText, type SendQueue } from '../control/sendQueue'
import type { StatusTracker } from '../sessions/statusTracker'
import { agentOffNow } from '../agentsAllowed'

/** Later than this, a slot counts as missed rather than run late, as after the PC wakes from sleep. */
export const LATE_LIMIT_MS = 60_000
/** The longest it sleeps between looks, so a changed clock is noticed. */
const MAX_WAIT_MS = 30_000
export const RUN_LIMIT = 20

export type TriggerResult = { ok: true; run: TriggerRun } | { ok: false; reason: string }

export interface TriggerService {
  /** Settles what happened while the app was closed, then starts the clock. Call once sessions are back. */
  start(): void
  stop(): void
  /** `shown` is the spec the person was shown and agreed to. If the trigger has changed since, it isn't armed. */
  arm(id: string, shown: string): { ok: true } | { ok: false; reason: string }
  disarm(id: string): void
  /** Fires now, with what's saved on the node. Only an armed trigger fires. */
  runNow(id: string): TriggerResult
  /** Looks for due slots now. The timer calls it, and tests do. */
  tick(): void
}

const when = (at: number): string => new Date(at).toLocaleString()

/**
 * Runs triggers from the main process. It never starts a session: a target that isn't running is a missed run. A
 * Claude target gets the prompt only when idle, through the same queue as `patchbay send`. Nothing catches up: slots
 * that passed while the app was closed, or while the PC slept, are recorded as missed and skipped.
 */
export function createTriggerService({
  store,
  tracker,
  host,
  queue,
  now = Date.now
}: {
  store: CanvasStore
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  host: Pick<SessionHost, 'isRunning'>
  queue: SendQueue
  now?: () => number
}): TriggerService {
  /** What each trigger has waiting in the queue: one at most, so a busy target doesn't collect a pile. */
  const pending = new Map<string, { runId: string; targetId: string; spec: string; item: object }>()
  let timer: NodeJS.Timeout | null = null
  let running = false

  const triggers = (): TriggerNode[] => store.get().nodes.filter((n): n is TriggerNode => n.kind === 'trigger')
  const find = (id: string): TriggerNode | undefined => triggers().find((n) => n.id === id)
  const setState = (id: string, state: Partial<TriggerState>): void => store.dispatch({ op: 'setTriggerState', id, state })

  const record = (id: string, run: TriggerRun): void => {
    const node = find(id)
    if (node) setState(id, { runs: [run, ...node.runs].slice(0, RUN_LIMIT) })
  }

  const updateRun = (id: string, runId: string, patch: Partial<TriggerRun>): void => {
    const node = find(id)
    if (node?.runs.some((r) => r.id === runId)) setState(id, { runs: node.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)) })
  }

  /** Whether the trigger still says what was agreed when this was sent. */
  const stillWanted = (id: string, spec: string): boolean => {
    const node = find(id)
    return !!node && node.armedSpec === spec && isArmed(node)
  }

  /** A one-off whose slot has gone is done, once nothing it sent is still waiting. */
  const finishIfSpent = (id: string): void => {
    const node = find(id)
    if (node && node.armedSpec !== null && node.nextAt === null && !pending.has(id)) setState(id, { ...DISARMED })
  }

  const settled = (id: string, runId: string, patch: Partial<TriggerRun>): void => {
    if (pending.get(id)?.runId === runId) pending.delete(id)
    updateRun(id, runId, patch)
    finishIfSpent(id)
  }

  const fire = (node: TriggerNode, source: TriggerRun['source'], at: number): TriggerRun => {
    const run = (outcome: TriggerRun['outcome'], detail?: string): TriggerRun => ({ id: randomUUID(), at, source, outcome, ...(detail && { detail }) })
    const target = store.get().nodes.find((n) => n.id === node.targetId)
    const result = ((): TriggerRun => {
      if (!isTriggerTarget(target)) return run('missed', 'What it sends to is gone.')
      // Settings > Agents: nothing goes to an agent turned off, even one still running.
      const off = target.kind === 'claude' ? agentOffNow(agentOf(target)) : null
      if (off) return run('failed', host.isRunning(target.id) ? `${off} "${target.title}" is still running, but nothing was sent to it.` : off)
      if (!host.isRunning(target.id) || (target.kind === 'claude' && tracker.get(target.id) === 'exited')) {
        return run('missed', `"${target.title}" wasn't running. A trigger never starts a session.`)
      }
      const text = plainText(node.prompt)
      if (target.kind === 'terminal') {
        try {
          queue.type(target.id, text)
          return run('delivered', `Typed into "${target.title}".`)
        } catch (e) {
          return run('failed', `Couldn't type into "${target.title}": ${(e as Error).message}`)
        }
      }
      if (pending.has(node.id)) return run('missed', `The last prompt is still waiting for "${target.title}" to be idle.`)
      const spec = node.armedSpec!
      const first = run('queued', `Waiting for "${target.title}" to be idle.`)
      const item = {
        text,
        stillWanted: () => stillWanted(node.id, spec),
        onDelivered: () => settled(node.id, first.id, { outcome: 'delivered', detail: `Sent to "${target.title}" once it was idle, at ${when(now())}.` }),
        onDropped: () => settled(node.id, first.id, { outcome: 'missed', detail: 'Dropped before delivery: the trigger was disarmed or changed, or its target went.' })
      }
      // Recorded first, so a delivery reported later has a run to update.
      pending.set(node.id, { runId: first.id, targetId: target.id, spec, item })
      record(node.id, first)
      if (queue.add(target.id, item) === 'queued') return first
      pending.delete(node.id)
      const delivered = { outcome: 'delivered' as const, detail: `Sent to "${target.title}", which was idle.` }
      updateRun(node.id, first.id, delivered)
      return { ...first, ...delivered }
    })()
    if (!find(node.id)?.runs.some((r) => r.id === result.id)) record(node.id, result)
    return result
  }

  /** Moves past every slot up to now. A one-off with none left keeps its agreement until anything it sent settles. */
  const advance = (node: TriggerNode, t: number): void => {
    setState(node.id, { nextAt: nextRun(node.schedule, t, node.armedAt ?? t) })
    finishIfSpent(node.id)
  }

  const missedSlots = (node: TriggerNode, t: number, why: string): void => {
    const { count, last, capped } = slotsUpTo(node.schedule, node.nextAt!, t, node.armedAt ?? node.nextAt!)
    const runs = count === 1 ? `the run due ${when(last)}` : `${capped ? `more than ${count}` : count} runs, the last due ${when(last)}`
    record(node.id, { id: randomUUID(), at: last, source: 'schedule', outcome: 'missed', detail: `Skipped ${runs}: ${why}` })
    advance(node, t)
  }

  const plan = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    if (!running) return
    const due = triggers().filter(isArmed).map((n) => n.nextAt).filter((at): at is number => at !== null)
    const wait = due.length ? Math.max(0, Math.min(MAX_WAIT_MS, Math.min(...due) - now())) : MAX_WAIT_MS
    timer = setTimeout(tick, wait)
    timer.unref?.()
  }

  const tick = (): void => {
    const t = now()
    for (const node of triggers()) {
      if (!isArmed(node) || node.nextAt === null || node.nextAt > t) continue
      if (t - node.nextAt > LATE_LIMIT_MS) missedSlots(node, t, 'Patchbay couldn\'t run it then, as when the PC is asleep.')
      else {
        fire(node, 'schedule', node.nextAt)
        const after = find(node.id)
        if (after) advance(after, t)
      }
    }
    plan()
  }

  /** Anything that no longer matches what was agreed gives up what it had waiting. */
  const dropStale = (): void => {
    for (const [id, p] of pending) {
      if (stillWanted(id, p.spec)) continue
      queue.drop((_target, item) => item === p.item)
      // Dropped already if the queue had it; this covers an item the queue had already let go.
      if (pending.get(id) === p) settled(id, p.runId, { outcome: 'missed', detail: 'Dropped before delivery: the trigger was disarmed or changed.' })
    }
  }

  store.subscribe(() => {
    dropStale()
    plan()
  })
  tracker.onChange((targetId, status) => {
    if (status !== 'exited') return
    for (const [id, p] of pending) {
      if (p.targetId !== targetId) continue
      queue.drop((_t, item) => item === p.item)
      if (pending.get(id) === p) settled(id, p.runId, { outcome: 'missed', detail: 'Its target ended before it was idle.' })
    }
  })

  return {
    start() {
      const t = now()
      for (const node of triggers()) {
        const runs = node.runs.map((r) => (r.outcome === 'queued' ? { ...r, outcome: 'missed' as const, detail: 'The app closed before it could be delivered.' } : r))
        if (runs.some((r, i) => r !== node.runs[i])) setState(node.id, { runs })
        const current = find(node.id)!
        if (current.armedSpec !== null && !isArmed(current)) setState(node.id, { ...DISARMED })
        else if (isArmed(current)) {
          if (current.nextAt === null) advance(current, t)
          else if (current.nextAt <= t) missedSlots(current, t, 'the app was closed. Nothing runs while it is.')
        }
      }
      running = true
      plan()
    },
    stop() {
      running = false
      plan()
    },
    arm(id, shown) {
      const node = find(id)
      if (!node) return { ok: false, reason: 'That trigger is gone.' }
      if (shown !== canonicalSpec(node)) return { ok: false, reason: 'The trigger changed after it was shown to you. Look again, then arm it.' }
      const t = now()
      const refusal = armRefusal(node, store.get(), t)
      if (refusal) return { ok: false, reason: refusal }
      setState(id, { armedSpec: shown, armedAt: t, nextAt: nextRun(node.schedule, t, t) })
      return { ok: true }
    },
    disarm(id) {
      if (find(id)) setState(id, { ...DISARMED })
    },
    runNow(id) {
      const node = find(id)
      if (!node) return { ok: false, reason: 'That trigger is gone.' }
      if (!isArmed(node)) return { ok: false, reason: 'Arm it first. Nothing fires until it is armed.' }
      return { ok: true, run: fire(node, 'manual', now()) }
    },
    tick
  }
}
