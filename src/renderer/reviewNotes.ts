export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'meta'
  text: string
  /** The line's number in the old file, for removed and unchanged lines. */
  oldLine?: number
  /** The line's number in the new file, for added and unchanged lines. */
  newLine?: number
}

/** A unified diff, one entry per line, with each line's number in the file it belongs to. */
export function parseDiff(text: string): DiffLine[] {
  const out: DiffLine[] = []
  let oldAt = 0
  let newAt = 0
  let inHunk = false
  // The text's own final newline isn't a line.
  for (const line of text.replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldAt = Number(hunk[1])
      newAt = Number(hunk[2])
      inHunk = true
      out.push({ kind: 'hunk', text: line })
    } else if (!inHunk || line.startsWith('\\')) {
      out.push({ kind: 'meta', text: line })
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line, newLine: newAt++ })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line, oldLine: oldAt++ })
    } else if (line.startsWith(' ') || line === '') {
      out.push({ kind: 'context', text: line, oldLine: oldAt++, newLine: newAt++ })
    } else {
      out.push({ kind: 'meta', text: line })
    }
  }
  return out
}

export interface ReviewNote {
  id: string
  path: string
  /** Where it is: the new file's line, or the old file's for a removed line. */
  line: number
  side: 'new' | 'old'
  /** The diff line as shown, with its + or -. */
  code: string
  text: string
}

/** Notes can only go on lines that are in a file. */
export function noteTarget(line: DiffLine): { line: number; side: 'new' | 'old' } | null {
  if (line.kind === 'add' || line.kind === 'context') return { line: line.newLine!, side: 'new' }
  if (line.kind === 'del') return { line: line.oldLine!, side: 'old' }
  return null
}

/** One message with every note, grouped by file in the order they were written. */
export function formatReview(notes: ReviewNote[], repoName: string): string {
  const files = [...new Set(notes.map((n) => n.path))]
  const parts = [`Review of the changes in ${repoName}. Please address each note, then say what you changed.`]
  for (const path of files) {
    parts.push('', `${path}:`)
    for (const n of notes.filter((x) => x.path === path)) {
      const where = n.side === 'new' ? `line ${n.line}` : `removed line ${n.line} (old file)`
      parts.push(`- ${where}: \`${n.code.slice(0, 200).trim()}\``, `  ${n.text.trim().replace(/\n+/g, ' ')}`)
    }
  }
  return parts.join('\n')
}
