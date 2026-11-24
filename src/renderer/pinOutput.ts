/**
 * Pinning a terminal's selected output to a note, so an error, a URL or a summary doesn't scroll away. The note says
 * where and when it came from, and holds the text as a code block. See useCommands' pinSelection.
 */

/** Longer than any run of backticks in the text, so the text can't end the block early. */
function fenceFor(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  return '`'.repeat(Math.max(3, longest + 1))
}

/** The note's text: a line saying where it's from, then the selection as it was, trailing blank lines trimmed. */
export function pinnedNoteText(source: string, selection: string, at: Date): string {
  const body = selection.replace(/\r\n?/g, '\n').replace(/\s+$/, '')
  const fence = fenceFor(body)
  const when = at.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return `From **${source.replace(/[*_`]/g, '')}**, ${when}:\n\n${fence}\n${body}\n${fence}\n`
}

/** Nothing worth pinning: an empty or blank selection. */
export const worthPinning = (selection: string | undefined): selection is string => !!selection && selection.trim().length > 0
