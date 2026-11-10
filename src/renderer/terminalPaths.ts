export interface PathMatch {
  path: string
  /** Range in the line, including any :line:col suffix. */
  start: number
  end: number
}

const URL = /\b[a-z][a-z0-9+.-]+:\/\/\S+/gi
const QUOTED = /"([^"\r\n]+)"|'([^'\r\n]+)'/g
// A drive path may have spaces in its folders, but its last segment stops at whitespace.
const WINDOWS = /[A-Za-z]:[\\/](?:[^\\/:*?"'<>|\r\n]+[\\/])*[^\s\\/:*?"'<>|\r\n]+/g
const RELATIVE = /(?:\.{1,2}[\\/]|[\w@.-]+[\\/])(?:[\w@.-]+[\\/])*[\w@.-]+/g
// Git Bash's /c/Users/..., and ~/... . Not after a letter or dot, so and/or and a/b stay relative.
const POSIX = /(?<![\w.~/\\-])~?\/(?:[\w@.-]+\/)*[\w@.-]+/g
const SUFFIX = /^(?::\d+){1,2}|^\(\d+,\d+\)/
const HAS_EXTENSION = /\.[A-Za-z]\w*$/

function isDrivePath(s: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(s)
}

function isRelativePath(s: string): boolean {
  if (/\s/.test(s) && !/[\\/]/.test(s)) return false
  if (!/[\\/]/.test(s)) return false
  return /^\.{1,2}[\\/]/.test(s) || HAS_EXTENSION.test(s)
}

/** A slash command like /help is not a path, so only a drive folder or a file with an extension counts. */
function isPosixPath(s: string): boolean {
  return /^~\//.test(s) || /^\/[A-Za-z]\/./.test(s) || (HAS_EXTENSION.test(s) && /^\/[\w@.-]+\//.test(s))
}

function mask(line: string, start: number, end: number): string {
  return line.slice(0, start) + ' '.repeat(end - start) + line.slice(end)
}

function trimEnd(s: string): string {
  return s.replace(/[.,;:!?)\]]+$/, '')
}

/** Every file path in a line of terminal output, in order. Web links are not paths. */
export function findTerminalPathMatches(line: string): PathMatch[] {
  const found: PathMatch[] = []
  let rest = line

  const take = (start: number, raw: string): void => {
    const path = trimEnd(raw)
    let end = start + path.length
    const suffix = SUFFIX.exec(line.slice(end))
    if (suffix) end += suffix[0].length
    found.push({ path, start, end })
    rest = mask(rest, start, Math.max(end, start + raw.length))
  }

  for (const m of line.matchAll(URL)) rest = mask(rest, m.index, m.index + m[0].length)

  for (const m of rest.matchAll(QUOTED)) {
    const inner = m[1] ?? m[2]
    if (isDrivePath(inner) || isRelativePath(inner)) take(m.index + 1, inner)
  }
  for (const m of rest.matchAll(WINDOWS)) take(m.index, m[0])
  for (const m of rest.matchAll(POSIX)) {
    if (isPosixPath(trimEnd(m[0]))) take(m.index, m[0])
  }
  for (const m of rest.matchAll(RELATIVE)) {
    const path = trimEnd(m[0])
    if (isRelativePath(path)) take(m.index, m[0])
  }
  return found.sort((a, b) => a.start - b.start)
}

export function findTerminalPaths(line: string): string[] {
  return findTerminalPathMatches(line).map((m) => m.path)
}
