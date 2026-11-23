/**
 * Problems with the app itself rather than any one window: the canvas can't be saved, or the background session host
 * stopped. They were native dialogs, and the save one held up the whole app while it was open. Now they're banners in
 * the window, which clear when the problem does. See docs/plans/r3-content.md.
 */

export interface SaveProblem {
  /** Where the canvas is saved. */
  dir: string
  /** The last error, as the file system put it. */
  error: string
  since: number
}

export interface HostLostProblem {
  at: number
  /** Bring them back is under way. */
  bringing: boolean
  /** Bring them back failed, and why. */
  error: string | null
}

export interface AppProblems {
  save: SaveProblem | null
  hostLost: HostLostProblem | null
}

export const NO_PROBLEMS: AppProblems = { save: null, hostLost: null }

/** How often a failed save is tried again while nothing changes. Each change tries again as well. */
export const SAVE_RETRY_MS = 5_000

/** window.patchbayProblems. Served in src/main/appProblems.ts. */
export interface AppProblemsBridge {
  get(): Promise<AppProblems>
  /** Starts a new host and brings back the sessions that ended with the old one. */
  bringBackHost(): Promise<void>
  dismissHostLost(): Promise<void>
  onChange(cb: (problems: AppProblems) => void): () => void
}

const SAVE_REASONS: Record<string, string> = {
  EPERM: "the file or folder is read-only, or Patchbay isn't allowed to write there",
  EACCES: "Patchbay isn't allowed to write there",
  ENOSPC: 'the disk is full',
  EBUSY: 'another program has the file open',
  EROFS: 'the drive is read-only',
  ENOENT: 'the folder is gone'
}

/** Why a save failed, in plain words, with the file system's code: "the disk is full (ENOSPC)". */
export function saveReason(e: unknown): string {
  const code = (e as { code?: unknown })?.code
  if (typeof code === 'string' && SAVE_REASONS[code]) return `${SAVE_REASONS[code]} (${code})`
  // Node puts the paths after the first comma: "EPERM: operation not permitted, rename 'a' -> 'b'".
  return shortError(e).split(', ')[0]
}

/** The first line of an error, short enough for a banner. */
export function shortError(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  const first = text.split(/\r?\n/)[0].trim()
  return first.length > 160 ? `${first.slice(0, 157)}…` : first
}
