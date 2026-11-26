import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { pickOrStub } from './testPickers'
import { stripAnsi } from '../core/transcript/read'
import type { CanvasStore } from '../shared/contract'
import { checkDocPath, systemFolders } from './reader/policy'
import { handoffFileName } from './search/saveHandoff'

/** F43: a terminal's or run's output, kept as a text file where the person picks, rather than select-all and paste. */

/**
 * What a window printed, as plain text. Colours and other controls go. A line redrawn in place, as a progress bar is,
 * keeps only what it showed last. Trailing spaces go, a run of blank lines becomes one with none leading or trailing,
 * and lines end as Windows writes them.
 */
export function outputText(raw: string): string {
  const lines = raw
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => stripAnsi(line.slice(line.lastIndexOf('\r') + 1)).replace(/\s+$/, ''))
  // Redraws (a resize, a cleared screen) leave runs of empty lines: one is kept, as a gap.
  const kept: string[] = []
  for (const line of lines) if (line || (kept.length && kept[kept.length - 1])) kept.push(line)
  while (kept.length && !kept[kept.length - 1]) kept.pop()
  return kept.length ? `${kept.join('\r\n')}\r\n` : ''
}

/** Where the person said to save, as a text file: a name without .txt gets it. */
const asTextPath = (path: string): string => (/\.txt$/i.test(path) ? path : `${path.replace(/[. ]+$/, '')}.txt`)

export type SaveOutputResult = { ok: true; path: string; lines: number } | { ok: false; reason: string; cancelled?: true }

export interface OutputSaverDeps {
  store: CanvasStore
  home: string
  /** What the window printed: the host's copy, or a finished run's saved output. */
  output(nodeId: string): Promise<string>
  /** The system save dialog, which asks before replacing a file. */
  pickFile(defaultPath: string): Promise<string | null>
  /** `exclusive` fails with EEXIST rather than replace a file. */
  writeFile(path: string, text: string, exclusive: boolean): Promise<void>
  system?: string[]
}

/** Window menu > Save output…: only the person's pick in the save dialog decides where a file is written. */
export function createOutputSaver(d: OutputSaverDeps) {
  const system = d.system ?? systemFolders()
  return async function saveOutput(nodeId: string): Promise<SaveOutputResult> {
    const node = d.store.get().nodes.find((n) => n.id === nodeId)
    if (node?.kind !== 'terminal' && node?.kind !== 'run') return { ok: false, reason: 'Only a terminal or run window has output to save.' }
    const text = outputText(await d.output(nodeId).catch(() => ''))
    if (!text) return { ok: false, reason: `${node.title} has no output to save yet.` }
    const picked = await d.pickFile(join(node.cwd || d.home, handoffFileName(`${node.title} output`).replace(/\.md$/, '.txt')))
    if (!picked) return { ok: false, cancelled: true, reason: 'Not saved.' }
    const check = checkDocPath(asTextPath(picked), system)
    if (!check.ok) return { ok: false, reason: check.reason }
    // The dialog asked before replacing the name it gave. A name changed here wasn't asked about, so it never replaces.
    const changed = check.path.toLowerCase() !== resolve(picked).toLowerCase()
    try {
      await d.writeFile(check.path, text, changed)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, reason: `${basename(check.path)} already exists. Save again and pick another name.` }
      return { ok: false, reason: `The output couldn't be saved: ${(e as Error).message}` }
    }
    return { ok: true, path: check.path, lines: text.split('\r\n').length - 1 }
  }
}

/** pb:output:save, for the app's own window only. */
export function serveSaveOutput(deps: Pick<OutputSaverDeps, 'store' | 'output'>, isAppUi: (e: IpcMainInvokeEvent) => boolean): void {
  const save = createOutputSaver({
    ...deps,
    home: homedir(),
    writeFile: (p, text, exclusive) => writeFile(p, text, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' }),
    // Off-screen test and screenshot runs answer with PATCHBAY_TEST_SAVE_AS instead of opening the dialog (testPickers.ts).
    pickFile: (defaultPath) =>
      pickOrStub('save', async () => {
        const options: Electron.SaveDialogOptions = { title: 'Save the output', defaultPath, filters: [{ name: 'Text', extensions: ['txt'] }] }
        const win = BrowserWindow.getFocusedWindow()
        const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        return r.canceled || !r.filePath ? null : r.filePath
      })
  })
  ipcMain.handle('pb:output:save', (e, nodeId: unknown) => (isAppUi(e) && typeof nodeId === 'string' ? save(nodeId) : { ok: false, reason: 'Not allowed.' }))
}
