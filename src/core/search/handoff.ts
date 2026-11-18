import { isAbsolute, relative, resolve } from 'node:path'
import { AGENT_NAMES, type AgentKind } from '../../shared/model'
import { stamp } from './handoffText'
import type { TranscriptEvent } from './transcriptEvents'
import type { Evidence, HandoffDraft, HandoffSection } from './types'

/**
 * Builds a handoff from a conversation's own record, with no AI call. Every line says where it came from, and what
 * couldn't be found or is out of date is marked as such rather than filled in.
 */

export interface HandoffInput {
  title: string
  agent: AgentKind
  cwd: string
  projectId?: string
  projectName?: string
  transcriptPath: string | null
  transcript: { events: TranscriptEvent[]; partialLastLine: boolean } | { missing: string }
  /** The source agent was still working, so its record may be about to change. */
  sourceBusy: boolean
  /** The repository's uncommitted files now, relative to its root, or why that isn't known. */
  git: { root: string; changed: string[] } | { unavailable: string }
  exists: (path: string) => boolean
  now: number
  /** Sections from registered evidence providers, such as a task's recorded outcome. */
  extra?: HandoffSection[]
}

const OBJECTIVE_CHARS = 2000
const REQUEST_CHARS = 300
const LINE_CHARS = 300
const LAST_MESSAGE_CHARS = 1500
const MAX_DECISIONS = 8
const MAX_CHECKS = 6
const MAX_OTHER_CHANGES = 20

const DECISION = /\b(decided|decision|chose|chosen|choosing|going with|go with|settled on|opted|instead of|we'll use|i'll use|i will use|rather than)\b/i
const CHECK = /\b(test|tests|vitest|jest|pytest|mocha|playwright|tsc|typecheck|type-check|lint|eslint|ruff|mypy|build|cargo (?:test|build|check|clippy)|go (?:test|build|vet)|dotnet (?:test|build)|gradle|mvn|make|ctest|acceptance)\b/i
const REMAINING = /(\bto ?do\b|\bremaining\b|\bleft to\b|\bleft out\b|\bnext steps?\b|\bnot yet\b|\bstill (?:need|to|missing|fails?|failing|broken)\b|\bfollow[- ]up\b|\bout of scope\b|\bdidn't\b|\bdid not\b|\bcouldn't\b|\bcould not\b|\bblocked\b|\bknown (?:issue|failure)\b|\bunfinished\b|\bpending\b|^\s*[-*] \[ \])/i

const short = (text: string, max: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}
const when = (at: number | undefined): string => (at === undefined ? '' : ` (${stamp(at)})`)
const missing = (what: string): string => `[Missing: ${what}]`
const stale = (what: string): string => `[Stale: ${what}]`
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** Splits prose into sentences and lines, for picking out the ones that state a decision or what's left. */
function sentences(text: string): string[] {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 12)
}

function section(id: string, title: string, text: string, evidence: Evidence, note?: string): HandoffSection {
  return { id, title, text, evidence, ...(note ? { note } : {}) }
}

export function buildHandoff(input: HandoffInput): HandoffDraft {
  const read = 'events' in input.transcript ? input.transcript : null
  const events = read?.events ?? []
  const messages = events.filter((e): e is Extract<TranscriptEvent, { kind: 'message' }> => e.kind === 'message')
  const edits = events.filter((e): e is Extract<TranscriptEvent, { kind: 'edit' }> => e.kind === 'edit')
  const commands = events.filter((e): e is Extract<TranscriptEvent, { kind: 'command' }> => e.kind === 'command')
  const noTranscript = read ? null : missing(`the transcript could not be read (${(input.transcript as { missing: string }).missing}).`)
  const sections: HandoffSection[] = []

  // Objective: what the conversation was started with, and what was asked later.
  const asks = messages.filter((m) => m.role === 'user')
  if (asks.length === 0) {
    sections.push(section('objective', 'Objective', noTranscript ?? missing('the conversation has no message asking for anything.'), 'missing'))
  } else {
    const first = asks[0].text.trim()
    const later = asks.slice(1).slice(-3)
    const text = [
      `First message${when(asks[0].at)}:`,
      first.length > OBJECTIVE_CHARS ? `${first.slice(0, OBJECTIVE_CHARS)}…` : first,
      ...(later.length ? ['', 'Later requests:', ...later.map((m) => `- ${short(m.text, REQUEST_CHARS)}${when(m.at)}`)] : [])
    ].join('\n')
    sections.push(section('objective', 'Objective', text, 'found', 'quoted from the conversation'))
  }

  // Decisions: what the agent said it decided.
  const decided: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant') continue
    for (const s of sentences(m.text)) {
      const line = `- ${short(s, LINE_CHARS)}${when(m.at)}`
      if (DECISION.test(s) && !decided.includes(line)) decided.push(line)
    }
  }
  sections.push(
    decided.length
      ? section('decisions', 'Decisions', decided.slice(-MAX_DECISIONS).join('\n'), 'found', 'sentences quoted from the agent')
      : section('decisions', 'Decisions', noTranscript ?? missing('no decision was stated in the conversation.'), 'missing')
  )

  // Changed files: what the agent edited, checked against the disk and git now.
  const root = 'root' in input.git ? input.git.root : null
  const uncommitted = new Set('changed' in input.git ? input.git.changed.map((p) => fold(p.replace(/\\/g, '/'))) : [])
  const abs = (p: string): string => (isAbsolute(p) ? p : resolve(input.cwd, p))
  const shown = (p: string): string => {
    const rel = relative(input.cwd, abs(p))
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? abs(p) : rel.replace(/\\/g, '/')
  }
  const inRepo = (p: string): string | null => {
    if (!root) return null
    const rel = relative(root, abs(p))
    return !rel || rel.startsWith('..') || isAbsolute(rel) ? null : fold(rel.replace(/\\/g, '/'))
  }
  const lastEdit = new Map<string, { path: string; at?: number; count: number }>()
  for (const e of edits) {
    const key = fold(abs(e.path))
    const before = lastEdit.get(key)
    lastEdit.delete(key)
    lastEdit.set(key, { path: e.path, at: e.at ?? before?.at, count: (before?.count ?? 0) + 1 })
  }
  if (lastEdit.size === 0) {
    sections.push(section('changed', 'Changed files', noTranscript ?? missing('the conversation records no file edits.'), 'missing'))
  } else {
    let gone = 0
    const lines = [...lastEdit.values()].map((f) => {
      const notes: string[] = []
      if (!input.exists(abs(f.path))) {
        gone++
        notes.push(stale('missing on disk now'))
      } else if (root) {
        const rel = inRepo(f.path)
        notes.push(rel === null ? 'outside the repository' : uncommitted.has(rel) ? 'uncommitted change now' : 'no uncommitted change now (committed or undone)')
      }
      return `- ${shown(f.path)} (edited ${f.count === 1 ? 'once' : `${f.count} times`}${f.at !== undefined ? `, last ${stamp(f.at)}` : ''})${notes.length ? ` — ${notes.join('; ')}` : ''}`
    })
    const touched = new Set([...lastEdit.values()].map((f) => inRepo(f.path)).filter((p): p is string => p !== null))
    const others = 'changed' in input.git ? input.git.changed.filter((p) => !touched.has(fold(p.replace(/\\/g, '/')))) : []
    const text = [
      ...lines,
      ...(others.length ? ['', `Also uncommitted in ${root} now, not edited in this conversation:`, ...others.slice(0, MAX_OTHER_CHANGES).map((p) => `- ${p}`), ...(others.length > MAX_OTHER_CHANGES ? [`- and ${others.length - MAX_OTHER_CHANGES} more`] : [])] : []),
      ...('unavailable' in input.git ? ['', `Git status unavailable: ${input.git.unavailable}`] : [])
    ].join('\n')
    sections.push(section('changed', 'Changed files', text, gone ? 'stale' : 'found', gone ? `${gone} file${gone === 1 ? '' : 's'} missing now` : 'from the agent\'s edits, checked now'))
  }

  // Verification: checks the agent ran, and whether files changed after them.
  const checks = commands.filter((c) => CHECK.test(c.command))
  const lastEditAt = edits.reduce<number | undefined>((m, e) => (e.at !== undefined && (m === undefined || e.at > m) ? e.at : m), undefined)
  if (checks.length === 0) {
    sections.push(section('verification', 'Verification', noTranscript ?? missing('no test, build, typecheck or lint command was found in the conversation.'), 'missing'))
  } else {
    const ranBeforeEdit = (c: { at?: number }): boolean => lastEditAt !== undefined && c.at !== undefined && c.at < lastEditAt
    const lines = checks.slice(-MAX_CHECKS).map((c) => {
      const outcome = c.ok === true ? 'passed' : c.ok === false ? 'failed' : 'outcome not recorded'
      const detail = c.ok === false && c.output ? `\n  Output ends: ${short(c.output.split('\n').slice(-3).join(' '), 200)}` : ''
      return `- \`${short(c.command, 200)}\`: ${outcome}${when(c.at)}${ranBeforeEdit(c) ? ` ${stale('files were edited after this ran')}` : ''}${detail}`
    })
    const latest = checks[checks.length - 1]
    const evidence: Evidence = ranBeforeEdit(latest) ? 'stale' : latest.ok === null ? 'partial' : 'found'
    const note = evidence === 'stale' ? 'files changed after the last check' : evidence === 'partial' ? 'last outcome not recorded' : `last check ${latest.ok ? 'passed' : 'failed'}`
    sections.push(section('verification', 'Verification', lines.join('\n'), evidence, note))
  }

  // Remaining work: what the agent's last message says is left.
  const lastReply = [...messages].reverse().find((m) => m.role === 'assistant')
  if (!lastReply) {
    sections.push(section('remaining', 'Remaining work', noTranscript ?? missing('the agent has not replied yet.'), 'missing'))
  } else {
    const left = lastReply.text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && REMAINING.test(l))
      .map((l) => (l.startsWith('-') || l.startsWith('*') ? l : `- ${l}`))
    if (left.length) {
      sections.push(section('remaining', 'Remaining work', [`From the agent's last message${when(lastReply.at)}:`, ...left.map((l) => short(l, LINE_CHARS))].join('\n'), 'found', 'lines quoted from the last message'))
    } else {
      const quoted = lastReply.text.trim()
      const text = [missing('the agent did not say what is left.'), '', `Its last message${when(lastReply.at)}, quoted:`, quoted.length > LAST_MESSAGE_CHARS ? `…${quoted.slice(-LAST_MESSAGE_CHARS)}` : quoted].join('\n')
      sections.push(section('remaining', 'Remaining work', text, 'partial', 'nothing stated; last message quoted'))
    }
  }

  // Sources: where all of this came from.
  const lastAt = messages.reduce<number | undefined>((m, e) => (e.at !== undefined && (m === undefined || e.at > m) ? e.at : m), undefined)
  const sourceLines = [
    `- Conversation: "${input.title}" (${AGENT_NAMES[input.agent]})${input.projectName ? `, project ${input.projectName}` : ''}`,
    `- Folder: ${input.cwd}`,
    input.transcriptPath ? `- Transcript: ${input.transcriptPath}${read ? ` (${messages.length} messages${lastAt !== undefined ? `, last ${stamp(lastAt)}` : ''})` : ''}` : `- Transcript: ${missing('this conversation has no transcript yet.')}`,
    `- Extracted ${stamp(input.now)}, without AI.`,
    ...(noTranscript ? [`- ${noTranscript}`] : []),
    ...(read?.partialLastLine ? ['- The transcript\'s last line was still being written, so it was left out.'] : []),
    ...(input.sourceBusy ? [`- ${stale('the source agent was still working when this was extracted, so it may have done more since.')}`] : [])
  ]
  const sourceEvidence: Evidence = noTranscript || !input.transcriptPath ? 'missing' : input.sourceBusy ? 'stale' : 'found'
  sections.push(section('sources', 'Sources', sourceLines.join('\n'), sourceEvidence, input.sourceBusy ? 'source still working' : undefined))

  // Extra sections go before Sources, so the references stay last.
  if (input.extra?.length) sections.splice(sections.length - 1, 0, ...input.extra)

  return { sourceTitle: input.title, agent: input.agent, cwd: input.cwd, builtAt: input.now, sections, ...(input.projectId ? { projectId: input.projectId } : {}) }
}
