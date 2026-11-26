import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { isSessionNode } from '../shared/model'
import type { CanvasStore } from '../shared/contract'

/**
 * A window's folder, opened in File Explorer or in VS Code. Only the node's own folder: the page names a node, never a
 * path. VS Code is started as its Code.exe, found beside the `bin\code.cmd` its installer puts on PATH, with the folder
 * as one argument and no shell, since Node won't start a .cmd without one and a shell would read a path's & or %.
 */

/** Code.exe for the `code` on PATH, or null. Insiders and other forks aren't looked for. */
export function findVsCode(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): string | null {
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (!dir || !exists(join(dir, 'code.cmd'))) continue
    const exe = join(dirname(dir), 'Code.exe')
    if (exists(exe)) return exe
  }
  return null
}

export type OpenHow = 'explorer' | 'vscode'
export type OpenResult = { ok: true } | { ok: false; reason: string }

/** The folder a node works in, when it's a folder that's there. */
function folderOf(store: CanvasStore, nodeId: string): string | { reason: string } {
  const node = store.get().nodes.find((n) => n.id === nodeId)
  if (!node || !isSessionNode(node) || !node.cwd) return { reason: 'That window has no folder.' }
  const isDir = (() => {
    try {
      return statSync(node.cwd).isDirectory()
    } catch {
      return false
    }
  })()
  return isDir ? node.cwd : { reason: `${node.cwd} isn't there any more.` }
}

export async function openFolder(
  store: CanvasStore,
  nodeId: string,
  how: OpenHow,
  io: { openPath: (path: string) => Promise<string>; vsCode: () => string | null; start: (exe: string, folder: string) => void } = {
    openPath: (p) => shell.openPath(p),
    vsCode: () => findVsCode(),
    start: (exe, folder) => spawn(exe, [folder], { detached: true, stdio: 'ignore' }).unref()
  }
): Promise<OpenResult> {
  const folder = folderOf(store, nodeId)
  if (typeof folder !== 'string') return { ok: false, reason: folder.reason }
  if (how === 'explorer') {
    const problem = await io.openPath(folder)
    return problem ? { ok: false, reason: problem } : { ok: true }
  }
  const exe = io.vsCode()
  if (!exe) return { ok: false, reason: "VS Code wasn't found: its `code` command isn't on PATH." }
  try {
    io.start(exe, folder)
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `VS Code couldn't be started: ${(e as Error).message}` }
  }
}

/**
 * A file at a line, as Code.exe's own `-g file:line[:column]` takes it (its main process reads `goto` from its
 * arguments, not only code.cmd's). One argument and no shell, as for a folder. False when VS Code isn't there or won't
 * start, so the file opens as it would have.
 */
export function openInVsCodeAt(
  path: string,
  line: number,
  column: number | undefined,
  io: { vsCode: () => string | null; start: (exe: string, args: string[]) => void } = {
    vsCode: () => findVsCode(),
    start: (exe, args) => spawn(exe, args, { detached: true, stdio: 'ignore' }).unref()
  }
): boolean {
  const exe = io.vsCode()
  if (!exe) return false
  try {
    io.start(exe, ['-g', `${path}:${line}${column ? `:${column}` : ''}`])
    return true
  } catch {
    return false
  }
}

/** pb:folder:open and pb:folder:hasVsCode, for the app's own window only. */
export function serveOpenFolder(store: CanvasStore, isAppUi: (e: IpcMainInvokeEvent) => boolean): void {
  let vsCode: string | null | undefined
  ipcMain.handle('pb:folder:hasVsCode', (e) => isAppUi(e) && (vsCode ??= findVsCode()) !== null)
  ipcMain.handle('pb:folder:open', (e, nodeId: unknown, how: unknown) =>
    isAppUi(e) && typeof nodeId === 'string' && (how === 'explorer' || how === 'vscode') ? openFolder(store, nodeId, how) : { ok: false, reason: 'Not allowed.' }
  )
}
