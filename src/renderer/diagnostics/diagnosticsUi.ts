import { create } from 'zustand'
import type { AgentProgramInfo, BuildInfo, DiagnosticsBridge } from '../../shared/diagnostics'

declare global {
  interface Window {
    patchbayDiagnostics?: DiagnosticsBridge
  }
}

/** Main's diagnostics calls. Looked up on use, so this module loads where there's no window, as in tests. */
export const diagnosticsBridge = (): DiagnosticsBridge | undefined => (typeof window === 'undefined' ? undefined : window.patchbayDiagnostics)

/** "Commit e94fa9b1c2 on main, built 24 Nov 2026, 14:02", or what's known of it. */
export function buildLine(b: BuildInfo, locale?: string): string {
  const when = Date.parse(b.date)
  const built = Number.isFinite(when) ? `built ${new Date(when).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}` : 'build date unknown'
  if (b.commit === 'unknown') return `Commit unknown, ${built}`
  const branch = b.branch && b.branch !== 'HEAD' ? ` on ${b.branch}` : ''
  return `Commit ${b.commit}${b.dirty ? ' with changes' : ''}${branch}, ${built}`
}

/** "Claude Code 2.1.150", or "Codex, not found". */
export function agentLine(a: AgentProgramInfo): string {
  return /^\d/.test(a.version) ? `${a.name} ${a.version}` : `${a.name}, ${a.version}`
}

/** What the last Copy diagnostics from a menu or the palette did, shown as a toast over the canvas. */
export const useDiagnosticsNote = create<{ note: { ok: boolean; text: string } | null }>(() => ({ note: null }))

export function copiedText(r: Awaited<ReturnType<DiagnosticsBridge['copy']>>): string {
  return r.ok ? `Diagnostics copied, ${r.lines} lines. Paste them into your bug report.` : r.reason
}

/** Copy diagnostics, from Help or the palette: the answer comes as a toast. */
export function copyDiagnostics(): void {
  const bridge = diagnosticsBridge()
  if (!bridge) return
  void bridge.copy().then((r) => useDiagnosticsNote.setState({ note: { ok: r.ok, text: copiedText(r) } }))
}

export function openLogFolder(): void {
  void diagnosticsBridge()?.openLogFolder()
}
