import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { lastLines, readTranscript, stripAnsi } from '../../core/transcript/read'
import { BLANK, checkUrl, TIMEOUTS } from '../../shared/browserPolicy'
import type { BrowserDriver } from '../browser/driver'
import type { CanvasStore, SessionHost } from '../../shared/contract'
import type { GithubIssue, GithubPr } from '../../shared/git'
import { agentOf, isSessionNode, type AgentKind, type BrowserNode, type CanvasDoc, type CanvasNode, type ClaudeNode, type Edge, type GroupNode, type StickyNode, type TerminalNode, type WhiteboardNode } from '../../shared/model'
import type { WhiteboardExporter } from '../whiteboardExport'
import { describeWhoAmI, quoteTitle, whoami } from './whoami'
import type { NodeRunner } from '../sessions/nodeRunner'
import type { StatusTracker } from '../sessions/statusTracker'
import type { AfterGate } from './after'
import { isArmed } from '../../core/trigger/arming'
import { describeSchedule } from '../../core/trigger/schedule'
import { BROWSER_VERBS, createBrowserVerbs } from './browserVerbs'
import { createSendQueue, DEFAULT_SEND_TIMING, plainText, type SendQueue, type SendTiming } from './sendQueue'
import { RpcRefusal } from './server'

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

/** Beside the opener, moving down until nothing top-level is in the way. */
export function spotNear(doc: CanvasDoc, opener: CanvasNode, size: { width: number; height: number }): { x: number; y: number } {
  const from = absolute(doc, opener)
  const x = from.x + opener.width + GAP
  let y = from.y
  const clash = (): CanvasNode | undefined =>
    doc.nodes.find(
      (n) => !n.parentId && x < n.x + n.width && n.x < x + size.width && y < n.y + n.height && n.y < y + size.height
    )
  for (let hit = clash(); hit; hit = clash()) y = hit.y + hit.height + GAP
  return { x, y }
}

function belowChildren(doc: CanvasDoc, groupId: string): { x: number; y: number } {
  const inside = doc.nodes.filter((n) => n.parentId === groupId)
  return {
    x: GROUP_PADDING,
    y: inside.length ? Math.max(...inside.map((n) => n.y + n.height)) + GROUP_PADDING : GROUP_TOP
  }
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
  defaultAgent = () => 'claude'
}: {
  /** Turns a board into files an agent can open. Without it, boards can still be read as text. */
  whiteboards?: WhiteboardExporter
  /** Settings > Default agent, read at each call. */
  defaultAgent?: () => AgentKind
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

  const linked = (a: string, b: string): boolean =>
    store.get().edges.some((e) => e.kind === 'link' && ((e.from === a && e.to === b) || (e.from === b && e.to === a)))

  const accessOf = (caller: string, node: CanvasNode): 'opened' | 'linked' | null =>
    node.openedBy === caller ? 'opened' : linked(caller, node.id) ? 'linked' : null

  const reachable = (caller: string, id: string, action: string): CanvasNode => {
    const node = existing(id)
    if (!accessOf(caller, node)) refuse(`Can't ${action} node "${id}": it isn't linked to you and you didn't open it.`)
    return node
  }

  const groupFor = (caller: CanvasNode, args: Args): GroupNode | null => {
    const id = optional(args, 'group')
    if (id === undefined) return null
    const node = ownProject(caller, id)
    if (node.kind !== 'group') refuse(`Node "${id}" is not a group.`)
    return node
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
    ...(group ? belowChildren(store.get(), group.id) : spotNear(store.get(), caller, size)),
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
      if (!host.isRunning(id)) refuse(`Node "${id}" is not running.`)
      sendQueue.type(id, raw)
      return { delivered: true }
    }
    if (node.kind !== 'claude') refuse(`Can't send to node "${id}": it isn't a terminal or an agent node.`)
    if (tracker.get(id) === 'exited') refuse(`Node "${id}" has exited, so nothing would read this.`)
    const body = plainText(raw)
    if (!body.trim()) refuse('--text has nothing to send.')
    const text = `${senderLine(caller)}\n${body}`
    return sendQueue.add(id, { text }) === 'queued' ? { delivered: false, queued: true } : { delivered: true }
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
        if (!node.transcriptPath) refuse(`Node "${id}" has no transcript yet.`)
        try {
          return { text: readTranscript(node.transcriptPath, count) }
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          return refuse(`The transcript for node "${id}" no longer exists.`)
        }
    }
  }

  // opening nodes

  const openAgent = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    const group = groupFor(caller, args)
    const cwd = cwdFor(args, caller, group)
    const prompt = promptFrom(args)
    const after = list(args, 'after')
    const agent = agentArg(args, defaultAgent())
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
    const cwd = cwdFor(args, caller, group)
    const command = optional(args, 'command')
    const node: TerminalNode = {
      ...placement(caller, group, SIZES.terminal),
      id: randomUUID(),
      kind: 'terminal',
      title: optional(args, 'title') || (command ? command.split(/\s+/)[0] : 'Terminal'),
      cwd
    }
    if (command) node.command = command
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
      return { name, id: ids.get(name)!, agent: agentArg(m, defaultAgent()), prompt: promptFrom(m), cwd: cwdFor(m, caller, null), after }
    })
    refuseCycles(plans)
    return plans
  }

  /** Everything is checked before the first change, so a bad team leaves the canvas alone. */
  const spawnTeam = async (caller: CanvasNode, args: Args): Promise<unknown> => {
    const label = required(args, 'label')
    const color = optional(args, 'color')
    const plans = planMembers(caller, args.members)

    const group: GroupNode = {
      ...placement(caller, null, SIZES.group),
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

  return async (callerId, verb, args) => {
    const caller = find(callerId)
    if (!caller) refuse(`Node "${callerId}" is no longer on the canvas.`)
    if (BROWSER_VERBS.includes(verb)) {
      if (!browserVerb) refuse('Browser nodes are not available here.')
      return browserVerb(callerId, verb, args)
    }
    switch (verb) {
      case 'whoami': {
        const w = whoami(store.get(), callerId, accessOf, (id) => tracker.get(id))
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
      case 'open-whiteboard':
        return openWhiteboard(caller, args)
      case 'whiteboard':
        return whiteboard(callerId, args)
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
