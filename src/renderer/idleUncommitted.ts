import type { AgentStatus } from '../shared/model'

/**
 * F52: an agent finished, the person moved on, and its edits sit uncommitted until something overwrites them. Once an
 * agent has been idle a while, its own edits are looked at now and then (F20's check, main/files/service.ts
 * `uncommitted`), and its header gets a quiet chip while any are uncommitted. No notification: just the chip.
 * The watcher and the chip are in nodes/UncommittedChip.tsx.
 */

export const IDLE_FOR_MS = 30 * 60_000
export const CHECK_EVERY_MS = 5 * 60_000

/** When each agent became idle, kept while it stays idle. */
export function nextIdleSince(prev: Record<string, number>, statuses: Partial<Record<string, AgentStatus>>, now: number): Record<string, number> {
  const next: Record<string, number> = {}
  for (const [id, status] of Object.entries(statuses)) if (status === 'idle') next[id] = prev[id] ?? now
  return next
}

/** Idle long enough, and not looked at in the last few minutes. */
export const dueForCheck = (now: number, idleSince: number, checkedAt: number | undefined): boolean =>
  now - idleSince >= IDLE_FOR_MS && (checkedAt === undefined || now - checkedAt >= CHECK_EVERY_MS)

export function chipLabel(files: string[], idleMs: number): string {
  const minutes = Math.floor(idleMs / 60_000)
  const idle = minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h`
  return `${files.length} file${files.length === 1 ? '' : 's'} uncommitted, idle ${idle}`
}
