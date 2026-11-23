/**
 * What the zoomed-out tiles of windows other than sessions say (zoom.css draws them). Pure, so it's tested without a
 * window. A note shows its title and its first lines; a trigger its schedule and when it next runs.
 */

/** A note's title until it's renamed. Such a note is told apart by its text, so the tile leads with that. */
const DEFAULT_NOTE_TITLE = 'Note'
/** More than a tile can show at its size; CSS clips what doesn't fit. */
const NOTE_LINES = 4
const LINE_CHARS = 120

/** One line of markdown as it reads: no heading marks, list bullets, task boxes, emphasis or link targets. */
export function plainLine(line: string): string {
  return line
    .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+(?:\[[ xX]\]\s+)?)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)(.+?)\1/g, '$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The lines of a note worth showing: not blank, not a code fence or a rule. */
function readableLines(text: string): string[] {
  const out: string[] = []
  let fenced = false
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fenced = !fenced
      continue
    }
    if (!fenced && /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) continue
    const line = fenced ? raw.trim() : plainLine(raw)
    if (line) out.push(line.length > LINE_CHARS ? `${line.slice(0, LINE_CHARS - 1)}…` : line)
    if (out.length > NOTE_LINES) break
  }
  return out
}

/**
 * A note's tile: its title, then its first lines. A note still called "Note" leads with its first line instead, as
 * that's what tells it apart. An empty note says so.
 */
export function noteTile(title: string, text: string): { title: string; lines: string[] } {
  const lines = readableLines(text)
  const named = title.trim() && title.trim() !== DEFAULT_NOTE_TITLE
  if (named) return { title: title.trim(), lines: lines.slice(0, NOTE_LINES) }
  if (lines.length) return { title: lines[0], lines: lines.slice(1, NOTE_LINES + 1) }
  return { title: title.trim() || DEFAULT_NOTE_TITLE, lines: ['Empty'] }
}

/** "in 4 s", "in 12 min": how soon. The same words as the trigger's own Next line (triggerView's relative). */
type Relative = (ms: number) => string

/**
 * A trigger tile's second line, beside its Armed chip: when it next runs if it's armed and that's known, then what it
 * waits for. The next run comes first, as a narrow tile cuts the end of the line. `schedule` is describeSchedule's
 * words.
 */
export function triggerTileLine(schedule: string, t: { armed: boolean; nextAt: number | null }, now: number, relative: Relative): string {
  const when = schedule.replace(/\.$/, '')
  if (!t.armed || t.nextAt === null) return when
  const soon = relative(Math.max(0, t.nextAt - now))
  return `${soon === 'now' ? 'Runs now' : `Next ${soon}`} · ${when}`
}
