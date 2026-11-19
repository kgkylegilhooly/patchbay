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
/** Programs whose only job is checking code. */
const RUNNERS = new Set(['vitest', 'jest', 'pytest', 'mocha', 'playwright', 'tsc', 'eslint', 'ruff', 'mypy', 'ctest', 'phpunit', 'rspec', 'tox', 'nox'])
/** Script and task names that run checks, for npm run, make, gradle and the like. */
const CHECK_SCRIPT = /^(test|tests|check|checks|lint|typecheck|type-check|types|build|verify|ci|e2e|acceptance|spec)\b|[:._-](test|tests|check|lint|typecheck|build|e2e|acceptance)\b/i
/** A script run by node that is itself a test, as test/acceptance/*.cjs. */
const TEST_SCRIPT = /(^|[\\/])(test|tests|spec|__tests__)[\\/]|\.(test|spec)\.[cm]?[jt]sx?$/i
const SUBCOMMANDS: Record<string, RegExp> = {
  cargo: /^(test|build|check|clippy|nextest)$/,
  go: /^(test|build|vet)$/,
  dotnet: /^(test|build)$/
}

/**
 * Whether a command runs a check: a test runner, a type checker, a linter or a build. It looks at what each part of a
 * command line runs, not at words anywhere in it, so `git diff -- test/a.test.ts` or `cat tests.md` don't count.
 */
export function isCheckCommand(command: string): boolean {
  return command.split(/&&|\|\||;|\||\n/).some((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean)
    // What runs the program rather than being it: settings, timers and shells' call words.
    while (words.length && (/^\w+=/.test(words[0]) || /^(time|call|&|exec|env|command)$/i.test(words[0]) || (/^timeout$/i.test(words[0]) && /^\d+[smh]?$/.test(words[1] ?? '')))) {
      words.shift()
      if (/^\d+[smh]?$/.test(words[0] ?? '') && words.length > 1) words.shift()
    }
    const name = (w: string | undefined): string => (w ?? '').replace(/^["']|["']$/g, '').split(/[\\/]/).pop()!.replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase()
    let program = name(words[0])
    let args = words.slice(1).filter((w) => !w.startsWith('-'))
    if (program === 'npx' || program === 'pnpx' || program === 'bunx' || (program === 'pnpm' && args[0] === 'exec') || (program === 'yarn' && args[0] === 'dlx')) {
      if (program === 'pnpm' || program === 'yarn') args = args.slice(1)
      program = name(args[0])
      args = args.slice(1)
    }
    if ((program === 'python' || program === 'python3' || program === 'py') && words.includes('-m')) {
      const module = words[words.indexOf('-m') + 1] ?? ''
      return RUNNERS.has(module) || module === 'unittest'
    }
    if (RUNNERS.has(program)) return true
    if (SUBCOMMANDS[program]) return SUBCOMMANDS[program].test(args[0] ?? '')
    if (program === 'npm' || program === 'pnpm' || program === 'yarn' || program === 'bun') {
      if (args[0] === 'test' || args[0] === 't') return true
      if (args[0] === 'run' || args[0] === 'run-script') return CHECK_SCRIPT.test(args[1] ?? '')
      return program !== 'npm' && CHECK_SCRIPT.test(args[0] ?? '')
    }
    if (program === 'make' || program === 'gradle' || program === 'gradlew' || program === 'mvn' || program === 'mvnw') return args.length === 0 ? program === 'make' : args.some((a) => CHECK_SCRIPT.test(a))
    if (program === 'node') return TEST_SCRIPT.test(args[0] ?? '')
    return false
  })
}
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
  // Each file's edits by outcome. Only an edit whose result says it was made is a change; one with no result may or
  // may not have happened, and a failed one didn't.
  const files = new Map<string, { path: string; at?: number; made: number; unknown: number; failed: number }>()
  for (const e of edits) {
    const key = fold(abs(e.path))
    const before = files.get(key) ?? { path: e.path, made: 0, unknown: 0, failed: 0 }
    files.delete(key)
    const at = e.ok !== false ? (e.at ?? before.at) : before.at
    files.set(key, { ...before, path: e.path, ...(at !== undefined ? { at } : {}), made: before.made + (e.ok === true ? 1 : 0), unknown: before.unknown + (e.ok === null ? 1 : 0), failed: before.failed + (e.ok === false ? 1 : 0) })
  }
  const changed = [...files.values()].filter((f) => f.made || f.unknown)
  const failedOnly = [...files.values()].filter((f) => !f.made && !f.unknown)
  const failedLines = failedOnly.length ? ['', 'Tried but failed, so not changed by these attempts:', ...failedOnly.map((f) => `- ${shown(f.path)} (${f.failed === 1 ? 'once' : `${f.failed} times`})`)] : []
  if (changed.length === 0) {
    const text = noTranscript ?? [missing('the conversation records no completed file edits.'), ...failedLines].join('\n')
    sections.push(section('changed', 'Changed files', text, 'missing'))
  } else {
    let gone = 0
    let unconfirmed = 0
    const lines = changed.map((f) => {
      const notes: string[] = []
      if (!input.exists(abs(f.path))) {
        gone++
        notes.push(stale('missing on disk now'))
      } else if (root) {
        const rel = inRepo(f.path)
        notes.push(rel === null ? 'outside the repository' : uncommitted.has(rel) ? 'uncommitted change now' : 'no uncommitted change now (committed or undone)')
      }
      const times = (n: number): string => (n === 1 ? 'once' : `${n} times`)
      let what: string
      if (f.made) what = `edited ${times(f.made)}${f.unknown ? `, and tried ${times(f.unknown)} with no recorded outcome` : ''}`
      else {
        unconfirmed++
        what = `edit tried ${times(f.unknown)}, outcome not recorded`
      }
      return `- ${shown(f.path)} (${what}${f.at !== undefined ? `, last ${stamp(f.at)}` : ''})${notes.length ? ` — ${notes.join('; ')}` : ''}`
    })
    const touched = new Set(changed.map((f) => inRepo(f.path)).filter((p): p is string => p !== null))
    const others = 'changed' in input.git ? input.git.changed.filter((p) => !touched.has(fold(p.replace(/\\/g, '/')))) : []
    const text = [
      ...lines,
      ...failedLines,
      ...(others.length ? ['', `Also uncommitted in ${root} now, not edited in this conversation:`, ...others.slice(0, MAX_OTHER_CHANGES).map((p) => `- ${p}`), ...(others.length > MAX_OTHER_CHANGES ? [`- and ${others.length - MAX_OTHER_CHANGES} more`] : [])] : []),
      ...('unavailable' in input.git ? ['', `Git status unavailable: ${input.git.unavailable}`] : [])
    ].join('\n')
    const evidence: Evidence = gone ? 'stale' : unconfirmed ? 'partial' : 'found'
    const note = gone ? `${gone} file${gone === 1 ? '' : 's'} missing now` : unconfirmed ? `${unconfirmed} edit${unconfirmed === 1 ? '' : 's'} with no recorded outcome` : 'from the agent\'s edits, checked now'
    sections.push(section('changed', 'Changed files', text, evidence, note))
  }

  // Verification: checks the agent ran, and whether files changed after them.
  const checks = commands.filter((c) => isCheckCommand(c.command))
  // An edit that may have happened makes a check before it stale too; only a failed one doesn't.
  const lastEditAt = edits.reduce<number | undefined>((m, e) => (e.ok !== false && e.at !== undefined && (m === undefined || e.at > m) ? e.at : m), undefined)
  if (checks.length === 0) {
    sections.push(section('verification', 'Verification', noTranscript ?? missing('no test, build, typecheck or lint command was found in the conversation.'), 'missing'))
  } else {
    const ranBeforeEdit = (c: { at?: number }): boolean => lastEditAt !== undefined && c.at !== undefined && c.at < lastEditAt
    const lines = checks.slice(-MAX_CHECKS).map((c) => {
      const outcome = c.ok === true ? 'passed' : c.ok === false ? 'failed' : c.background ? 'ran in the background; no outcome recorded' : 'outcome not recorded'
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
