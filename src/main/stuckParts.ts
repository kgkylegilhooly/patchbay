/**
 * Plain words for which part of Patchbay stopped or got stuck, and what fixes it. Patchbay is several processes (see
 * docs/plans/responsiveness.md): the window's page draws the whole canvas, the main process passes it input and data,
 * the graphics process puts its frames on screen, each browser node's page runs in a process of its own, and the
 * terminals and agents run in the session host, apart from all of them.
 */

export interface GoneDetails {
  type: string
  reason: string
  exitCode: number
  name?: string
  serviceName?: string
}

/** A log line for a Chromium helper process that ended other than cleanly. */
export function processGoneText(d: GoneDetails): string {
  const how = `${d.reason}, exit code ${d.exitCode}`
  if (d.type === 'GPU') {
    return `The graphics process stopped (${how}). It starts again by itself and the window redraws; if the window stays blank, reload it. Terminals and agents were not affected.`
  }
  if (d.type === 'Utility') {
    const what = d.name || d.serviceName || 'helper'
    return `A helper process (${what}) stopped (${how}). It starts again when it's next needed. Terminals and agents were not affected.`
  }
  return `A ${d.type} process stopped (${how}).`
}

/** Below either of these, Windows is short of memory and everything on the PC gets slow to answer. */
const LOW_FREE_MB = 700
const LOW_FREE_SHARE = 0.08

/** A sentence about the PC being short of memory, or null when it isn't. */
export function lowMemoryNote(freeBytes: number, totalBytes: number): string | null {
  const freeMb = Math.round(freeBytes / 1024 / 1024)
  if (freeMb >= LOW_FREE_MB && freeBytes / totalBytes >= LOW_FREE_SHARE) return null
  return `Windows has only ${freeMb} MB of memory free, which makes every program slow to answer. Closing windows you don't need, in Patchbay or elsewhere, helps.`
}

/** What the "window isn't responding" dialog says. */
export function hungWindowDetail(memoryNote: string | null): string {
  const lines = [
    "The canvas is drawn by one page, and that page is busy: every node on it waits for it. Your terminals and agents are safe: they keep running in the background.",
    'Reloading the window brings the canvas back as it was.'
  ]
  if (memoryNote) lines.push(memoryNote)
  return lines.join('\n\n')
}

/** The notice on a browser node whose page stopped answering. */
export const HUNG_PAGE_NOTICE = "This page isn't responding. Only this browser node is affected. Reload it to start the page again."
