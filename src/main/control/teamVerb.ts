import { basename } from 'node:path'
import type { Git } from '../../core/git/service'
import type { CanvasStore, NodeMessage } from '../../shared/contract'
import type { AgentStop } from '../../shared/agentStop'
import { agentOf, type CanvasNode, type ClaudeNode } from '../../shared/model'
import type { StatusTracker } from '../sessions/statusTracker'
import { archivedRefusal } from './archived'
import { noGroup } from './gone'
import { RpcRefusal } from './server'
import { stoppedEntry } from './stopVerbs'
import type { Verbs } from './verbs'

export const TEAM_VERBS = ['team']

type Args = Record<string, unknown>

/** Each git call gets this long. A lead's overview mustn't stall on one slow checkout. */
const GIT_MS = 3000
/** How much of a report's first line is shown. The whole report is in the lead's own conversation. */
const REPORT_CHARS = 120

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

export interface Checkout {
  branch: string | null
  /** Commits on it that main (or master) doesn't have. Null when there's neither, or git couldn't say. */
  ahead: number | null
  base: string | null
  worktree: boolean
}

export interface TeamMember {
  id: string
  title: string
  agent: string
  status: string
  /** Seconds in that status, when known. */
  forSeconds?: number
  stopped?: string
  report?: { at: string; ago: string; firstLine: string }
  cwd: string
  checkout?: Checkout
}

/** One folder's branch, whether it's a linked worktree, and how far it's ahead of main. Two quick git calls. */
export async function readCheckout(git: Git, cwd: string): Promise<Checkout | undefined> {
  const limit = { timeoutMs: GIT_MS, maxBytes: 64 * 1024 }
  const where = await git(cwd, ['rev-parse', '--git-dir', '--git-common-dir', '--abbrev-ref', 'HEAD'], limit)
  if (where.code !== 0) return undefined
  const [gitDir, commonDir, head] = where.stdout.trim().split(/\r?\n/)
  const same = (a = '', b = '') => a.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === b.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const checkout: Checkout = { branch: head && head !== 'HEAD' ? head : null, ahead: null, base: null, worktree: !!gitDir && !!commonDir && !same(gitDir, commonDir) }
  for (const base of ['main', 'master']) {
    const r = await git(cwd, ['rev-list', '--count', `${base}..HEAD`], limit)
    if (r.code === 0 && /^\d+$/.test(r.stdout.trim())) return { ...checkout, ahead: Number(r.stdout.trim()), base }
  }
  return checkout
}

const ago = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}m`
}

const clock = (at: number): string => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const firstLine = (text: string): string => {
  const line = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  const t = line.trim()
  return t.length > REPORT_CHARS ? `${t.slice(0, REPORT_CHARS - 1)}…` : t
}

/** One line per member, for a lead to take in at a glance. */
export function describeTeam(members: TeamMember[], heading: string): string {
  if (!members.length) return `${heading}: no agents.\n`
  const lines = members.map((m) => {
    const parts = [`${m.title} [${m.id}] ${m.status}${m.forSeconds !== undefined ? ` ${ago(m.forSeconds * 1000)}` : ''}`]
    if (m.stopped) parts.push(`stopped: ${m.stopped}`)
    parts.push(m.report ? `report ${m.report.at} (${m.report.ago} ago): ${m.report.firstLine}` : 'no report yet')
    const c = m.checkout
    const where = basename(m.cwd) || m.cwd
    if (c) parts.push(`${c.branch ?? 'detached'}${c.ahead !== null ? ` +${c.ahead} vs ${c.base}` : ''}${c.worktree ? `, worktree ${where}` : `, ${where}`}`)
    else parts.push(where)
    return `- ${parts.join(' | ')}`
  })
  return `${heading} (${members.length}):\n${lines.join('\n')}\n`
}

/**
 * `patchbay team [--group ID]`: a lead's overview, one line per agent: its status, whether it's stopped at a limit,
 * its last report to the caller, and the branch of its folder with how many commits it's ahead of main. Without
 * --group it's the agents the caller opened. It only looks, and runs nothing but read-only git.
 */
export function withTeamVerb(
  verbs: Verbs,
  {
    store,
    tracker,
    stops,
    messages,
    git,
    now = Date.now
  }: {
    store: CanvasStore
    tracker: Pick<StatusTracker, 'get' | 'since'>
    stops?: { get(id: string): AgentStop | undefined }
    messages: () => NodeMessage[]
    git: Git
    now?: () => number
  }
): Verbs {
  const find = (id: string): CanvasNode | undefined => store.get().nodes.find((n) => n.id === id)
  const named = (caller: CanvasNode, ref: string): string => {
    if (find(ref)) return ref
    const want = ref.trim().toLowerCase()
    const same = store.get().nodes.filter((n) => n.projectId === caller.projectId && n.title.trim().toLowerCase() === want)
    if (same.length > 1) refuse(`Several nodes are titled "${ref}": ${same.map((n) => n.id).join(', ')}. Name one by its id.`)
    return same[0]?.id ?? ref
  }

  return async (callerId, verb, args: Args) => {
    if (!TEAM_VERBS.includes(verb)) return verbs(callerId, verb, args)
    const caller = find(callerId) ?? refuse(`Node "${callerId}" is no longer on the canvas.`)
    const given = args.group
    if (given !== undefined && (typeof given !== 'string' || !given)) refuse('--group must be a group id.')
    const groupId = given === undefined ? undefined : named(caller, given)
    const archived = archivedRefusal(store.get(), caller, groupId === undefined ? {} : { group: groupId })
    if (archived) refuse(archived)
    const doc = store.get()
    let members: ClaudeNode[]
    let heading: string
    if (groupId !== undefined) {
      const group = find(groupId)
      if (!group || group.projectId !== caller.projectId) refuse(noGroup(groupId))
      if (group.kind !== 'group') refuse(`Node "${groupId}" is not a group.`)
      const inside = new Set([group.id])
      // Groups can hold groups, so members are found at any depth.
      for (let grew = true; grew; ) {
        grew = false
        for (const n of doc.nodes) if (n.parentId && inside.has(n.parentId) && !inside.has(n.id)) (inside.add(n.id), (grew = true))
      }
      members = doc.nodes.filter((n): n is ClaudeNode => n.kind === 'claude' && inside.has(n.id) && n.id !== callerId)
      heading = `Agents in "${group.title}"`
    } else {
      members = doc.nodes.filter((n): n is ClaudeNode => n.kind === 'claude' && n.openedBy === callerId && n.projectId === caller.projectId)
      heading = 'Agents you opened'
    }

    // One git read per folder, all at once: members often share a checkout.
    const folders = [...new Set(members.map((m) => m.cwd))]
    const checkouts = new Map(await Promise.all(folders.map(async (cwd) => [cwd, await readCheckout(git, cwd).catch(() => undefined)] as const)))
    const lastReport = new Map<string, NodeMessage>()
    for (const m of messages()) if (m.to === callerId) lastReport.set(m.from, m)

    const at = now()
    const rows: TeamMember[] = members.map((m) => {
      const status = tracker.get(m.id)
      const since = tracker.since(m.id)
      const stop = status === 'unknown' ? stops?.get(m.id) : undefined
      const report = lastReport.get(m.id)
      const checkout = checkouts.get(m.cwd)
      return {
        id: m.id,
        title: m.title,
        agent: agentOf(m),
        status,
        ...(since ? { forSeconds: Math.round((at - since.at) / 1000) } : {}),
        ...(stop ? { stopped: stoppedEntry(stop, at).text } : {}),
        ...(report ? { report: { at: clock(report.at), ago: ago(at - report.at), firstLine: firstLine(report.text) } } : {}),
        cwd: m.cwd,
        ...(checkout ? { checkout } : {})
      }
    })
    return { members: rows, text: describeTeam(rows, heading) }
  }
}
