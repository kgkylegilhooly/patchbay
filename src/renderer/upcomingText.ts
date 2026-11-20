/**
 * A trigger's next firings, short enough to read at a glance: "1:49 PM, 1:54 PM, 1:59 PM today". The day is said once
 * per run of times on the same day, and seconds are shown only when two times would otherwise read the same.
 */
export function upcomingText(times: number[], now: number, locale?: string): string {
  if (!times.length) return ''
  const minutes = times.map((t) => Math.floor(t / 60_000))
  const seconds = minutes.some((m, i) => i > 0 && m === minutes[i - 1])
  const clock = (t: number): string => new Date(t).toLocaleTimeString(locale ?? [], { hour: 'numeric', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}) })
  const groups: { day: string; clocks: string[] }[] = []
  for (const t of times) {
    const day = dayName(t, now, locale)
    const last = groups[groups.length - 1]
    if (last?.day === day) last.clocks.push(clock(t))
    else groups.push({ day, clocks: [clock(t)] })
  }
  return groups.map((g) => `${g.clocks.join(', ')} ${g.day}`).join('; ')
}

function dayName(t: number, now: number, locale?: string): string {
  const start = (ms: number): number => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  const days = Math.round((start(t) - start(now)) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  return new Date(t).toLocaleDateString(locale ?? [], { weekday: 'short', month: 'short', day: 'numeric' })
}
