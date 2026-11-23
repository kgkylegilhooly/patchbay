/**
 * Semantic zoom for node headers. Zoomed out, a header stops shrinking with the canvas and becomes a readable tile:
 * the title, the status word and the one badge you'd zoom in to read. The parts here are pure, so they can be tested
 * without a window. ZoomTierWatcher puts them on the page.
 */

/** near: the full header. far: a readable tile. overview: the tile, and the body becomes a flat status fill. */
export type ZoomTier = 'near' | 'far' | 'overview'

/**
 * Below this zoom a header turns into a tile. Above it a 13 px terminal still draws at 8 px or more and is worth
 * reading, so the window is left as it is, even though its header text is already small.
 */
export const FAR_BELOW = 0.6
/** Below this, a terminal's text is a texture, so the body shows its status colour instead. */
export const OVERVIEW_BELOW = 0.35
/** How far past a line the zoom must go to cross back, so a wheel zoom resting on the line doesn't flicker. */
export const HYSTERESIS = 0.04
/** The most a header is drawn larger than its canvas size: past this it would fill a small node. */
export const MAX_HEAD_SCALE = 3.5

function tierAt(zoom: number): ZoomTier {
  return zoom < OVERVIEW_BELOW ? 'overview' : zoom < FAR_BELOW ? 'far' : 'near'
}

const ORDER: Record<ZoomTier, number> = { near: 0, far: 1, overview: 2 }

/** The tier at `zoom`, coming from `prev`. Moving further out switches at the line; coming back needs the margin. */
export function nextTier(prev: ZoomTier | null, zoom: number): ZoomTier {
  const plain = tierAt(zoom)
  if (!prev || ORDER[plain] >= ORDER[prev]) return plain
  // Zooming in: only leave a tier once past its line by the margin.
  return tierAt(zoom - HYSTERESIS)
}

/**
 * Near, a header's text is drawn no smaller than it would be at this zoom. Below it the header strip grows (its slot
 * in the window doesn't, so the body keeps its size), which keeps titles and status words at about 11 px down to the
 * far line, where the tile takes over.
 */
export const NEAR_READABLE = 0.85

/** How much larger than its canvas size a header draws, so its text keeps about its real size on screen. */
export function headScale(zoom: number, tier: ZoomTier): number {
  if (!(zoom > 0)) return 1
  const want = tier === 'near' ? NEAR_READABLE / zoom : 1 / zoom
  // Quantized, so a wheel zoom re-lays the headers out a few times rather than on every frame.
  return Math.round(Math.min(MAX_HEAD_SCALE, Math.max(1, want)) * 20) / 20
}

/** The one thing a far header shows beside the status word. Tones: needs (red), warn (amber), plain. */
export interface KeyBadge {
  text: string
  tone: 'needs' | 'warn' | 'plain'
  title?: string
}

export interface KeyBadgeInput {
  approval?: { tool: string; summary: string } | null
  context?: { text: string; level: 'ok' | 'warn' | 'high' | string } | null
  folder?: string
}

/**
 * Picks the badge: what's being asked first, since that's what you came for, then a context nearly full, then the
 * folder when it isn't the project's own. Nothing when none of these apply. A run's state is its status word.
 */
export function keyBadge(input: KeyBadgeInput): KeyBadge | null {
  if (input.approval) {
    const text = `${input.approval.tool}: ${input.approval.summary}`
    return { text, tone: 'needs', title: text }
  }
  if (input.context && input.context.level !== 'ok') return { text: input.context.text, tone: 'warn' }
  if (input.folder) return { text: input.folder, tone: 'plain' }
  return null
}

const segments = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)

/**
 * The folder a header shows: nothing when the session runs in the project's own folder, since every header would
 * repeat it, and otherwise the folder's own name rather than the tail of its path. `ssh host` is kept as it is.
 */
export function headerFolder(where: string, projectFolder: string | null | undefined): string {
  if (!where) return ''
  if (where.startsWith('ssh ')) return where
  const segs = segments(where)
  if (projectFolder) {
    const base = segments(projectFolder)
    const same = segs.length === base.length && segs.every((s, i) => s.toLowerCase() === base[i].toLowerCase())
    if (same) return ''
  }
  return segs[segs.length - 1] ?? where
}
