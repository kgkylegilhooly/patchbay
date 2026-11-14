import { agentOf, AGENT_NAMES, type AgentStatus, type CanvasDoc, type CanvasNode } from '../../shared/model'

type Access = 'opened' | 'linked' | null

export interface NodeBrief {
  id: string
  kind: CanvasNode['kind']
  title: string
  agent?: string
  status?: AgentStatus | null
}

/** Where an agent is on the canvas and who it works with, as `patchbay whoami` and the start of a session tell it. */
export interface WhoAmI {
  self: NodeBrief & { cwd?: string; project: string | null }
  group: { id: string; title: string; branch: string | null } | null
  openedBy: NodeBrief | null
  /** Nodes it opened, and nodes linked to it. Read and send reach these. */
  reachable: Array<NodeBrief & { access: 'opened' | 'linked' }>
  /** Other agents in the same group, which a lead and its members share. */
  teammates: NodeBrief[]
}

const KIND_NAMES: Record<CanvasNode['kind'], string> = {
  terminal: 'terminal',
  claude: 'agent',
  run: 'run command',
  sticky: 'note',
  whiteboard: 'whiteboard',
  group: 'group',
  browser: 'browser',
  trigger: 'trigger'
}

function brief(n: CanvasNode, status: (id: string) => AgentStatus | undefined): NodeBrief {
  return { id: n.id, kind: n.kind, title: n.title, ...(n.kind === 'claude' ? { agent: agentOf(n), status: status(n.id) ?? null } : {}) }
}

export function whoami(doc: CanvasDoc, callerId: string, accessOf: (caller: string, n: CanvasNode) => Access, status: (id: string) => AgentStatus | undefined): WhoAmI {
  const self = doc.nodes.find((n) => n.id === callerId)
  if (!self) throw new Error(`Node "${callerId}" is no longer on the canvas.`)
  const project = doc.projects.find((p) => p.id === self.projectId)
  const mine = doc.nodes.filter((n) => n.projectId === self.projectId && n.id !== callerId)
  const group = self.parentId ? doc.nodes.find((n) => n.id === self.parentId && n.kind === 'group') : undefined
  const opener = self.openedBy ? doc.nodes.find((n) => n.id === self.openedBy) : undefined
  return {
    self: { ...brief(self, status), project: project?.name ?? null, ...(self.kind === 'claude' || self.kind === 'terminal' ? { cwd: self.cwd } : {}) },
    group: group?.kind === 'group' ? { id: group.id, title: group.title, branch: group.worktree?.branch ?? null } : null,
    openedBy: opener ? brief(opener, status) : null,
    reachable: mine.flatMap((n) => {
      const access = accessOf(callerId, n)
      return access ? [{ ...brief(n, status), access }] : []
    }),
    teammates: group ? mine.filter((n) => n.parentId === group.id && n.kind === 'claude').map((n) => brief(n, status)) : []
  }
}

/** Titles are typed by people and agents, so they're quoted on one line and cut short. */
export const quoteTitle = (title: string): string => `"${title.replace(/[\r\n"[\]]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60)}"`

const describe = (n: NodeBrief): string => {
  const what = n.agent ? `${AGENT_NAMES[n.agent as keyof typeof AGENT_NAMES] ?? n.agent} agent` : KIND_NAMES[n.kind]
  return `${quoteTitle(n.title)} (${what}, node ${n.id}${n.status ? `, ${n.status}` : ''})`
}

/** The same picture in a few sentences, for an agent to read at the start of its session or from `whoami`. */
export function describeWhoAmI(w: WhoAmI): string {
  const lines = [
    `You are ${describe(w.self)} on the Patchbay canvas${w.self.project ? `, in project ${quoteTitle(w.self.project)}` : ''}.` +
      ' The person can see every node, and the `patchbay` command lets you work with the others.'
  ]
  if (w.group) lines.push(`You're in the group ${quoteTitle(w.group.title)}${w.group.branch ? `, on the git worktree branch ${w.group.branch}` : ''}.`)
  if (w.openedBy) {
    lines.push(
      w.openedBy.agent
        ? `${describe(w.openedBy)} opened you and gave you your task. When you finish, or get stuck, tell it with patchbay send --node ${w.openedBy.id} --text "...".`
        : `${describe(w.openedBy)} opened you.`
    )
  }
  const others = w.reachable.filter((n) => n.id !== w.openedBy?.id)
  if (others.length) lines.push(`You can read and send to: ${others.map(describe).join('; ')}.`)
  const mates = w.teammates.filter((n) => !w.reachable.some((r) => r.id === n.id))
  if (mates.length) lines.push(`Also in your group: ${mates.map(describe).join('; ')}. Keep out of the files they own.`)
  const boards = w.reachable.filter((n) => n.kind === 'whiteboard')
  if (boards.length) lines.push(`To look at a whiteboard, run patchbay whiteboard --node <id> and open the PNG it saves.`)
  lines.push('Messages from other nodes start with a line saying who sent them. Run `patchbay whoami` again any time; the patchbay skill has the rest.')
  return lines.join('\n')
}
