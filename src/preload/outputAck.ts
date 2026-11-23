import { ipcRenderer } from 'electron'

/** Taken output is reported once this much more has come, so a slow trickle costs no messages back. */
const ACK_EVERY_CHARS = 256 * 1024

/**
 * Tells main how much terminal output this page has taken, so it can stop sending to a page that has fallen behind. It
 * counts on this window's own main thread, so a busy page stops counting. See src/main/outputPacer.ts.
 */
export function reportOutputTaken(): void {
  let taken = 0
  let reported = 0
  ipcRenderer.on('pb:onOutput', (_e, _id: unknown, data: unknown) => {
    if (typeof data !== 'string') return
    taken += data.length
    if (taken - reported < ACK_EVERY_CHARS) return
    reported = taken
    ipcRenderer.send('pb:outputAck', taken)
  })
}
