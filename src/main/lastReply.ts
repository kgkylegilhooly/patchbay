import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron'
import { readAllMessages, readMessagesTail, type TranscriptMessage } from '../core/transcript/read'
import { createConversationSaver, revealTranscript } from './conversation'
import { pickOrStub } from './testPickers'
import type { CanvasStore } from '../shared/contract'

/** Messages read from the end of a transcript, to find the last reply without reading it all. */
const TAIL = 30

/** An agent's latest answer: its last assistant message that says something, not a Codex note on the way. */
export function lastReplyOf(messages: TranscriptMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && !m.commentary && m.text.trim()) return m.text.trim()
  }
  return null
}

export type CopyReplyResult = { ok: true; chars: number } | { ok: false; reason: string }

/** Puts an agent's latest reply on the clipboard, as Markdown, as it wrote it. */
export async function copyLastReply(store: CanvasStore, nodeId: string, write: (text: string) => void, read = readMessagesTail): Promise<CopyReplyResult> {
  const node = store.get().nodes.find((n) => n.id === nodeId)
  if (node?.kind !== 'claude') return { ok: false, reason: 'That window is not an agent.' }
  if (!node.transcriptPath) return { ok: false, reason: `${node.title} has no conversation yet.` }
  const messages = await read(node.transcriptPath, TAIL).catch(() => null)
  if (!messages) return { ok: false, reason: `Couldn't read the conversation of ${node.title}.` }
  const reply = lastReplyOf(messages)
  if (!reply) return { ok: false, reason: `${node.title} hasn't replied yet.` }
  write(reply)
  return { ok: true, chars: reply.length }
}

/** pb:reply:copyLast, pb:reply:saveConversation and pb:reply:revealTranscript, for the app's own window only. */
export function serveLastReply(store: CanvasStore, isAppUi: (e: IpcMainInvokeEvent) => boolean): void {
  ipcMain.handle('pb:reply:copyLast', (e, nodeId: unknown) =>
    isAppUi(e) && typeof nodeId === 'string' ? copyLastReply(store, nodeId, (text) => clipboard.writeText(text)) : { ok: false, reason: 'Not allowed.' }
  )
  const saveConversation = createConversationSaver({
    store,
    home: homedir(),
    read: readAllMessages,
    writeFile: (p, text, exclusive) => writeFile(p, text, { encoding: 'utf8', flag: exclusive ? 'wx' : 'w' }),
    // Off-screen test and screenshot runs answer with PATCHBAY_TEST_SAVE_AS instead of opening the dialog (testPickers.ts).
    pickFile: (defaultPath) =>
      pickOrStub('save', async () => {
        const options: Electron.SaveDialogOptions = { title: 'Save the conversation', defaultPath, filters: [{ name: 'Markdown', extensions: ['md'] }] }
        const win = BrowserWindow.getFocusedWindow()
        const r = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
        return r.canceled || !r.filePath ? null : r.filePath
      })
  })
  ipcMain.handle('pb:reply:saveConversation', (e, nodeId: unknown) => (isAppUi(e) && typeof nodeId === 'string' ? saveConversation(nodeId) : { ok: false, reason: 'Not allowed.' }))
  ipcMain.handle('pb:reply:revealTranscript', (e, nodeId: unknown) =>
    isAppUi(e) && typeof nodeId === 'string' ? revealTranscript(store, nodeId, (p) => shell.showItemInFolder(p), existsSync) : { ok: false, reason: 'Not allowed.' }
  )
}
