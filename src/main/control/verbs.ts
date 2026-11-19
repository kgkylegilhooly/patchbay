import { randomUUID } from 'node:crypto'
import { taskVerb } from '../tasks/verbs'
import type { TaskService } from '../tasks/service'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { lastLines, readTranscriptAsync, stripAnsi } from '../../core/transcript/read'
import { BLANK, checkUrl, TIMEOUTS } from '../../shared/browserPolicy'
import type { BrowserDriver } from '../browser/driver'
import type { BoardEdit, CanvasStore, NoteEdit, SessionHost } from '../../shared/contract'
import { isDiagramError, layoutDiagram, readDiagram } from '../../shared/diagram'
import { boardSizeFor } from '../../shared/whiteboard'
import type { GithubIssue, GithubPr } from '../../shared/git'
import { agentOf, isSessionNode, type AgentKind, type AgentStatus, type BrowserNode, type CanvasDoc, type CanvasNode, type ClaudeNode, type Edge, type GroupNode, type StickyNode, type TerminalNode, type WhiteboardNode, type WhiteboardShape } from '../../shared/model'
import type { WhiteboardExporter } from '../whiteboardExport'
import { describeWhoAmI, quoteTitle, whoami } from './whoami'
import type { NodeRunner } from '../sessions/nodeRunner'
import type { StatusTracker } from '../sessions/statusTracker'
import type { AfterGate } from './after'
import { isArmed } from '../../core/trigger/arming'
import { describeSchedule } from '../../core/trigger/schedule'
import { BROWSER_VERBS, createBrowserVerbs } from './browserVerbs'
import { createSendQueue, DEFAULT_SEND_TIMING, plainText, type SendQueue, type SendTiming } from './sendQueue'
import { confirmDelivery, DEFAULT_DELIVERY_TIMING, reportDelivery, transcriptEnd, type DeliveryReport, type DeliveryTiming } from './deliveryCheck'
import { RpcRefusal } from './server'
import { archivedRefusal } from './archived'
import { absoluteRect, placeInGroup, placeNear, projectOf, viewRect } from '../../core/canvas/place'
import { viewSize } from '../viewSize'
import { AGENT_KINDS, agentOffReason, type AgentChoice } from '../../shared/agents'
import { profileArg, type ProfileList, type TerminalProfile } from '../../shared/terminalProfiles'

/** A prompt travels on the command line, which Windows caps at 32767 characters including the rest. */
const MAX_PROMPT_CHARS = 28000
const GAP = 40
const SIZES = {
  terminal: { width: 560, height: 340 },
  claude: { width: 620, height: 420 },
  sticky: { width: 280, height: 220 },
  whiteboard: { width: 640, height: 460 },
  group: { width: 640, height: 400 },
  browser: { width: 760, height: 560 }
}
const GROUP_PADDING = 24
const GROUP_TOP = 64

export type VerbTiming = SendTiming

export interface WaitTiming {
  pollMs: number
  /** How long an agent that was already idle must stay idle to count as finished, in case a message hasn't reached it yet. */
  graceMs: number
}
export const DEFAULT_WAIT_TIMING: WaitTiming = { pollMs: 250, graceMs: 2000 }
const WAIT_DEFAULT_S = 90
const WAIT_MAX_S = 600
/** An agent in one of these isn't working: it finished its turn, needs the person, or ended. */
const SETTLED = new Set<AgentStatus>(['idle', 'needs-you', 'exited'])

/** Why an agent has no conversation to read yet, and what the caller can do about it. */
export function notStartedYet(id: string, status: AgentStatus): string {
  const base = `Node "${id}" has no conversation to read yet`
  if (status === 'needs-you')
    return `${base}: it's waiting for the person to answer a question on its screen, such as whether to trust its folder. Tell the person which node, then run patchbay wait --nodes ${id}.`
  if (status === 'queued') return `${base}: it's held until the agents it waits for (--after) finish a turn.`
  if (status === 'starting') return `${base}: it's still starting. Run patchbay wait --nodes ${id}, then read it.`
  if (status === 'exited') return `${base}: it exited before its session started.`
  return `${base}.`
}

type Args = Record<string, unknown>

/** What the read-only `issues` and `prs` verbs may use. It has no way to write. */
export interface GithubRead {
  repoFor(projectId: string | undefined, cwd?: string): Promise<string>
  issues(repo: string, state: 'open' | 'closed' | 'all', limit: number): Promise<GithubIssue[]>
  issue(repo: string, n: number): Promise<GithubIssue | undefined>
  prs(repo: string, state: 'open' | 'closed' | 'merged' | 'all', limit: number): Promise<GithubPr[]>
}
export type Verbs = (caller: string, verb: string, args: Args) => Promise<unknown>

function refuse(message: string): never {
  throw new RpcRefusal(message)
}

function required(args: Args, key: string): string {
  const v = args[key]
  if (typeof v !== 'string' || !v) refuse(`--${key} is required.`)
  return v
}

function optional(args: Args, key: string): string | undefined {
  const v = args[key]
  if (v === undefined) return undefined
  if (typeof v !== 'string') refuse(`--${key} must be text.`)
  return v
}

function list(args: Args, key: string): string[] {
  const v = args[key]
  if (v === undefined) return []
  if (!Array.isArray(v) || v.some((s) => typeof s !== 'string' || !s)) refuse(`--${key} must be a list of ids.`)
  return v as string[]
}

function folder(path: string): string {
  if (!isAbsolute(path)) refuse(`--cwd must be an absolute path: ${path}`)
  let isDir = false
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    // Reported below, the same as a path that isn't a folder.
  }
  if (!isDir) refuse(`Folder not found: ${path}`)
  return path
}

function promptFrom(args: Args): string | undefined {
  const prompt = optional(args, 'prompt')
  const file = optional(args, 'promptFile')
  if (prompt !== undefined && file !== undefined) refuse('Give only one of --prompt and --prompt-file.')
  let text = prompt
  if (file !== undefined) {
    try {
      text = readFileSync(file, 'utf8')
    } catch (e) {
      refuse(`Could not read the prompt file ${file}: ${(e as Error).message}`)
    }
  }
  if (text !== undefined && text.length > MAX_PROMPT_CHARS) {
    refuse(`The prompt is too long to launch with (limit ${MAX_PROMPT_CHARS} characters). Put it in a file and have a short prompt point there.`)
  }
  return text
}


function absolute(doc: CanvasDoc, node: CanvasNode): { x: number; y: number } {
  let { x, y } = node
  const seen = new Set([node.id])
  let parent = doc.nodes.find((n) => n.id === node.parentId)
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id)
    x += parent.x
    y += parent.y
    const parentId: string | null = parent.parentId
    parent = doc.nodes.find((n) => n.id === parentId)
  }
  return { x, y }
}

/** The nearest free spot beside the opener, in view when the window's size is known. See core/canvas/place. */
export function spotNear(doc: CanvasDoc, opener: CanvasNode, size: { width: number; height: number }): { x: number; y: number } {
  const projectId = projectOf(doc, opener)
  return placeNear(doc, { beside: absoluteRect(doc, opener), size, projectId, view: viewRect(doc, projectId, viewSize()) })
}

const edge = (from: string, to: string, kind: Edge['kind']): Edge => ({ id: randomUUID(), from, to, kind })

interface MemberPlan {
  name: string
  id: string
  agent: AgentKind
  prompt?: string
  cwd: string
  after: string[]
}

/** Which agent to open: claude or codex, or the person's default from Settings when none is named. */
function agentArg(args: Args, fallback: AgentKind): AgentKind {
  const value = args.agent
  if (value === undefined) return fallback
  if (value === 'claude' || value === 'codex') return value
  return refuse('--agent must be claude or codex.')
}

function refuseCycles(members: MemberPlan[]): void {
  const byId = new Map(members.map((m) => [m.id, m]))
  const done = new Set<string>()
  const visit = (m: MemberPlan, path: Set<string>): void => {
    if (path.has(m.id)) refuse(`Team member "${m.name}" ends up waiting on itself.`)
    if (done.has(m.id)) return
    path.add(m.id)
    for (const up of m.after) {
      const member = byId.get(up)
      if (member) visit(member, path)
    }
    path.delete(m.id)
    done.add(m.id)
  }
  for (const m of members) visit(m, new Set())
}

export function createVerbs({
  tasks,
  store,
  runner,
  tracker,
  host,
  gate,
  browser,
  github,
  timing = DEFAULT_SEND_TIMING,
  queue,
  whiteboards,
  onMessage,
  onNoteEdit,
  onBoardEdit,
  waitTiming = DEFAULT_WAIT_TIMING,
  defaultAgent = () => 'claude',
  agents = () => ({ enabled: [...AGENT_KINDS], default: defaultAgent() }),
  terminalProfiles,
  deliveryTiming = DEFAULT_DELIVERY_TIMING,
  log
}: {
  tasks?: TaskService
  waitTiming?: WaitTiming
  /** How long send waits to see its message in the target's transcript. */
  deliveryTiming?: DeliveryTiming
  /** For the app's log file: a message that may not have arrived. */
  log?: (line: string) => void
  /** A node sent another a message, so the canvas can show it travel down the cable between them, and keep it. */
  onMessage?: (from: string, to: string, text: string) => void
  /** An agent changed a note, so the person can see who did, and undo it. */
  onNoteEdit?: (edit: NoteEdit) => void
  /** An agent drew on a whiteboard, likewise. */
  onBoardEdit?: (edit: BoardEdit) => void
  /** Turns a board into files an agent can open. Without it, boards can still be read as text. */
  whiteboards?: WhiteboardExporter
  /** Settings > Default agent, read at each call. */
  defaultAgent?: () => AgentKind
  /** Settings > Agents, read at each call: the agents Patchbay may open. Every agent when not given. */
  agents?: () => AgentChoice
  /** Every terminal profile, the default first, for open-terminal --profile. */
  terminalProfiles?: () => ProfileList
  github?: GithubRead
  store: CanvasStore
  runner: Pick<NodeRunner, 'startNode' | 'stopNode'>
  tracker: Pick<StatusTracker, 'get' | 'onChange'>
  host: Pick<SessionHost, 'write' | 'snapshot' | 'isRunning' | 'forget'>
  gate: AfterGate
  browser?: BrowserDriver
  timing?: VerbTiming
  /** Shared with triggers, so nothing types over anything else. Made here when not given. */
  queue?: SendQueue
}): Verbs {
  const find = (id: string): CanvasNode | undefined => store.get().nodes.find((n) => n.id === id)
  const existing = (id: string): CanvasNode => find(id) ?? refuse(`There is no node "${id}".`)
  /** For the verbs that change the canvas. A node in another project gets the same answer as one that isn't there. */
  const ownProject = (caller: CanvasNode, id: string): CanvasNode => {
    const node = find(id)
    return node && node.projectId === caller.projectId ? node : refuse(`There is no node "${id}".`)
  }
  const add = (e: Edge): void => store.dispatch({ op: 'addEdge', edge: e })

  /** Refuses an agent turned off in Settings > Agents, naming the setting and the agents still on. */
  const allowAgent = (agent: AgentKind, who = ''): AgentKind => {
    const choice = agents()
    const off = agentOffReason(agent, choice)
    return off ? refuse(`${who}${off} Name ${choice.enabled.join(' or ')} as the agent instead, or none for the default (${choice.default}).`) : agent
  }

  const linked = (a: string, b: string): boolean =>
    store.get().edges.some((e) => e.kind === 'link' && ((e.from === a && e.to === b) || (e.from === b && e.to === a)))

  const accessOf = (caller: string, node: CanvasNode): 'opened' | 'linked' | null =>
    node.openedBy === caller ? 'opened' : linked(caller, node.id) ? 'linked' : null

  const reachable = (caller: string, id: string, action: string): CanvasNode => {
    const node = existing(id)
    // Agents told only no kept trying, one node after another. What they can do instead stops that.
    if (!accessOf(caller, node)) {
      refuse(
        `Can't ${action} node "${id}": it isn't linked to you and you didn't open it. \`patchbay list\` still shows its title, kind and folder. ` +
          'To see what it shows, ask the person to draw a cable between it and you.'
      )
    }
    return node
  }

  const groupFor = (caller: CanvasNode, args: Args): GroupNode | null => {
    const id = optional(args, 'group')
    if (id === undefined) return null
    const node = ownProject(caller, id)
    if (node.kind !== 'group') refuse(`Node "${id}" is not a group.`)
    return node
  }

  /**
   * A terminal profile's folder, after --cwd and a group's worktree but before the caller's folder. The named profile's,
   * or the default's: a missing folder is refused for one named with --profile, and passed over for the default.
   */
  const profileCwd = (args: Args, group: GroupNode | null, named: TerminalProfile | undefined): string | undefined => {
    if (optional(args, 'cwd') !== undefined || group?.worktree) return undefined
    const path = (named ?? terminalProfiles?.().profiles[0])?.cwd
    if (!path) return undefined
    if (named) return folder(path)
    try {
      return isAbsolute(path) && statSync(path).isDirectory() ? path : undefined
    } catch {
      return undefined
    }
  }

  const cwdFor = (args: Args, caller: CanvasNode, group: GroupNode | null): string => {
    const given = optional(args, 'cwd')
    if (given !== undefined) return folder(given)
    if (group?.worktree) return folder(group.worktree.path)
    if (isSessionNode(caller)) return folder(caller.cwd)
    return refuse('--cwd is required.')
  }

  const placement = (caller: CanvasNode, group: GroupNode | null, size: { width: number; height: number }) => ({
    ...size,
    ...(group ? placeInGroup(store.get(), group.id, size) : spotNear(store.get(), caller, size)),
    parentId: group?.id ?? null,
    openedBy: caller.id
  })

  const connect = (caller: string, id: string): void => {
    add(edge(caller, id, 'opened'))
    add(edge(caller, id, 'link'))
  }

  const upstreamClaude = (caller: CanvasNode, id: string): void => {
    const node = find(id)
    if (!node || node.projectId !== caller.projectId) refuse(`--after names a node that doesn't exist: "${id}".`)
    if (node.kind !== 'claude') refuse(`Node "${id}" isn't a Claude or Codex node, so --after can't wait for it.`)
    // Agents reach for --after to mean "report back to me". It would hold the new agent until this turn ends, while
    // the caller waits for it.
    if (id === caller.id)
      refuse(
        `--after can't name you: the new agent would be held until your turn ends, while you wait for it. Leave --after out. It's linked to you either way, so it can report back with patchbay send.`
      )
  }

  // send

  const sendQueue = queue ?? createSendQueue({ host, tracker, exists: (id) => !!find(id), timing })

  /**
   * The first line of a message to an agent, saying which node sent it, so the agent can tell a lead from a peer and
   * from the person, whose own messages carry no such line. Only an agent is offered a way to reply.
   */
  const senderLine = (caller: string): string => {
    const from = find(caller)
    if (!from) return '[Patchbay message from another node]'
    const reply = from.kind === 'claude' ? ` Reply with: patchbay send --node ${from.id} --text "..."` : ''
    return `[Patchbay message from ${quoteTitle(from.title)} (node ${from.id}).${reply}]`
  }

  const send = (caller: string, args: Args): unknown => {
    const id = required(args, 'node')
    const raw = required(args, 'text')
    const node = reachable(caller, id, 'send to')
    if (node.kind === 'terminal') {
      // A terminal has no status to wait for, and may need control keys.
      if (!host.isRunning(id))
        refuse(`Terminal "${id}" has ended, so nothing would read this. Ask the person to restart it, or open a new one with patchbay open-terminal --command.`)
      sendQueue.type(id, raw)
      onMessage?.(caller, id, plainText(raw))
      return { delivered: true }
    }
    if (node.kind !== 'claude') refuse(`Can't send to node "${id}": it isn't a terminal or an agent node.`)
    if (tracker.get(id) === 'exited') refuse(`Node "${id}" has exited, so nothing would read this.`)
    const body = plainText(raw)
    if (!body.trim()) refuse('--text has nothing to send.')
    const text = `${senderLine(caller)}\n${body}`
    // Checked against the node's transcript once typed. One typed later, after waiting, is reported back as a message.
    let waited = false
    let check: Promise<DeliveryReport> | undefined
    const onTyped = (): void => {
      check = checkDelivery(id, text)
      if (waited) void check.then((report) => report.problem && tellSender(caller, id, report.problem))
    }
    const queued = sendQueue.add(id, { text, from: caller, said: body, onTyped }) === 'queued'
    waited = queued
    onMessage?.(caller, id, body)
    if (queued) return { delivered: false, queued: true }
    return check ?? { delivered: true }
  }

  /** Whether what was typed into an agent shows up whole in its transcript. Anything less goes in the log. */
  const checkDelivery = (id: string, text: string): Promise<DeliveryReport> => {
    const target = find(id)
    const path = target?.kind === 'claude' ? target.transcriptPath : null
    // Taken now, before Enter, which is when the agent writes the message down.
    const from = transcriptEnd(path)
    return confirmDelivery({ path, from, sent: text, timing: deliveryTiming }).then((outcome) => {
      const report = reportDelivery(outcome, id, deliveryTiming)
      if (report.problem) log?.(`send to ${id}: ${outcome.result}. ${report.problem}`)
      return report
    })
  }

  /** A message that waited can't be answered for by send's result, so its sender hears by message if it went wrong. */
  const tellSender = (caller: string, id: string, problem: string): void => {
    const sender = find(caller)
    if (sender?.kind !== 'claude' || tracker.get(caller) === 'exited') return
    sendQueue.add(caller, { text: `[Patchbay notice about your earlier message to node ${id}]\n${plainText(problem)}` })
  }

  /**
   * Holds the caller until the agents it names have finished their turns, so a lead can wait on its team without
   * polling. A node that's busy, or has a message on its way, counts as finished once it settles. One that's already
   * idle counts once it has stayed idle a moment, which leaves time for a message just sent to start it.
   */
  const wait = (caller: string, args: Args): Promise<unknown> => {
    const given = Array.isArray(args.nodes) ? (args.nodes as unknown[]) : args.node !== undefined ? [args.node] : []
    if (!given.length || !given.every((v) => typeof v === 'string' && v)) refuse('Pass --nodes ID,ID.')
    const ids = [...new Set(given as string[])]
    for (const id of ids) {
      const node = reachable(caller, id, 'wait on')
      if (node.kind !== 'claude') refuse(`Node "${id}" is a ${node.kind}, which has no turns to wait for. Only agent nodes can be waited on.`)
    }
    const timeout = args.timeout ?? WAIT_DEFAULT_S
    if (!Number.isInteger(timeout) || (timeout as number) < 1 || (timeout as number) > WAIT_MAX_S) refuse(`--timeout must be a whole number of seconds from 1 to ${WAIT_MAX_S}.`)
    const any = args.any === true
    const started = Date.now()
    const moved = new Set<string>()
    const settledAt = new Map<string, number>()
    const finished = (id: string, now: number): boolean => {
      const status = tracker.get(id) ?? 'unknown'
      if (!find(id)) return true
      if (!SETTLED.has(status) || sendQueue.busy(id)) {
        moved.add(id)
        settledAt.delete(id)
        return false
      }
      if (!settledAt.has(id)) settledAt.set(id, now)
      return moved.has(id) || now - settledAt.get(id)! >= waitTiming.graceMs
    }
    return new Promise((resolve) => {
      const check = (): boolean => {
        const now = Date.now()
        const done = ids.filter((id) => finished(id, now))
        const over = any ? done.length > 0 : done.length === ids.length
        const timedOut = now - started >= (timeout as number) * 1000
        if (!over && !timedOut) return false
        // What they sent the caller meanwhile is waiting for it to go idle. Handed over here, it doesn't arrive again
        // as a fresh prompt after the caller has already moved on.
        const handed = sendQueue.take(caller, (item) => !!item.from && ids.includes(item.from))
        resolve({
          done: over,
          ...(over ? {} : { timedOut: true }),
          nodes: Object.fromEntries(ids.map((id) => [id, find(id) ? (tracker.get(id) ?? 'unknown') : 'closed'])),
          ...(handed.length ? { messages: handed.map((m) => ({ from: m.from, text: m.said ?? m.text })) } : {}),
          waitedSeconds: Math.round((now - started) / 100) / 10
        })
        return true
      }
      if (check()) return
      const timer = setInterval(() => {
        if (check()) clearInterval(timer)
      }, waitTiming.pollMs)
      timer.unref?.()
    })
  }

  // read

  const read = (caller: string, args: Args): unknown => {
    const id = required(args, 'node')
    const tail = args.tail
    if (tail !== undefined && (!Number.isInteger(tail) || (tail as number) < 1)) refuse('--tail must be a whole number above 0.')
    const count = tail as number | undefined
    const node = reachable(caller, id, 'read')
    switch (node.kind) {
      case 'terminal':
      case 'run':
        return { text: lastLines(stripAnsi(host.snapshot(id).data), count) }
      case 'sticky':
        return { text: lastLines(node.text, count) }
      case 'whiteboard': {
        const words = node.shapes.flatMap((s) => (s.type === 'text' ? [s.text] : []))
        const told = `A whiteboard with ${node.shapes.length} shape${node.shapes.length === 1 ? '' : 's'}. To see it, run: patchbay whiteboard --node ${id}`
        return { text: [told, ...(words.length ? ['Text on it:', ...words.map((w) => `- ${w}`)] : [])].join('\n') }
      }
      case 'trigger':
        return { text: lastLines(node.prompt, count) }
      case 'group':
        return refuse(`Node "${id}" is a group, which has nothing to read.`)
      case 'browser':
        return refuse(`Node "${id}" is a browser node. Use patchbay browser read.`)
      case 'claude':
        if (!node.transcriptPath) refuse(notStartedYet(id, tracker.get(id)))
        // Without blocking: a long conversation's transcript is tens of megabytes.
        return readTranscriptAsync(node.transcriptPath, count).then(
          (text) => ({ text }),
          (e: unknown) => {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
            return refuse(`The transcript for node "${id}" no longer exists.`)
          }
        )
    }
  }

  // opening nodes

  const openAgent = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    const group = groupFor(caller, args)
    const cwd = cwdFor(args, caller, group)
    const prompt = promptFrom(args)
    const after = list(args, 'after')
    const agent = allowAgent(agentArg(args, defaultAgent()))
    after.forEach((id) => upstreamClaude(caller, id))

    const node: ClaudeNode = {
      ...placement(caller, group, SIZES.claude),
      id: randomUUID(),
      kind: 'claude',
      ...(agent === 'codex' ? { agent } : {}),
      title: optional(args, 'title') || (agent === 'codex' ? 'Codex' : 'Claude'),
      cwd,
      sessionId: null,
      transcriptPath: null,
      after: []
    }
    if (prompt !== undefined) node.prompt = prompt
    store.dispatch({ op: 'addNode', node })
    connect(caller.id, node.id)
    for (const up of after) add(edge(up, node.id, 'after'))
    if (after.length) gate.arm(node.id, after)
    else await runner.startNode(node.id)
    return { id: node.id }
  }

  const openTerminal = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    if (args.after !== undefined) refuse('--after only works on Claude nodes, not terminals.')
    const group = groupFor(caller, args)
    const profile = profileArg(terminalProfiles, optional(args, 'profile'), refuse)
    const cwd = profileCwd(args, group, profile) ?? cwdFor(args, caller, group)
    const command = optional(args, 'command')
    const node: TerminalNode = {
      ...placement(caller, group, SIZES.terminal),
      id: randomUUID(),
      kind: 'terminal',
      title: optional(args, 'title') || (command ? command.split(/\s+/)[0] : 'Terminal'),
      cwd
    }
    if (command) node.command = command
    if (profile) node.profile = profile.id
    store.dispatch({ op: 'addNode', node })
    connect(caller.id, node.id)
    await runner.startNode(node.id)
    return { id: node.id }
  }

  const openBrowser = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    if (!browser) refuse('Browser nodes are not available here.')
    const given = optional(args, 'url')
    const target = given === undefined ? { ok: true as const, url: BLANK } : checkUrl(given)
    if (!target.ok) refuse(target.reason)
    const group = groupFor(caller, args)
    const node: BrowserNode = {
      ...placement(caller, group, SIZES.browser),
      id: randomUUID(),
      kind: 'browser',
      title: optional(args, 'title') || 'Browser',
      url: target.url
    }
    store.dispatch({ op: 'addNode', node })
    connect(caller.id, node.id)
    const showing = await browser.waitReady(node.id, TIMEOUTS.attachMs)
    const loaded = showing && (await browser.settled(node.id))
    return { id: node.id, url: target.url, showing, loaded }
  }

  const browserVerb = browser && createBrowserVerbs({ driver: browser, find, accessOf })

  /** Read-only GitHub, for the caller's own project. There is no verb that writes to GitHub, and there mustn't be. */
  const githubVerb = async (caller: CanvasNode, verb: 'issues' | 'prs', args: Args): Promise<unknown> => {
    if (!github) refuse('GitHub reading is not available here.')
    const limitArg = args.limit
    if (limitArg !== undefined && (typeof limitArg !== 'number' || !Number.isInteger(limitArg) || limitArg < 1 || limitArg > 200)) refuse('--limit must be a whole number from 1 to 200.')
    const state = optional(args, 'state') ?? 'open'
    const states = verb === 'issues' ? ['open', 'closed', 'all'] : ['open', 'closed', 'merged', 'all']
    if (!states.includes(state)) refuse(`--state must be one of ${states.join(', ')}.`)
    const numberArg = args.number
    try {
      const repo = await github.repoFor(caller.projectId, isSessionNode(caller) ? caller.cwd : undefined)
      if (verb === 'issues' && numberArg !== undefined) {
        if (typeof numberArg !== 'number' || !Number.isInteger(numberArg) || numberArg < 1) refuse('--number must be an issue number.')
        return { untrusted: true, repo, issue: (await github.issue(repo, numberArg)) ?? null }
      }
      const limit = (limitArg as number | undefined) ?? (verb === 'issues' ? 50 : 30)
      if (verb === 'issues') return { untrusted: true, repo, issues: await github.issues(repo, state as 'open', limit) }
      return { untrusted: true, repo, prs: await github.prs(repo, state as 'open', limit) }
    } catch (e) {
      if (e instanceof RpcRefusal) throw e
      return refuse((e as Error).message)
    }
  }

  const planMembers = (caller: CanvasNode, raw: unknown): MemberPlan[] => {
    if (!Array.isArray(raw) || raw.length === 0) refuse('--members must be a non-empty list.')
    const ids = new Map<string, string>()
    for (const m of raw) {
      const name = (m as Args | null)?.name
      if (typeof name !== 'string' || !name) refuse('Every team member needs a name.')
      if (ids.has(name)) refuse(`Two team members are named "${name}".`)
      ids.set(name, randomUUID())
    }
    const plans = raw.map((m: Args): MemberPlan => {
      const name = m.name as string
      const after = list(m, 'after').map((ref) => {
        if (ref === name) refuse(`Team member "${name}" can't wait for itself.`)
        const member = ids.get(ref)
        if (member) return member
        upstreamClaude(caller, ref)
        return ref
      })
      return { name, id: ids.get(name)!, agent: allowAgent(agentArg(m, defaultAgent()), `Team member "${name}": `), prompt: promptFrom(m), cwd: cwdFor(m, caller, null), after }
    })
    refuseCycles(plans)
    return plans
  }

  /** Everything is checked before the first change, so a bad team leaves the canvas alone. */
  const spawnTeam = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    const label = required(args, 'label')
    const color = optional(args, 'color')
    const plans = planMembers(caller, args.members)

    // Sized for its members before it's placed, so the spot found is clear for the whole row.
    const teamSize = { width: 2 * GROUP_PADDING + plans.length * (SIZES.claude.width + GAP) - GAP, height: GROUP_TOP + SIZES.claude.height + GROUP_PADDING }
    const group: GroupNode = {
      ...placement(caller, null, plans.length ? teamSize : SIZES.group),
      id: randomUUID(),
      kind: 'group',
      title: label,
      worktree: null
    }
    if (color) group.color = color
    store.dispatch({ op: 'addNode', node: group })
    add(edge(caller.id, group.id, 'opened'))

    plans.forEach((m, i) => {
      const node: ClaudeNode = {
        ...SIZES.claude,
        x: GROUP_PADDING + i * (SIZES.claude.width + GAP),
        y: GROUP_TOP,
        parentId: group.id,
        openedBy: caller.id,
        id: m.id,
        kind: 'claude',
        ...(m.agent === 'codex' ? { agent: m.agent } : {}),
        title: m.name,
        cwd: m.cwd,
        sessionId: null,
        transcriptPath: null,
        after: []
      }
      if (m.prompt !== undefined) node.prompt = m.prompt
      store.dispatch({ op: 'addNode', node })
      connect(caller.id, m.id)
    })
    const memberIds = new Set(plans.map((m) => m.id))
    for (const m of plans) {
      for (const up of m.after) {
        add(edge(up, m.id, 'after'))
        // So a later member can read the work it was waiting for.
        if (memberIds.has(up)) add(edge(up, m.id, 'link'))
      }
    }
    for (const m of plans) {
      if (m.after.length) gate.arm(m.id, m.after)
      else await runner.startNode(m.id)
    }
    return { group: group.id, members: Object.fromEntries(plans.map((m) => [m.name, m.id])) }
  }

  const sticky = (caller: CanvasNode, args: Args): unknown => {
    const group = groupFor(caller, args)
    const node: StickyNode = {
      ...placement(caller, group, SIZES.sticky),
      id: randomUUID(),
      kind: 'sticky',
      title: optional(args, 'title') || 'Note',
      text: required(args, 'text')
    }
    store.dispatch({ op: 'addNode', node })
    add(edge(caller.id, node.id, 'opened'))
    return { id: node.id }
  }

  /**
   * Changes a note's text, so a note can serve as a team's shared board. Adding to a note works on any note the caller
   * can reach. Replacing its text only works on a note the caller opened, so an agent can't wipe the person's own.
   */
  const note = (caller: string, args: Args): unknown => {
    const id = required(args, 'node')
    const text = optional(args, 'text')
    const append = optional(args, 'append')
    if ((text === undefined) === (append === undefined)) refuse('Pass one of --text or --append.')
    const node = reachable(caller, id, 'change')
    if (node.kind !== 'sticky') refuse(`Node "${id}" is a ${node.kind}, not a note.`)
    if (text !== undefined && node.openedBy !== caller) refuse(`You can only add to note "${id}", because you didn't open it. Use --append.`)
    const before = (node as StickyNode).text
    const next = text ?? (before && !before.endsWith('\n') ? `${before}\n${append}` : `${before}${append}`)
    store.dispatch({ op: 'patchNode', id, patch: { text: next } })
    onNoteEdit?.({ id, by: caller, before, after: next, at: Date.now() })
    return { id, chars: next.length }
  }

  const openWhiteboard = (caller: CanvasNode, args: Args): unknown => {
    const group = groupFor(caller, args)
    const node: WhiteboardNode = { ...placement(caller, group, SIZES.whiteboard), id: randomUUID(), kind: 'whiteboard', title: optional(args, 'title') || 'Whiteboard', shapes: [] }
    store.dispatch({ op: 'addNode', node })
    // Linked as well as opened, so the cable shows the person which agent the board is for.
    connect(caller.id, node.id)
    return { id: node.id }
  }

  /**
   * Draws a diagram on a whiteboard, from boxes and the arrows between them, laid out below what's already there. It
   * only ever adds, and the person sees who drew and can undo it.
   */
  /** Each board's last drawing by an agent, and the shapes it left, which is what --replace may take back. */
  const lastDraws = new Map<string, { by: string; before: number; shapes: WhiteboardShape[] }>()

  const draw = (caller: string, args: Args): unknown => {
    const id = required(args, 'node')
    const inline = optional(args, 'diagram')
    const file = optional(args, 'diagramFile')
    if ((inline === undefined) === (file === undefined)) refuse('Pass one of --diagram JSON or --diagram-file FILE.')
    const node = reachable(caller, id, 'draw on')
    if (node.kind !== 'whiteboard') refuse(`Node "${id}" is a ${node.kind}, not a whiteboard.`)
    let text = inline ?? ''
    if (file !== undefined) {
      try {
        text = readFileSync(file, 'utf8')
      } catch (e) {
        refuse(`Could not read the diagram file ${file}: ${(e as Error).message}`)
      }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (e) {
      refuse(`The diagram isn't valid JSON: ${(e as Error).message}. Put it in a file and use --diagram-file if quoting is awkward.`)
    }
    const board = node as WhiteboardNode
    // --replace takes away the caller's own last drawing first, but only while the board is exactly as it left it, so
    // nothing anyone else drew, the person included, can go with it.
    let base = board.shapes
    if (args.replace === true) {
      const last = lastDraws.get(id)
      if (!last || last.by !== caller || last.shapes !== board.shapes) {
        refuse(`Nothing of yours to replace on board "${id}": you haven't drawn on it, or it has changed since you did. Draw without --replace to add to it.`)
      }
      base = board.shapes.slice(0, last!.before)
    }
    let added: WhiteboardShape[] = []
    try {
      added = layoutDiagram(readDiagram(raw), base)
    } catch (e) {
      if (isDiagramError(e)) refuse(e.message)
      throw e
    }
    const next = [...base, ...added]
    // The board grows to show the drawing, so nothing an agent drew is hidden past its edge.
    store.dispatch({ op: 'patchNode', id, patch: { shapes: next, ...boardSizeFor(next, board) } as Partial<CanvasNode> })
    lastDraws.set(id, { by: caller, before: base.length, shapes: next })
    onBoardEdit?.({ id, by: caller, before: base.length, after: next.length, at: Date.now() })
    return { id, added: added.length, ...(base !== board.shapes ? { replaced: board.shapes.length - base.length } : {}), look: `patchbay whiteboard --node ${id}` }
  }

  /** A board as a PNG to look at and an SVG beside it, with the text written on it. */
  const whiteboard = async (caller: string, args: Args): Promise<unknown> => {
    const id = required(args, 'node')
    const node = reachable(caller, id, 'export')
    if (node.kind !== 'whiteboard') refuse(`Node "${id}" is a ${node.kind}, not a whiteboard.`)
    if (!whiteboards) refuse('Whiteboards cannot be exported here.')
    const out = await whiteboards.export(node as WhiteboardNode)
    return { ...out, ...(out.image ? {} : { problem: 'The app window could not draw the picture, so only the SVG was saved.' }) }
  }

  // arranging

  const group = (caller: CanvasNode, args: Args): unknown => {
    const label = required(args, 'label')
    const color = optional(args, 'color')
    const named = list(args, 'ids')
    if (named.length === 0) refuse('--ids must name at least one node.')
    const doc = store.get()
    const chosen = new Set(named)
    const under = (node: CanvasNode): boolean => {
      const seen = new Set([node.id])
      for (let p = find(node.parentId ?? ''); p && !seen.has(p.id); p = find(p.parentId ?? '')) {
        if (chosen.has(p.id)) return true
        seen.add(p.id)
      }
      return false
    }
    // A child whose group is also named moves with that group.
    const members = [...chosen].map((id) => ownProject(caller, id)).filter((n) => !under(n))
    const boxes = members.map((m) => ({ ...absolute(doc, m), width: m.width, height: m.height }))
    const x = Math.min(...boxes.map((b) => b.x)) - GROUP_PADDING
    const y = Math.min(...boxes.map((b) => b.y)) - GROUP_TOP
    const node: GroupNode = {
      id: randomUUID(),
      kind: 'group',
      title: label,
      x,
      y,
      width: Math.max(...boxes.map((b) => b.x + b.width)) + GROUP_PADDING - x,
      height: Math.max(...boxes.map((b) => b.y + b.height)) + GROUP_PADDING - y,
      parentId: null,
      openedBy: caller.id,
      worktree: null
    }
    if (color) node.color = color
    store.dispatch({ op: 'addNode', node })
    store.dispatch({ op: 'setParent', ids: members.map((m) => m.id), parentId: node.id })
    return { id: node.id }
  }

  const arrange = (caller: CanvasNode, args: Args): unknown => {
    const layout = required(args, 'layout')
    if (layout !== 'grid' && layout !== 'row' && layout !== 'column') {
      refuse(`Unknown layout "${layout}". Use grid, row or column.`)
    }
    const ids = list(args, 'ids')
    for (const id of ids) ownProject(caller, id)
    const gap = args.gap
    if (gap !== undefined && (typeof gap !== 'number' || !Number.isFinite(gap) || gap < 0)) refuse('--gap must be 0 or more.')
    store.dispatch({ op: 'arrange', ids, layout, gap: gap as number | undefined })
    return { arranged: ids.length }
  }

  const rename = (caller: CanvasNode, args: Args): unknown => {
    const id = required(args, 'node')
    const title = required(args, 'title')
    ownProject(caller, id)
    store.dispatch({ op: 'patchNode', id, patch: { title } })
    return { id, title }
  }

  /**
   * A link grants read and send, so an agent can't be free to link itself to anything. Each end must
   * be the caller or a node it opened. The person at the canvas can link any two nodes.
   */
  const link = (caller: string, args: Args): unknown => {
    const to = required(args, 'to')
    const from = optional(args, 'from') ?? caller
    if (from === to) refuse("A node can't be linked to itself.")
    for (const id of [from, to]) {
      if (id !== caller && existing(id).openedBy !== caller) {
        refuse(`Can't link node "${id}": you can only link yourself and nodes you opened.`)
      }
    }
    add(edge(from, to, 'link'))
    return { from, to }
  }

  const close = async (caller: string, args: Args): Promise<unknown> => {
    const id = required(args, 'node')
    const node = existing(id)
    if (node.openedBy !== caller) refuse(`Can't close node "${id}": you didn't open it.`)
    if (node.kind === 'browser' && node.held) refuse(`The person has taken control of browser node "${id}", so it can't be closed.`)
    sendQueue.forget(id)
    if (isSessionNode(node)) {
      await runner.stopNode(id)
      host.forget?.(id)
    }
    store.dispatch({ op: 'removeNodes', ids: [id], at: Date.now() })
    // A team's group, emptied by closing its last member, would be left as a bare frame. It goes too, but only one
    // the caller made, and only when nothing else is in it.
    const group = node.parentId ? find(node.parentId) : undefined
    if (group?.kind === 'group' && group.openedBy === caller && !store.get().nodes.some((n) => n.parentId === group.id)) {
      store.dispatch({ op: 'removeNodes', ids: [group.id], at: Date.now() })
      return { closed: id, removedGroup: group.id }
    }
    return { closed: id }
  }

  const listNodes = (caller: string): unknown => {
    const doc = store.get()
    // An agent works within its own project and doesn't see the others.
    const projectId = find(caller)?.projectId
    const nodes = doc.nodes.filter((n) => n.projectId === projectId)
    const ids = new Set(nodes.map((n) => n.id))
    return {
      self: caller,
      nodes: nodes.map((n) => ({
        id: n.id,
        kind: n.kind,
        title: n.title,
        parentId: n.parentId,
        openedBy: n.openedBy ?? null,
        access: accessOf(caller, n),
        ...(n.kind === 'claude' ? { agent: agentOf(n), status: tracker.get(n.id), cwd: n.cwd, after: n.after } : {}),
        ...(n.kind === 'terminal' || n.kind === 'run' ? { cwd: n.cwd, running: host.isRunning(n.id) } : {}),
        ...(n.kind === 'group' && n.worktree ? { branch: n.worktree.branch, cwd: n.worktree.path } : {}),
        ...(n.kind === 'browser' ? { url: n.url, held: !!n.held } : {}),
        ...(n.kind === 'whiteboard' ? { shapes: n.shapes.length } : {}),
        // An agent can see what triggers there are. Only the person can arm one, and the prompt stays with read access.
        ...(n.kind === 'trigger'
          ? { trigger: { armed: isArmed(n), schedule: describeSchedule(n.schedule), target: n.targetId, nextAt: n.nextAt, lastRun: n.runs[0] ? { at: n.runs[0].at, outcome: n.runs[0].outcome } : null } }
          : {})
      })),
      edges: doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map(({ from, to, kind }) => ({ from, to, kind }))
    }
  }

  /**
   * A node named by its title rather than its id, as agents and people often do: `--node "Billing API owner"`. An id
   * always wins. A title counts only if exactly one node in the caller's project has it, ignoring case; several are
   * refused with their ids, since guessing could send to the wrong one.
   */
  const byTitle = (caller: CanvasNode, ref: string): string => {
    if (find(ref)) return ref
    const want = ref.trim().toLowerCase()
    if (!want) return ref
    const same = store.get().nodes.filter((n) => n.projectId === caller.projectId && n.title.trim().toLowerCase() === want)
    if (same.length > 1) refuse(`Several nodes are titled "${ref}": ${same.map((n) => n.id).join(', ')}. Name one by its id.`)
    return same[0]?.id ?? ref
  }
  const NODE_ARGS = ['node', 'to', 'from', 'group']
  const NODE_LISTS = ['nodes', 'ids', 'after']
  const withIds = (caller: CanvasNode, args: Args): Args => {
    const out: Args = { ...args }
    for (const key of NODE_ARGS) if (typeof out[key] === 'string') out[key] = byTitle(caller, out[key] as string)
    for (const key of NODE_LISTS) if (Array.isArray(out[key])) out[key] = (out[key] as unknown[]).map((v) => (typeof v === 'string' ? byTitle(caller, v) : v))
    return out
  }

  return async (callerId, verb, given) => {
    const caller = find(callerId)
    if (!caller) refuse(`Node "${callerId}" is no longer on the canvas.`)
    const args = withIds(caller, given)
    const archived = archivedRefusal(store.get(), caller, args)
    if (archived) refuse(archived)
    if (verb.startsWith('task-')) {
      if (!tasks) refuse('Tasks are not available here.')
      return taskVerb(tasks, caller, verb, args)
    }
    if (BROWSER_VERBS.includes(verb)) {
      if (!browserVerb) refuse('Browser nodes are not available here.')
      return browserVerb(callerId, verb, args)
    }
    switch (verb) {
      case 'whoami': {
        const w = { ...whoami(store.get(), callerId, accessOf, (id) => tracker.get(id)), agents: agents() }
        return { ...w, text: describeWhoAmI(w) }
      }
      case 'list':
        return listNodes(callerId)
      case 'open-terminal':
        return openTerminal(caller, args)
      case 'open-agent':
        return openAgent(caller, args)
      case 'open-browser':
        return openBrowser(caller, args)
      case 'spawn-team':
        return spawnTeam(caller, args)
      case 'group':
        return group(caller, args)
      case 'arrange':
        return arrange(caller, args)
      case 'rename':
        return rename(caller, args)
      case 'sticky':
        return sticky(caller, args)
      case 'note':
        return note(callerId, args)
      case 'wait':
        return wait(callerId, args)
      case 'open-whiteboard':
        return openWhiteboard(caller, args)
      case 'whiteboard':
        return whiteboard(callerId, args)
      case 'draw':
        return draw(callerId, args)
      case 'link':
        return link(callerId, args)
      case 'read':
        return read(callerId, args)
      case 'send':
        return send(callerId, args)
      case 'close':
        return close(callerId, args)
      case 'issues':
      case 'prs':
        return githubVerb(caller, verb, args)
      default:
        return refuse(`Unknown verb "${verb}".`)
    }
  }
}
