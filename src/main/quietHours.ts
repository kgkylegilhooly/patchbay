/**
 * Quiet hours: Settings > Notifications, a from and a to time. In between, Patchbay's own Windows notifications are held
 * and its chime and taskbar flash are skipped; the canvas, the sidebar and Needs you show everything as usual. When the
 * quiet hours end, one notification says what was held. Both blank, or the same time, means none.
 */

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/

/** Minutes after midnight for "HH:MM", or null for anything else. */
export function minutesOf(text: string | undefined): number | null {
  const m = HHMM.exec((text ?? '').trim())
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/** Whether a local time falls in the quiet hours, which may run past midnight, as 22:00 to 07:00. */
export function inQuietHours(from: string | undefined, to: string | undefined, now: Date): boolean {
  const start = minutesOf(from)
  const end = minutesOf(to)
  if (start === null || end === null || start === end) return false
  const at = now.getHours() * 60 + now.getMinutes()
  return start < end ? at >= start && at < end : at >= start || at < end
}

export interface HeldToast {
  title: string
  body: string
}

/** The notification that ends quiet hours: who needed you or finished, at most a few named. Null when nothing was held. */
export function quietSummary(held: HeldToast[]): { title: string; body: string } | null {
  if (!held.length) return null
  const byTitle = new Map<string, string>()
  // The latest word from each, in the order they first spoke.
  for (const h of held) byTitle.set(h.title, h.body)
  const lines = [...byTitle].slice(0, 4).map(([title, body]) => `${title}: ${body}`)
  const more = byTitle.size > 4 ? ` And ${byTitle.size - 4} more.` : ''
  return { title: `While it was quiet: ${held.length} notification${held.length === 1 ? '' : 's'} held`, body: `${lines.join(' ')}${more}` }
}

/** Holds notifications during quiet hours, and hands back a summary once they end. */
export function createQuietGate(d: { hours: () => { from?: string; to?: string }; now?: () => Date }) {
  const now = d.now ?? (() => new Date())
  let held: HeldToast[] = []
  const quiet = (): boolean => inQuietHours(d.hours().from, d.hours().to, now())
  return {
    quiet,
    /** True when this one was held rather than shown. */
    hold(toast: HeldToast): boolean {
      if (!quiet()) return false
      held.push(toast)
      return true
    },
    /** Once the quiet hours are over: the summary of what was held, given once. */
    ended(): { title: string; body: string } | null {
      if (quiet() || !held.length) return null
      const summary = quietSummary(held)
      held = []
      return summary
    }
  }
}
