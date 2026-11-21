import { formatBytes } from '../../shared/projects'
import type { AgentStatus } from '../../shared/model'
import type { ResourceReading, ResourcesBridge, SessionUse } from '../../shared/resources'
import type { SyncReport, SyncRow } from '../../shared/sessionSync'
import { AGENT_LABELS } from '../status/status'

declare global {
  interface Window {
    patchbayResources?: ResourcesBridge
  }
}

/** Main's resource calls. Looked up on use, so this module loads where there's no window, as in tests. */
export const resourcesBridge = (): ResourcesBridge | undefined => (typeof window === 'undefined' ? undefined : window.patchbayResources)

export const sizeText = (bytes: number | null | undefined): string => (bytes === null || bytes === undefined ? '…' : formatBytes(bytes))

export const cpuText = (cpu: number | null): string => (cpu === null ? '…' : `${cpu < 1 && cpu > 0 ? '<1' : Math.round(cpu)}%`)

/** "idle 25 min", from when an agent went idle. */
export function idleText(since: number | null, now: number): string {
  if (since === null) return ''
  const min = Math.floor((now - since) / 60_000)
  if (min < 1) return 'idle just now'
  if (min < 60) return `idle ${min} min`
  const h = Math.floor(min / 60)
  return h < 48 ? `idle ${h} h` : `idle ${Math.floor(h / 24)} days`
}

/** The share of a limit in use, 0 to 1. */
export const usedShare = (total: number, free: number): number => (total > 0 ? Math.min(1, Math.max(0, (total - free) / total)) : 0)

/** Electron's process types, as a person would name them. */
const TYPE_NAMES: Record<string, string> = { Browser: 'app', Tab: 'window and pages', GPU: 'graphics', Utility: 'helpers', 'Pepper Plugin': 'plugins' }

/** Patchbay's own memory in one line: the total, then its biggest parts. */
export function appBreakdown(app: ResourceReading['app']): string {
  const parts = Object.entries(app.byType)
    .filter(([, bytes]) => bytes > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([type, bytes]) => `${TYPE_NAMES[type] ?? type.toLowerCase()} ${formatBytes(bytes)}`)
  return parts.join(', ')
}

/** How xterm's scrollback costs memory: about 12 bytes a cell, so lines times columns. */
export function scrollbackEstimate(lines: number, cols = 120): number {
  return lines * cols * 12
}

export function readAgo(at: number | null, now: number): string {
  if (at === null) return 'Processes not read yet.'
  const s = Math.max(0, Math.round((now - at) / 1000))
  return s < 5 ? 'Read just now.' : s < 120 ? `Read ${s} s ago.` : `Read ${Math.round(s / 60)} min ago.`
}

/** One line of the Sessions table: what the host runs, what the canvas shows, and what it uses. */
export interface SessionLine {
  id: string
  /** Null for a session no node shows. */
  title: string | null
  projectId: string | null
  running: boolean
  pid: number | null
  /** The session-sync row, when the host has been asked. It carries the note and the actions. */
  sync: SyncRow | null
  use: SessionUse | null
}

/**
 * The host's sessions (from the session check) joined by id with what each uses (from the resource reading). Either
 * can be missing: sessions running in the app have no check, and a check can list ended ones. Largest first, then the
 * rest in the check's order.
 */
export function sessionLines(sync: SyncReport | null, reading: ResourceReading | null): SessionLine[] {
  const uses = new Map((reading?.sessions ?? []).map((s) => [s.id, s]))
  const lines: SessionLine[] = []
  const seen = new Set<string>()
  for (const row of sync?.hostReached ? sync.rows : []) {
    seen.add(row.id)
    const use = uses.get(row.id) ?? null
    lines.push({ id: row.id, title: row.title, projectId: use?.projectId ?? null, running: row.running, pid: row.pid, sync: row, use })
  }
  for (const use of reading?.sessions ?? []) {
    if (seen.has(use.id)) continue
    lines.push({ id: use.id, title: use.kind === 'unknown' ? null : use.title, projectId: use.projectId, running: true, pid: use.pid, sync: null, use })
  }
  const order = new Map(lines.map((l, i) => [l.id, i]))
  return lines.sort((a, b) => (b.use?.memory ?? -1) - (a.use?.memory ?? -1) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
}

/** What the canvas shows for a line, in the status system's words, with how long an idle agent has been idle. */
export function shownLine(line: SessionLine, now: number): string {
  let shown: string
  // As session-sync's list said it: the canvas's own words, and a terminal has only running or ended.
  if (line.sync) shown = !line.sync.title ? '—' : line.sync.shown ? AGENT_LABELS[line.sync.shown] : line.sync.running ? 'Running' : 'Ended'
  else if (!line.title) shown = '—'
  else shown = line.use?.kind === 'agent' && line.use.status in AGENT_LABELS ? AGENT_LABELS[line.use.status as AgentStatus] : 'Running'
  const idle = line.use?.idleSince ?? null
  if (idle === null) return shown
  // "Idle 25 min" rather than "Idle, idle 25 min".
  const since = idleText(idle, now)
  return shown === AGENT_LABELS.idle ? `${since.charAt(0).toUpperCase()}${since.slice(1)}` : `${shown}, ${since}`
}

/** The check's summary, as session-sync wrote it. */
export function syncSummary(report: SyncReport | null): string {
  const rows = report?.rows ?? []
  const problems = rows.filter((r) => r.problem).length
  if (!report) return 'Not checked yet.'
  if (!report.hostReached) return 'There was no background host to ask.'
  if (problems === 0) return `${rows.length} session${rows.length === 1 ? '' : 's'}, each matching its node.`
  return `${problems} of ${rows.length} didn't match. Patchbay put right what it could; anything with no node waits for you.`
}
