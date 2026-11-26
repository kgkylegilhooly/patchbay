import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { lastLines, stripAnsi } from '../core/transcript/read'
import type { CanvasStore, RunResult } from '../shared/contract'
import type { RunNode } from '../shared/model'
import type { RunFixResult } from '../shared/runFix'

/**
 * F31, Ask an agent to fix: a failed run's command, exit code and last output, as the brief for a new agent, so the
 * person doesn't copy the error out of the run window by hand. The person reads and edits it before anything starts.
 */

const LINES = 80
/** A brief carries the end of the output, not a whole build log. */
const MAX_OUTPUT_CHARS = 8000

/** A fence longer than any run of backticks in the output, so the output can't end it early. */
function fence(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length))
  return '`'.repeat(Math.max(3, longest + 1))
}

export function fixBrief(run: Pick<RunNode, 'title' | 'cwd' | 'command' | 'launch'>, exitCode: number, output: string): string {
  const what = run.launch ? `The launch configuration "${run.launch.name}" in ${run.cwd}` : `The run "${run.title}" failed: \`${run.command}\` in ${run.cwd}`
  const again = run.launch ? 'Then run it again from its window to check.' : `Then run \`${run.command}\` again to check.`
  const shown = output.trim()
  const said = shown ? ['Its last output:', '', fence(shown), shown, fence(shown)] : ['It printed nothing.']
  return [`${what} exited with code ${exitCode}.`, '', ...said, '', `Find out why it failed and fix it. ${again}`].join('\n')
}

/** The end of what the run printed, as plain text. */
function lastOutput(raw: string): string {
  const text = lastLines(stripAnsi(raw).replace(/\r/g, '').replace(/\s+$/, ''), LINES).replace(/\n$/, '')
  return text.length > MAX_OUTPUT_CHARS ? `…${text.slice(-MAX_OUTPUT_CHARS)}` : text
}

export function runFixFor(store: CanvasStore, nodeId: string, result: RunResult | undefined, output: (id: string) => string): RunFixResult {
  const node = store.get().nodes.find((n) => n.id === nodeId)
  if (node?.kind !== 'run') return { ok: false, reason: 'That window is not a run command.' }
  if (!result || result.running || result.stoppedByYou || !result.exitCode) return { ok: false, reason: `${node.title} didn't fail.` }
  return { ok: true, cwd: node.cwd, brief: fixBrief(node, result.exitCode, lastOutput(output(nodeId))) }
}

/** pb:run:fixBrief, for the app's own window only. */
export function serveRunFix(
  deps: { store: CanvasStore; runs: () => Record<string, RunResult>; output: (id: string) => string },
  isAppUi: (e: IpcMainInvokeEvent) => boolean
): void {
  ipcMain.handle('pb:run:fixBrief', (e, nodeId: unknown): RunFixResult =>
    isAppUi(e) && typeof nodeId === 'string' ? runFixFor(deps.store, nodeId, deps.runs()[nodeId], deps.output) : { ok: false, reason: 'Not allowed.' }
  )
}
