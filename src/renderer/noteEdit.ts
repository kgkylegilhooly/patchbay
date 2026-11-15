/**
 * What the note toolbar does to the text. Each returns one replacement, so the editor can apply it as a single
 * native edit and Ctrl+Z still undoes it.
 */

export interface TextEdit {
  /** The range of the old text to replace. */
  from: number
  to: number
  insert: string
  /** The selection afterwards, in the new text. */
  select: [number, number]
}

/** Wraps the selection in marks, as for bold, or takes them off again if it's already wrapped. */
export function wrap(text: string, from: number, to: number, mark: string, placeholder: string, close = mark): TextEdit {
  const inner = text.slice(from, to)
  if (text.slice(from - mark.length, from) === mark && text.slice(to, to + close.length) === close) {
    return { from: from - mark.length, to: to + close.length, insert: inner, select: [from - mark.length, to - mark.length] }
  }
  const body = inner || placeholder
  const start = from + mark.length
  return { from, to, insert: mark + body + close, select: [start, start + body.length] }
}

/** A link around the selection, with the address selected so it can be typed over. */
export function link(text: string, from: number, to: number): TextEdit {
  const label = text.slice(from, to) || 'link text'
  const url = 'https://'
  const at = from + label.length + 3
  return { from, to, insert: `[${label}](${url})`, select: [at, at + url.length] }
}

const lineStart = (text: string, at: number): number => text.lastIndexOf('\n', at - 1) + 1
const lineEnd = (text: string, at: number): number => {
  const i = text.indexOf('\n', at)
  return i < 0 ? text.length : i
}

/**
 * Starts every selected line with a prefix, as for a list or a quote, or takes it off if every line has it. A
 * different list or heading marker already on a line is swapped for the new one.
 */
export function prefixLines(text: string, from: number, to: number, prefix: string): TextEdit {
  const start = lineStart(text, from)
  const end = lineEnd(text, to > from && text[to - 1] === '\n' ? to - 1 : to)
  const lines = text.slice(start, end).split('\n')
  const marker = /^(\s*)(?:[-*+] \[[ xX]\] |[-*+] |\d+[.)] |#{1,6} |> )?/
  const has = lines.every((l) => l.startsWith(prefix) || (!l.trim() && lines.length > 1))
  const next = lines.map((l) => {
    if (!l.trim() && lines.length > 1) return l
    if (has) return l.slice(prefix.length)
    return l.replace(marker, (_, indent: string) => indent + prefix)
  })
  const insert = next.join('\n')
  // A single empty line keeps the caret after its new prefix, so typing carries on there.
  const select: [number, number] = lines.length === 1 && !lines[0].trim() ? [start + insert.length, start + insert.length] : [start, start + insert.length]
  return { from: start, to: end, insert, select }
}

/**
 * A fenced code block in the given language, on lines of its own. A selection goes inside it; with none, the caret
 * waits on the empty line in the middle.
 */
export function codeBlock(text: string, from: number, to: number, lang: string): TextEdit {
  const inner = text.slice(from, to).replace(/\n$/, '')
  const before = from > 0 && text[from - 1] !== '\n' ? '\n' : ''
  const after = to < text.length && text[to] !== '\n' ? '\n' : ''
  const fence = inner.includes('```') ? '~~~' : '```'
  const open = `${before}${fence}${lang}\n`
  const insert = `${open}${inner}\n${fence}${after}`
  const at = from + open.length
  return { from, to, insert, select: [at, at + inner.length] }
}

/** Two spaces at the caret, so Tab indents in a note instead of leaving it. */
export function indent(from: number, to: number): TextEdit {
  return { from, to, insert: '  ', select: [from + 2, from + 2] }
}

/** Agents' changes to one note since the person last kept or undid them: who made them, and the text before the first. */
export interface AgentNoteEdits {
  by: string[]
  before: string
  after: string
  at: number
}

/**
 * Adds an agent's change to those already showing on a note. Changes that follow on from each other are undone
 * together. One made after the note changed some other way, as when the person edited it, starts afresh.
 */
export function joinNoteEdit(shown: AgentNoteEdits | undefined, edit: { by: string; before: string; after: string; at: number }): AgentNoteEdits {
  if (shown && shown.after === edit.before) return { by: shown.by.includes(edit.by) ? shown.by : [...shown.by, edit.by], before: shown.before, after: edit.after, at: edit.at }
  return { by: [edit.by], before: edit.before, after: edit.after, at: edit.at }
}

const TASK = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+\[)([ xX])(\][ \t])/
const FENCE = /^[ \t]*(?:>[ \t]*)*(`{3,}|~{3,})/

/** Where each task box in the text is, in the order a render numbers them. Lines in code blocks don't count. */
function taskMarks(text: string): number[] {
  const marks: number[] = []
  let fence: string | null = null
  let at = 0
  for (const line of text.split('\n')) {
    const f = FENCE.exec(line)
    if (f) {
      if (fence === null) fence = f[1]
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null
    } else if (fence === null) {
      const m = TASK.exec(line)
      if (m) marks.push(at + m[1].length)
    }
    at += line.length + 1
  }
  return marks
}

/**
 * The text with one task box ticked or cleared. Null when the boxes found don't match the number the note shows,
 * because then the click can't be placed for certain and nothing should change.
 */
export function toggleTask(text: string, index: number, shown: number): string | null {
  const marks = taskMarks(text)
  if (marks.length !== shown || index < 0 || index >= marks.length) return null
  const at = marks[index]
  return text.slice(0, at) + (text[at] === ' ' ? 'x' : ' ') + text.slice(at + 1)
}
