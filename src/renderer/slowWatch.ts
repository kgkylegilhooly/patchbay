import { bridge } from './bridge'
import { useStore } from './store'

/** A task holding the window up this long is one the person saw as a freeze, so it goes in the log. */
export const SLOW_MS = 2000

/** What was on screen, briefly, so a line in the log says something about the circumstances. */
function circumstances(): string {
  const s = useStore.getState()
  const nodes = s.doc?.nodes ?? []
  const count = (kind: string): number => nodes.filter((n) => n.kind === kind && (!n.projectId || n.projectId === s.doc?.activeProjectId)).length
  const view = s.focus ? 'focus view' : s.boardOpen ? 'board' : s.maximized ? 'maximized window' : 'canvas'
  return `${view}, ${count('terminal')} terminals, ${count('claude')} agents, ${count('browser')} browsers, ${count('whiteboard')} whiteboards`
}

/** Notes each long freeze of the window in Patchbay's log. The browser reports them; nothing is timed here. */
export function watchForSlowTasks(): void {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) if (entry.duration >= SLOW_MS) bridge.noteSlow(Math.round(entry.duration), circumstances())
  }).observe({ type: 'longtask', buffered: true })
}
