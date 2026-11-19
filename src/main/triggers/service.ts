import { randomUUID } from 'node:crypto'
import { armRefusal, canonicalSpec, isArmed, isTriggerTarget } from '../../core/trigger/arming'
import { describeEventHappened, describeSeconds, eventVars, expandPrompt, isEventSchedule, limitsOf, outputTail, type TriggerEvent } from '../../core/trigger/events'
import { nextRun, slotsUpTo } from '../../core/trigger/schedule'
import type { RunResult as ProgramResult } from '../../core/git/run'
import type { CanvasStore, RunResult, SessionHost } from '../../shared/contract'
import { agentOf, DISARMED, type AgentStatus, type TriggerNode, type TriggerRun, type TriggerState } from '../../shared/model'
import { plainText, type SendQueue } from '../control/sendQueue'
import type { StatusTracker } from '../sessions/statusTracker'
import { agentOffNow } from '../agentsAllowed'
import { createFileBatcher, type FileBatch, type WatchFolder } from './fileWatch'

/** Later than this, a slot counts as missed rather than run late, as after the PC wakes from sleep. */
export const LATE_LIMIT_MS = 60_000
/** The longest it sleeps between looks, so a changed clock is noticed. */
const MAX_WAIT_MS = 30_000
export const RUN_LIMIT = 20
const HOUR_MS = 3_600_000
/** A prompt that hasn't started a turn by then isn't going to. */
export const OWN_TURN_START_MS = 60_000
/** After typing into a terminal, changes count as its own for at least this long, and while it keeps printing. */
export const TERMINAL_RUN_MIN_MS = 30_000
/** ...but no longer than this, so a terminal that never stops printing, such as a dev server, can't silence it. */
export const TERMINAL_RUN_MAX_MS = 10 * 60_000

export type TriggerResult = { ok: true; run: TriggerRun } | { ok: false; reason: string }

/** Runs a check's argument list in a folder, without a shell. */
export type RunPreflight = (argv: string[], cwd: string) => Promise<ProgramResult>

export interface TriggerService {
  /** Settles what happened while the app was closed, then starts the clock. Call once sessions are back. */
  start(): void
  stop(): void
  /** `shown` is the spec the person was shown and agreed to. If the trigger has changed since, it isn't armed. */
  arm(id: string, shown: string): { ok: true } | { ok: false; reason: string }
  disarm(id: string): void
  /** Fires now, with what's saved on the node. Only an armed trigger fires. It's the person asking, so no check or limit applies. */
  runNow(id: string): TriggerResult
  /** Looks for due slots now. The timer calls it, and tests do. */
  tick(): void
}

const when = (at: number): string => new Date(at).toLocaleString()

/** A turn the trigger's own prompt started, in a session the trigger also watches. What happens in it doesn't fire it. */
interface OwnTurn {
  targetId: string
  /**
   * When the prompt was delivered: typed, which for a busy Claude target is when the queue let it go, not when it
   * fired. A turn whose `working` arrives more than OWN_TURN_START_MS later (a badly delayed hook) is no longer
   * treated as its own, so its file changes can fire the trigger once; the limits still hold it.
   */
  from: number
  started: boolean
  endedAt: number | null
  /** A terminal has no turns: what it runs counts as the trigger's own while it keeps printing, plus a quiet time. */
  terminal?: { quietMs: number; lastOutput: number }
}

/**
 * Runs triggers from the main process. It never starts a session: a target that isn't running is a missed run. A
 * Claude target gets the prompt only when idle, through the same queue as `patchbay send`. Nothing catches up: slots
 * that passed while the app was closed, or while the PC slept, are recorded as missed and skipped, and events that
 * happened while it was closed fire nothing.
 *
 * Event kinds (see src/core/trigger/events.ts) pass a gate before firing: not during a turn their own prompt started,
 * not inside the cool-down, not past the hourly cap, and not while their check is still running. A skip is recorded.
 */
export function createTriggerService({
  store,
  tracker,
  host,
  queue,
  runs: runEvents,
  preflight,
  watch,
  now = Date.now
}: {
  store: CanvasStore
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  /** `onOutput` tells when a terminal it typed into has gone quiet. */
  host: Pick<SessionHost, 'isRunning'> & Partial<Pick<SessionHost, 'onOutput'>>
  queue: SendQueue
  /** Run nodes ending. */
  runs?: { onRun(cb: (id: string, run: RunResult) => void): void }
  preflight?: RunPreflight
  watch?: WatchFolder
  now?: () => number
}): TriggerService {
  /** What each trigger has waiting in the queue: one at most, so a busy target doesn't collect a pile. */
  const pending = new Map<string, { runId: string; targetId: string; spec: string; item: object }>()
  /** Triggers whose check before firing is running. One at a time each. */
  const checking = new Set<string>()
  /** When each trigger's events last got through the gate, for the cool-down and the hourly cap. In memory only. */
  const fired = new Map<string, number[]>()
  const ownTurns = new Map<string, OwnTurn>()
  /** The last status seen for each session, so a change can be read as an event. Kept even while stopped. */
  const seen = new Map<string, AgentStatus>()
  const watchers = new Map<string, { spec: string; close: () => void }>()
  let timer: NodeJS.Timeout | null = null
  let running = false

  const triggers = (): TriggerNode[] => store.get().nodes.filter((n): n is TriggerNode => n.kind === 'trigger')
  const find = (id: string): TriggerNode | undefined => triggers().find((n) => n.id === id)
  const setState = (id: string, state: Partial<TriggerState>): void => store.dispatch({ op: 'setTriggerState', id, state })
  const titleOf = (id: string): string => store.get().nodes.find((n) => n.id === id)?.title ?? 'a node that is gone'

  const record = (id: string, run: TriggerRun): void => {
    const node = find(id)
    if (node) setState(id, { runs: [run, ...node.runs].slice(0, RUN_LIMIT) })
  }

  const updateRun = (id: string, runId: string, patch: Partial<TriggerRun>): void => {
    const node = find(id)
    if (node?.runs.some((r) => r.id === runId)) setState(id, { runs: node.runs.map((r) => (r.id === runId ? { ...r, ...patch } : r)) })
  }

  /** A skip, folded into the newest run when that's the same skip, so a noisy source doesn't push out the history. */
  const skip = (id: string, source: TriggerRun['source'], why: string, event?: TriggerEvent | null, check?: TriggerRun['preflight']): void => {
    const node = find(id)
    if (!node) return
    const at = now()
    const happened = event ? describeEventHappened(event) : undefined
    const top = node.runs[0]
    if (!check && top?.outcome === 'skipped' && top.detail === why && !top.preflight) {
      setState(id, { runs: [{ ...top, at, repeats: (top.repeats ?? 1) + 1, ...(happened && { event: happened }) }, ...node.runs.slice(1)] })
      return
    }
    record(id, { id: randomUUID(), at, source, outcome: 'skipped', detail: why, ...(happened && { event: happened }), ...(check && { preflight: check }) })
  }

  /** Whether the trigger still says what was agreed when this was sent. */
  const stillWanted = (id: string, spec: string): boolean => {
    const node = find(id)
    return !!node && node.armedSpec === spec && isArmed(node)
  }

  /** A one-off whose slot has gone is done, once nothing it sent is still waiting. Event kinds have no slots to spend. */
  const finishIfSpent = (id: string): void => {
    const node = find(id)
    if (node && !isEventSchedule(node.schedule) && node.armedSpec !== null && node.nextAt === null && !pending.has(id) && !checking.has(id)) setState(id, { ...DISARMED })
  }

  const settled = (id: string, runId: string, patch: Partial<TriggerRun>): void => {
    if (pending.get(id)?.runId === runId) pending.delete(id)
    updateRun(id, runId, patch)
    finishIfSpent(id)
  }

  /** Whether what this trigger sends into a session could come back to it as its own event. */
  const loops = (node: TriggerNode, targetId: string): boolean =>
    (node.schedule.type === 'agent' && node.schedule.nodeId === targetId) || node.schedule.type === 'files'

  /** When a trigger's own turn ended. One that never began is given up on after a while, so it can't silence a trigger. */
  const ownTurnEnd = (own: OwnTurn): number => {
    if (own.terminal) {
      const { quietMs, lastOutput } = own.terminal
      return Math.min(own.from + TERMINAL_RUN_MAX_MS, Math.max(own.from + Math.max(2 * quietMs, TERMINAL_RUN_MIN_MS), lastOutput + quietMs))
    }
    return own.endedAt ?? (own.started ? Infinity : own.from + OWN_TURN_START_MS)
  }

  const delivered = (node: TriggerNode, targetId: string, terminal = false): void => {
    if (!loops(node, targetId)) return
    const t = now()
    const quietMs = node.schedule.type === 'files' ? node.schedule.quietMs : 0
    ownTurns.set(node.id, { targetId, from: t, started: terminal, endedAt: null, ...(terminal && { terminal: { quietMs, lastOutput: t } }) })
  }

  const fire = (node: TriggerNode, source: TriggerRun['source'], at: number, event: TriggerEvent | null = null, check?: TriggerRun['preflight']): TriggerRun => {
    const happened = event ? describeEventHappened(event) : undefined
    const run = (outcome: TriggerRun['outcome'], detail?: string): TriggerRun => ({ id: randomUUID(), at, source, outcome, ...(detail && { detail }), ...(happened && { event: happened }), ...(check && { preflight: check }) })
    const target = store.get().nodes.find((n) => n.id === node.targetId)
    const result = ((): TriggerRun => {
      if (!isTriggerTarget(target)) return run('missed', 'What it sends to is gone.')
      // Settings > Agents: nothing goes to an agent turned off, even one still running.
      const off = target.kind === 'claude' ? agentOffNow(agentOf(target)) : null
      if (off) return run('failed', host.isRunning(target.id) ? `${off} "${target.title}" is still running, but nothing was sent to it.` : off)
      if (!host.isRunning(target.id) || (target.kind === 'claude' && tracker.get(target.id) === 'exited')) {
        return run('missed', `"${target.title}" wasn't running. A trigger never starts a session.`)
      }
      // Placeholders are filled only for event kinds, so a schedule's prompt goes exactly as written, as it always did.
      // Into a terminal, a value would reach a shell, so it keeps only characters a shell does nothing with.
      const text = plainText(isEventSchedule(node.schedule) ? expandPrompt(node.prompt, eventVars(event, at, target.kind)) : node.prompt)
      if (target.kind === 'terminal') {
        try {
          queue.type(target.id, text)
          delivered(node, target.id, true)
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
        onDelivered: () => {
          delivered(node, target.id)
          settled(node.id, first.id, { outcome: 'delivered', detail: `Sent to "${target.title}" once it was idle, at ${when(now())}.` })
        },
        onDropped: () => settled(node.id, first.id, { outcome: 'missed', detail: 'Dropped before delivery: the trigger was disarmed or changed, or its target went.' })
      }
      // Recorded first, so a delivery reported later has a run to update.
      pending.set(node.id, { runId: first.id, targetId: target.id, spec, item })
      record(node.id, first)
      if (queue.add(target.id, item) === 'queued') return first
      pending.delete(node.id)
      delivered(node, target.id)
      const sent = { outcome: 'delivered' as const, detail: `Sent to "${target.title}", which was idle.` }
      updateRun(node.id, first.id, sent)
      return { ...first, ...sent }
    })()
    if (!find(node.id)?.runs.some((r) => r.id === result.id)) record(node.id, result)
    return result
  }

  /**
   * Fires after its check, when it has one. A check that doesn't exit 0 stops this firing, and says why. The trigger
   * must still say what was agreed when the check ends.
   */
  const fireChecked = (node: TriggerNode, source: TriggerRun['source'], at: number, event: TriggerEvent | null = null): void => {
    const check = node.preflight
    if (!check || !preflight) {
      fire(node, source, at, event)
      return
    }
    if (checking.has(node.id)) {
      skip(node.id, source, 'Its last check before firing was still running.', event)
      return
    }
    const spec = node.armedSpec!
    checking.add(node.id)
    const done = (r: ProgramResult): void => {
      checking.delete(node.id)
      const result = { code: r.code, tail: outputTail(r.stdout + (r.stderr ? `\n${r.stderr}` : '')) }
      const command = check.argv.join(' ')
      if (!stillWanted(node.id, spec)) skip(node.id, source, 'It was disarmed or changed while its check ran.', event, result)
      else if (r.code === 0) fire(find(node.id)!, source, now(), event, result)
      else {
        const how = r.missing ? `couldn't start ${check.argv[0]}` : r.timedOut ? 'took too long and was ended' : r.code === null ? 'was ended' : `exited ${r.code}`
        skip(node.id, source, `The check "${command}" ${how}, so it didn't fire.`, event, result)
      }
      finishIfSpent(node.id)
    }
    preflight(check.argv, check.cwd).then(done, (e: unknown) => done({ code: null, stdout: '', stderr: (e as Error).message, truncated: false, timedOut: false, missing: true }))
  }

  /** An event for an armed trigger: through the gate, then fired. */
  const onEvent = (node: TriggerNode, event: TriggerEvent, at: number): void => {
    if (!running || !isArmed(node)) return
    const limits = limitsOf(node)!
    if (checking.has(node.id)) return skip(node.id, 'event', 'Its last check before firing was still running.', event)
    const times = (fired.get(node.id) ?? []).filter((t) => at - t < HOUR_MS)
    const last = times[times.length - 1]
    if (last !== undefined && at - last < limits.gapMs) return skip(node.id, 'event', `Cool-down: it fires at most once every ${describeSeconds(limits.gapMs)}.`, event)
    if (times.length >= limits.perHour) return skip(node.id, 'event', `Hourly limit: it already fired ${limits.perHour} time${limits.perHour === 1 ? '' : 's'} in the last hour.`, event)
    // A check that fails still counts, so a failing check isn't run again and again.
    fired.set(node.id, [...times, at])
    fireChecked(node, 'event', at, event)
  }

  const OWN_TURN = 'That turn was started by this trigger\'s own prompt, so it doesn\'t fire it again.'
  const OWN_FILES = 'Those changes were made during the turn this trigger\'s own prompt started, so they don\'t fire it again.'
  const OWN_TERMINAL = "Those changes came while what this trigger typed into its terminal was still running, so they don't fire it again."

  const agentEvent = (prev: AgentStatus | undefined, status: AgentStatus): 'turn' | 'needs-you' | 'exit' | null => {
    if (status === 'idle' && (prev === 'working' || prev === 'needs-you')) return 'turn'
    if (status === 'needs-you' && prev !== 'needs-you') return 'needs-you'
    if (status === 'exited' && prev !== 'exited') return 'exit'
    return null
  }

  const onStatus = (id: string, status: AgentStatus): void => {
    const prev = seen.get(id)
    seen.set(id, status)
    if (!running) return
    const kind = agentEvent(prev, status)
    if (kind) {
      for (const node of triggers()) {
        const s = node.schedule
        if (s.type !== 'agent' || s.nodeId !== id || s.on !== kind || !isArmed(node)) continue
        const own = ownTurns.get(node.id)
        // Only once that turn has begun: the idle a waiting prompt is delivered on ends someone else's turn.
        if (own?.targetId === id && own.started && own.endedAt === null) skip(node.id, 'event', OWN_TURN, { type: 'agent', nodeTitle: titleOf(id), on: kind })
        else onEvent(node, { type: 'agent', nodeTitle: titleOf(id), on: kind }, now())
      }
    }
    // After the events above, so the end of a trigger's own turn is still known as its own.
    for (const [tid, own] of ownTurns) {
      if (own.targetId !== id || own.endedAt !== null) continue
      if (!own.started && ownTurnEnd(own) < now()) {
        ownTurns.delete(tid)
        continue
      }
      if (status === 'working') own.started = true
      if (status === 'exited' || (status === 'idle' && own.started)) {
        if (find(tid)?.schedule.type === 'files') own.endedAt = now()
        else ownTurns.delete(tid)
      }
    }
  }

  const onBatch = (id: string, folder: string, b: FileBatch): void => {
    const node = find(id)
    if (!node || node.schedule.type !== 'files') return
    const event: TriggerEvent = { type: 'files', folder, files: b.files, total: b.total }
    const own = ownTurns.get(id)
    const end = own ? ownTurnEnd(own) : 0
    if (own && end < now()) ownTurns.delete(id)
    if (own && b.lastAt >= own.from && b.firstAt <= end) return skip(id, 'event', own.terminal ? OWN_TERMINAL : OWN_FILES, event)
    onEvent(node, event, now())
  }

  /** Keeps one watch for each armed file trigger, and none for anything else. */
  const syncWatchers = (): void => {
    const want = new Map<string, TriggerNode>()
    if (running && watch) for (const n of triggers()) if (n.schedule.type === 'files' && isArmed(n)) want.set(n.id, n)
    for (const [id, w] of watchers) {
      if (want.get(id)?.armedSpec === w.spec) continue
      w.close()
      watchers.delete(id)
    }
    for (const [id, node] of want) {
      if (watchers.has(id) || node.schedule.type !== 'files' || !watch) continue
      const { folder, glob, quietMs } = node.schedule
      const spec = node.armedSpec!
      const batcher = createFileBatcher({ glob, quietMs, now, onBatch: (b) => onBatch(id, folder, b) })
      const fail = (e: Error): void => {
        const w = watchers.get(id)
        if (w?.spec !== spec) return
        w.close()
        watchers.delete(id)
        record(id, { id: randomUUID(), at: now(), source: 'event', outcome: 'failed', detail: `Stopped watching ${folder}: ${e.message} It's disarmed.` })
        setState(id, { ...DISARMED })
      }
      try {
        const w = watch(folder, (rel) => batcher.change(rel), fail)
        watchers.set(id, {
          spec,
          close: () => {
            batcher.close()
            w.close()
          }
        })
      } catch (e) {
        watchers.set(id, { spec, close: () => batcher.close() })
        fail(e as Error)
      }
    }
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
        fireChecked(node, 'schedule', node.nextAt)
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
    for (const id of ownTurns.keys()) {
      const node = find(id)
      if (!node || !isArmed(node)) ownTurns.delete(id)
    }
  }

  store.subscribe(() => {
    dropStale()
    syncWatchers()
    plan()
  })
  tracker.onChange((targetId, status) => {
    if (status === 'exited') {
      for (const [id, p] of pending) {
        if (p.targetId !== targetId) continue
        queue.drop((_t, item) => item === p.item)
        if (pending.get(id) === p) settled(id, p.runId, { outcome: 'missed', detail: 'Its target ended before it was idle.' })
      }
    }
    onStatus(targetId, status)
  })
  host.onOutput?.((id) => {
    if (!ownTurns.size) return
    const t = now()
    for (const own of ownTurns.values()) if (own.terminal && own.targetId === id && t <= ownTurnEnd(own)) own.terminal.lastOutput = t
  })
  runEvents?.onRun((id, r) => {
    // Only an end it reached by itself. One you stopped isn't "finished", and one noted at start-up came before this.
    if (!running || r.running || r.exitCode === null || r.stoppedByYou) return
    for (const node of triggers()) {
      const s = node.schedule
      if (s.type !== 'run' || s.nodeId !== id || !isArmed(node) || (s.failedOnly && r.exitCode === 0)) continue
      onEvent(node, { type: 'run', nodeTitle: titleOf(id), exitCode: r.exitCode }, now())
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
        else if (isArmed(current) && !isEventSchedule(current.schedule)) {
          if (current.nextAt === null) advance(current, t)
          else if (current.nextAt <= t) missedSlots(current, t, 'the app was closed. Nothing runs while it is.')
        }
      }
      running = true
      syncWatchers()
      plan()
    },
    stop() {
      running = false
      syncWatchers()
      plan()
    },
    arm(id, shown) {
      const node = find(id)
      if (!node) return { ok: false, reason: 'That trigger is gone.' }
      if (shown !== canonicalSpec(node)) return { ok: false, reason: 'The trigger changed after it was shown to you. Look again, then arm it.' }
      const t = now()
      const refusal = armRefusal(node, store.get(), t)
      if (refusal) return { ok: false, reason: refusal }
      fired.delete(id)
      ownTurns.delete(id)
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
