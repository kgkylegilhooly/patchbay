import type { PressureKind, ResourceWarning, SessionUse, SystemMemory } from '../../shared/resources'

/**
 * When to warn. Running out of commit is what stops programs starting ("fork: Resource temporarily unavailable",
 * error 299), so it comes first. Physical memory alone running low only makes the PC slow, so its line is lower.
 */
export const PRESSURE = {
  /** Warn when less than this share of the commit limit is left. */
  commitFree: 0.1,
  /** Warn when less than this share of RAM is available. */
  physFree: 0.06,
  /**
   * A warning shown once is shown again only after its shortage has ended and come back, and not within this long of
   * the last time. A shortage that simply lasts is said once.
   */
  rearmMs: 60 * 60_000,
  /** The most idle sessions suggested. */
  suggestions: 3
} as const

/** What's short now, if anything: the most serious first. */
export function pressureNow(system: SystemMemory | null, agents: { running: number; limit: number | null }): PressureKind | null {
  if (system && system.commitLimit > 0 && system.commitAvail / system.commitLimit < PRESSURE.commitFree) return 'commit'
  if (system && system.totalPhys > 0 && system.availPhys / system.totalPhys < PRESSURE.physFree) return 'physical'
  if (agents.limit !== null && agents.running > agents.limit) return 'agents'
  return null
}

/** When each kind of warning was last shown, and whether its shortage has ended since. */
export type WarnedAt = Partial<Record<PressureKind, { at: number; cleared: boolean }>>

/** Whether to show a warning for `kind` now: once, and again only once it has ended, come back, and the re-arm time has passed. */
export function shouldWarn(kind: PressureKind | null, warned: WarnedAt, now: number): boolean {
  if (!kind) return false
  const last = warned[kind]
  return last === undefined || (last.cleared && now - last.at >= PRESSURE.rearmMs)
}

/** Notes that every kind other than `kind`, the shortage now, has ended. */
export function noteCleared(warned: WarnedAt, kind: PressureKind | null): void {
  for (const [k, last] of Object.entries(warned) as Array<[PressureKind, { at: number; cleared: boolean }]>) if (k !== kind) last.cleared = true
}

/** Agents at their prompt with nothing to do, worth closing to free memory: the longest idle first, then the largest. */
export function idleSuggestions(sessions: SessionUse[], max: number = PRESSURE.suggestions): SessionUse[] {
  return sessions
    .filter((s) => s.kind === 'agent' && s.idleSince !== null)
    .sort((a, b) => (a.idleSince ?? 0) - (b.idleSince ?? 0) || (b.memory ?? 0) - (a.memory ?? 0))
    .slice(0, max)
}

const gb = (bytes: number): string => `${(bytes / 1024 ** 3).toFixed(1)} GB`

/**
 * Why a new agent waits to start, or null when it needn't. Only commit running short holds one: that's what makes
 * programs fail to start, the new agent's and the next command of every agent already running. Low RAM only slows.
 */
export function memoryHoldReason(system: SystemMemory | null): string | null {
  if (!system || pressureNow(system, { running: 0, limit: null }) !== 'commit') return null
  return `Waiting for memory: Windows has ${gb(system.commitAvail)} of ${gb(system.commitLimit)} left to give programs, so a new agent could fail to start, or make the agents already running fail theirs. It starts by itself once memory frees up, or use Start now.`
}

export function warningText(kind: PressureKind, system: SystemMemory | null, agents: { running: number; limit: number | null }): string {
  if (kind === 'commit' && system) {
    return `Windows is nearly out of memory to give programs: ${gb(system.commitAvail)} of ${gb(system.commitLimit)} left. New programs and commands may fail to start. Closing idle sessions frees it.`
  }
  if (kind === 'physical' && system) {
    return `The PC is low on memory: ${gb(system.availPhys)} of ${gb(system.totalPhys)} free, so everything may slow down. Closing idle sessions frees it.`
  }
  return `${agents.running} agents are running, over your limit of ${agents.limit}. Nothing was stopped, but new ones won't start until fewer are running.`
}

export function buildWarning(kind: PressureKind, system: SystemMemory | null, agents: { running: number; limit: number | null }, sessions: SessionUse[]): ResourceWarning {
  return {
    kind,
    text: warningText(kind, system, agents),
    suggestions: idleSuggestions(sessions).map((s) => ({ id: s.id, title: s.title, memory: s.memory, idleSince: s.idleSince }))
  }
}
