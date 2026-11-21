import { formatBytes } from '../../shared/projects'
import type { ResourceReading, ResourcesBridge } from '../../shared/resources'

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
