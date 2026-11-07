import type { GithubIssue, GithubPr } from '../../shared/git'
import { runProgram, type RunResult } from '../git/run'

/**
 * GitHub through the `gh` CLI, signed in by the owner. Patchbay never stores a token. Reads and writes are separate
 * functions, and only the IPC handler behind the owner's confirm calls a write.
 */

export const REPO_SLUG = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/

/** owner/name from a github.com remote, in any of the usual forms. */
export function repoFromRemote(url: string): string | null {
  const m = /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim())
  if (!m) return null
  const slug = `${m[1]}/${m[2]}`
  return REPO_SLUG.test(slug) ? slug : null
}

const ISSUE_FIELDS = 'number,title,body,state,url,author,labels,updatedAt'
const PR_FIELDS = 'number,title,state,url,author,headRefName,isDraft,updatedAt'

export function issueListArgs(repo: string, state: 'open' | 'closed' | 'all' = 'open', limit = 100): string[] {
  return ['issue', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', ISSUE_FIELDS]
}

export function issueViewArgs(repo: string, n: number): string[] {
  return ['issue', 'view', String(n), '--repo', repo, '--json', ISSUE_FIELDS]
}

export function prListArgs(repo: string, state: 'open' | 'closed' | 'merged' | 'all' = 'open', limit = 50): string[] {
  return ['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit), '--json', PR_FIELDS]
}

/** The only writes there are. Each runs from one click of the owner's, after a confirm naming it. */
export function issueWriteArgs(repo: string, n: number, action: { kind: 'close' } | { kind: 'reopen' } | { kind: 'comment'; body: string }): string[] {
  if (action.kind === 'comment') return ['issue', 'comment', String(n), '--repo', repo, '--body', action.body]
  return ['issue', action.kind, String(n), '--repo', repo]
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

function toIssue(raw: unknown): GithubIssue | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r.number !== 'number' || !Number.isInteger(r.number) || r.number < 1) return null
  const author = (r.author as { login?: unknown } | null)?.login
  const labels = Array.isArray(r.labels) ? r.labels.map((l) => str((l as { name?: unknown })?.name, 50)).filter(Boolean) : []
  return {
    number: r.number,
    title: str(r.title, 300),
    body: str(r.body, 100000),
    state: r.state === 'CLOSED' ? 'CLOSED' : 'OPEN',
    url: str(r.url, 300),
    author: str(author, 100),
    labels,
    updatedAt: str(r.updatedAt, 40)
  }
}

export function parseIssues(text: string): GithubIssue[] {
  const data = JSON.parse(text) as unknown
  const list = Array.isArray(data) ? data : [data]
  return list.map(toIssue).filter((i): i is GithubIssue => i !== null)
}

export function parsePrs(text: string): GithubPr[] {
  const data = JSON.parse(text) as unknown
  if (!Array.isArray(data)) return []
  return data.flatMap((raw): GithubPr[] => {
    const r = raw as Record<string, unknown>
    if (typeof r?.number !== 'number') return []
    return [{ number: r.number, title: str(r.title, 300), state: str(r.state, 20), url: str(r.url, 300), author: str((r.author as { login?: unknown } | null)?.login, 100), branch: str(r.headRefName, 200), draft: r.isDraft === true, updatedAt: str(r.updatedAt, 40) }]
  })
}

/** Only links to github.com pages may be opened from a card. */
export function isGithubPage(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && u.hostname === 'github.com'
  } catch {
    return false
  }
}

export type Gh = (args: string[]) => Promise<RunResult>

/**
 * The gh program, or another named in its place (main passes PATCHBAY_GH, which is how the acceptance runs use a
 * stand-in). A .cjs or .js one runs on node.
 */
export function systemGh(env: Record<string, string>, chosen = 'gh'): Gh {
  const viaNode = /\.(c?js|mjs)$/i.test(chosen)
  const ghEnv = { ...env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1', NO_COLOR: '1', CLICOLOR: '0' }
  return (args) => runProgram(viaNode ? 'node' : chosen, viaNode ? [chosen, ...args] : args, { env: ghEnv, timeoutMs: 30000, maxBytes: 8 * 1024 * 1024 })
}

export function ghFailure(r: RunResult): string {
  if (r.missing) return 'The GitHub CLI (gh) is not installed or not on PATH. Install it, run "gh auth login", then refresh.'
  if (r.timedOut) return 'gh took too long and was stopped.'
  const said = `${r.stderr}\n${r.stdout}`.trim() || `gh ended with code ${r.code}.`
  if (/gh auth login|not logged in|authentication/i.test(said)) return `gh is not signed in. Run "gh auth login" in a terminal, then refresh.\n\n${said}`
  return said
}
