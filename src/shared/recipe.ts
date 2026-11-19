import type { AgentKind, CanvasNode, ClaudeNode, Edge, GroupNode } from './model'

/**
 * A recipe: the intended configuration of a set of nodes, to make again from scratch. It never holds session ids,
 * transcripts, node ids, run results or anything else live. See docs/plans/recipes.md.
 */

export const RECIPE_SCHEMA = 1
const MAX_NODES = 40
const MAX_PROMPT_CHARS = 28000

export type RecipeSource = 'built-in' | 'personal' | 'repository'

export interface RecipeLayout {
  x: number
  y: number
  width: number
  height: number
}

interface RecipeNodeBase {
  /** Names the node within the recipe. `{{node:KEY}}` in text becomes the new node's id. */
  key: string
  title: string
  layout: RecipeLayout
  /** A recipe group the node sits in. */
  parent?: string
  color?: string
}

export interface RecipeAgent extends RecipeNodeBase {
  kind: 'agent'
  agent: AgentKind
  prompt?: string
  /** Relative to the working directory. Absent means the working directory itself. */
  folder?: string
  /** Agents in this recipe it starts after, as with starts-after. */
  after?: string[]
  /** Whether it waits for the setup steps. Default true. */
  waitsForSetup?: boolean
}

export interface RecipeTerminal extends RecipeNodeBase {
  kind: 'terminal'
  folder?: string
  /** Typed into the person's own shell. */
  command?: string
  sshHost?: string
}

/** A run command, started only when its Run button is clicked. */
export interface RecipeRun extends RecipeNodeBase {
  kind: 'run'
  folder?: string
  /** Run by the person's own shell, as a run node always is. */
  command?: string
  /** A configuration in the working directory's .vscode/launch.json, in place of a command. */
  launch?: string
}

/** A command that runs when the recipe starts. Agents wait until it exits with code 0. */
export interface RecipeSetup extends RecipeNodeBase {
  kind: 'setup'
  folder?: string
  /** The program and its arguments, run with no shell between. */
  run: string[]
}

export interface RecipeNote extends RecipeNodeBase {
  kind: 'note'
  text: string
}

export interface RecipeBrowser extends RecipeNodeBase {
  kind: 'browser'
  url: string
}

export interface RecipeGroup extends RecipeNodeBase {
  kind: 'group'
}

export type RecipeNode = RecipeAgent | RecipeTerminal | RecipeRun | RecipeSetup | RecipeNote | RecipeBrowser | RecipeGroup

export interface Recipe {
  schema: typeof RECIPE_SCHEMA
  name: string
  description?: string
  /** Whether starting it makes a new worktree for the branch by default. */
  worktree?: boolean
  /** The group everything is made in. */
  frame?: { title?: string; color?: string; width?: number; height?: number }
  nodes: RecipeNode[]
  /** Context links: either end can read and message the other. */
  links?: Array<{ from: string; to: string }>
}

/** A recipe as listed: where it came from, and what's wrong with it if it can't be used. */
export interface RecipeEntry {
  /** `source:name`, or `source:file` for one that couldn't be read. */
  ref: string
  source: RecipeSource
  name: string
  description?: string
  /** The file it was read from. Absent for built-in recipes. */
  file?: string
  recipe?: Recipe
  /** Names exactly this content, so Start can refuse a recipe that changed after its preview was shown. */
  hash?: string
  problem?: string
}

export interface RecipeParams {
  task: string
  branch: string
  /** The repository a worktree is made from. */
  repo: string
  /** The working directory. With a new worktree, its folder replaces this. */
  cwd: string
  worktree: boolean
  /** Setup steps to leave out of this start, by key. */
  skip?: string[]
  /** Setup step arguments changed for this start, by key. */
  runs?: Record<string, string[]>
}

// Reading

type Raw = Record<string, unknown>
const isObject = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v)
const isText = (v: unknown): v is string => typeof v === 'string'
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const KEY = /^[A-Za-z0-9_-]{1,40}$/
const NODE_REF = /\{\{\s*node:([A-Za-z0-9_-]+)\s*\}\}/g

export class RecipeError extends Error {}

function fail(message: string): never {
  throw new RecipeError(message)
}

function text(raw: Raw, field: string, where: string, max = 2000): string | undefined {
  const v = raw[field]
  if (v === undefined) return undefined
  if (!isText(v)) fail(`${where}: "${field}" must be text.`)
  if (v.length > max) fail(`${where}: "${field}" is longer than ${max} characters.`)
  return v
}

function layoutOf(raw: unknown, where: string): RecipeLayout {
  if (!isObject(raw) || !isNum(raw.x) || !isNum(raw.y) || !isNum(raw.width) || !isNum(raw.height)) fail(`${where}: "layout" needs x, y, width and height.`)
  return { x: raw.x, y: raw.y, width: Math.max(120, raw.width), height: Math.max(80, raw.height) }
}

function nodeOf(raw: unknown, i: number): RecipeNode {
  if (!isObject(raw)) fail(`Node ${i + 1} isn't an object.`)
  const key = raw.key
  if (!isText(key) || !KEY.test(key)) fail(`Node ${i + 1}: "key" must be letters, digits, - or _.`)
  const where = `Node "${key}"`
  const base: RecipeNodeBase = { key, title: text(raw, 'title', where, 200) ?? key, layout: layoutOf(raw.layout, where) }
  const parent = text(raw, 'parent', where, 40)
  if (parent !== undefined) base.parent = parent
  const color = text(raw, 'color', where, 40)
  if (color !== undefined) base.color = color
  const folder = text(raw, 'folder', where, 1000)
  const withFolder = <T extends object>(n: T): T => (folder !== undefined ? { ...n, folder } : n)
  switch (raw.kind) {
    case 'agent': {
      const agent = raw.agent ?? 'claude'
      if (agent !== 'claude' && agent !== 'codex') fail(`${where}: "agent" must be claude or codex.`)
      const node: RecipeAgent = withFolder({ ...base, kind: 'agent' as const, agent })
      const prompt = text(raw, 'prompt', where, MAX_PROMPT_CHARS)
      if (prompt !== undefined) node.prompt = prompt
      if (raw.after !== undefined) {
        if (!Array.isArray(raw.after) || !raw.after.every(isText)) fail(`${where}: "after" must be a list of node keys.`)
        node.after = [...raw.after]
      }
      if (raw.waitsForSetup !== undefined) {
        if (typeof raw.waitsForSetup !== 'boolean') fail(`${where}: "waitsForSetup" must be true or false.`)
        node.waitsForSetup = raw.waitsForSetup
      }
      return node
    }
    case 'terminal': {
      const node: RecipeTerminal = withFolder({ ...base, kind: 'terminal' as const })
      const command = text(raw, 'command', where)
      if (command) node.command = command
      const sshHost = text(raw, 'sshHost', where, 200)
      if (sshHost) node.sshHost = sshHost
      return node
    }
    case 'run': {
      const node: RecipeRun = withFolder({ ...base, kind: 'run' as const })
      const command = text(raw, 'command', where)
      const launch = text(raw, 'launch', where, 200)
      if (!command === !launch) fail(`${where}: a run node needs one of "command" or "launch".`)
      if (command) node.command = command
      if (launch) node.launch = launch
      return node
    }
    case 'setup': {
      const run = raw.run
      if (!Array.isArray(run) || run.length === 0 || !run.every(isText) || !run[0]) {
        fail(`${where}: "run" must be the program and its arguments, as a list, like ["npm", "install"].`)
      }
      return withFolder({ ...base, kind: 'setup' as const, run: [...run] })
    }
    case 'note':
      return { ...base, kind: 'note', text: text(raw, 'text', where, 20000) ?? '' }
    case 'browser':
      return { ...base, kind: 'browser', url: text(raw, 'url', where) ?? 'about:blank' }
    case 'group':
      return { ...base, kind: 'group' }
    default:
      return fail(`${where}: unknown kind ${JSON.stringify(raw.kind)}.`)
  }
}

/** Checks a recipe read from a file, keeping only the fields it knows. Throws a RecipeError saying what's wrong. */
export function readRecipe(raw: unknown): Recipe {
  if (!isObject(raw)) fail('A recipe must be a JSON object.')
  if (raw.schema !== RECIPE_SCHEMA) fail(`Unknown recipe schema ${JSON.stringify(raw.schema)}. This version of Patchbay reads schema ${RECIPE_SCHEMA}.`)
  const name = text(raw, 'name', 'The recipe', 120)?.trim()
  if (!name) fail('The recipe needs a name.')
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) fail('The recipe has no nodes.')
  if (raw.nodes.length > MAX_NODES) fail(`The recipe has more than ${MAX_NODES} nodes.`)
  const nodes = raw.nodes.map(nodeOf)
  const recipe: Recipe = { schema: RECIPE_SCHEMA, name, nodes }
  const description = text(raw, 'description', 'The recipe')
  if (description) recipe.description = description
  if (raw.worktree !== undefined) {
    if (typeof raw.worktree !== 'boolean') fail('"worktree" must be true or false.')
    recipe.worktree = raw.worktree
  }
  if (raw.frame !== undefined) {
    if (!isObject(raw.frame)) fail('"frame" must be an object.')
    const frame: NonNullable<Recipe['frame']> = {}
    const title = text(raw.frame, 'title', 'The frame', 200)
    if (title !== undefined) frame.title = title
    const color = text(raw.frame, 'color', 'The frame', 40)
    if (color !== undefined) frame.color = color
    if (isNum(raw.frame.width)) frame.width = raw.frame.width
    if (isNum(raw.frame.height)) frame.height = raw.frame.height
    recipe.frame = frame
  }
  if (raw.links !== undefined) {
    if (!Array.isArray(raw.links) || !raw.links.every((l) => isObject(l) && isText(l.from) && isText(l.to))) fail('"links" must be a list of {"from", "to"}.')
    recipe.links = raw.links.map((l) => ({ from: (l as Raw).from as string, to: (l as Raw).to as string }))
  }
  checkReferences(recipe)
  return recipe
}

function checkReferences(recipe: Recipe): void {
  const byKey = new Map<string, RecipeNode>()
  for (const n of recipe.nodes) {
    if (byKey.has(n.key)) fail(`Two nodes have the key "${n.key}".`)
    byKey.set(n.key, n)
  }
  for (const n of recipe.nodes) {
    if (n.parent !== undefined) {
      if (byKey.get(n.parent)?.kind !== 'group') fail(`Node "${n.key}": its parent "${n.parent}" isn't a group in this recipe.`)
      // A parent must not end up inside its own child.
      const seen = new Set([n.key])
      for (let p = byKey.get(n.parent); p; p = p.parent ? byKey.get(p.parent) : undefined) {
        if (seen.has(p.key)) fail(`Node "${n.key}" is inside itself.`)
        seen.add(p.key)
      }
    }
    if (n.kind === 'agent') {
      for (const up of n.after ?? []) {
        if (up === n.key) fail(`Agent "${n.key}" can't start after itself.`)
        if (byKey.get(up)?.kind !== 'agent') fail(`Agent "${n.key}" starts after "${up}", which isn't an agent in this recipe.`)
      }
    }
    for (const ref of nodeRefs(n)) if (!byKey.has(ref)) fail(`Node "${n.key}" mentions {{node:${ref}}}, which isn't in this recipe.`)
  }
  for (const l of recipe.links ?? []) {
    if (!byKey.has(l.from) || !byKey.has(l.to)) fail(`A link names a node that isn't in this recipe: ${l.from} to ${l.to}.`)
    if (l.from === l.to) fail(`A link joins "${l.from}" to itself.`)
  }
  // Starts-after must not loop, or none of them would ever start.
  const done = new Set<string>()
  const visit = (key: string, path: Set<string>): void => {
    if (path.has(key)) fail(`Agent "${key}" ends up waiting on itself.`)
    if (done.has(key)) return
    path.add(key)
    const n = byKey.get(key)
    if (n?.kind === 'agent') for (const up of n.after ?? []) visit(up, path)
    path.delete(key)
    done.add(key)
  }
  for (const n of recipe.nodes) visit(n.key, new Set())
}

function nodeRefs(n: RecipeNode): string[] {
  const texts = [n.title, n.kind === 'agent' ? n.prompt : undefined, n.kind === 'note' ? n.text : undefined].filter(isText)
  return texts.flatMap((t) => [...t.matchAll(NODE_REF)].map((m) => m[1]))
}

// Parameters

/** Fills in {{task}}, {{branch}}, {{repo}}, {{cwd}} and {{node:KEY}}. Anything else in braces is left as it is. */
export function fillIn(template: string, values: { task: string; branch: string; repo: string; cwd: string }, ids: Record<string, string> = {}): string {
  return template.replace(/\{\{\s*(task|branch|repo|cwd|node:([A-Za-z0-9_-]+))\s*\}\}/g, (whole, name: string, key?: string) => {
    if (key !== undefined) return ids[key] ?? whole
    return values[name as 'task' | 'branch' | 'repo' | 'cwd']
  })
}

const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/

export function isAbsoluteFolder(folder: string): boolean {
  return ABSOLUTE.test(folder)
}

/**
 * A recipe folder against the working directory, with . and .. worked out. Windows paths, without node:path, so the
 * page can use it too.
 */
export function folderIn(cwd: string, folder: string | undefined): string {
  if (!folder || folder === '.' || folder === './') return cwd
  if (isAbsoluteFolder(folder)) return folder
  const sep = cwd.includes('\\') || !cwd.includes('/') ? '\\' : '/'
  const root = cwd.replace(/[\\/]+$/, '')
  const parts = root.split(/[\\/]/)
  for (const part of folder.split(/[\\/]+/)) {
    if (!part || part === '.') continue
    // The drive is never climbed past.
    if (part === '..') {
      if (parts.length > 1) parts.pop()
    } else parts.push(part)
  }
  return parts.join(sep)
}

/** Whether a folder is the working directory or inside it, ignoring case and slashes, as Windows does. */
export function isInside(cwd: string, folder: string): boolean {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  return norm(folder) === norm(cwd) || norm(folder).startsWith(`${norm(cwd)}\\`)
}

/** Shell characters that would make splitting a command on spaces mean something else than the shell would. */
const SHELL_SYNTAX = /["'`$%^&|<>;(){}*?!~\\\r\n]/

/** What someone expecting a shell would type: quoting, chaining, redirection and substitution. */
const SHELL_ONLY = /["'`$&|<>;()\r\n]/
/** Characters some shell acts on, which a parameter must not bring into a command a shell runs. */
const SHELL_ACTS_ON = /["'`$&|<>;()%^!\r\n]/

/**
 * A command as an argument list, when splitting it on spaces means exactly what a shell would. Null otherwise.
 * `noShell` is for text that never reaches a shell, as a setup step's arguments: only what someone expecting a shell
 * would type is refused, so paths with backslashes and {{task}} still split.
 */
export function toArgv(command: string, noShell = false): string[] | null {
  const trimmed = command.trim()
  if (!trimmed || (noShell ? SHELL_ONLY : SHELL_SYNTAX).test(trimmed)) return null
  return trimmed.split(/\s+/)
}

/** An argument list as text to show, with quotes only around arguments that need them. */
export function showArgv(argv: string[]): string {
  return argv.map((a) => (a === '' || /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

// Planning

export const RECIPE_SIZES = {
  agent: { width: 620, height: 420 },
  terminal: { width: 560, height: 340 },
  run: { width: 560, height: 300 },
  setup: { width: 560, height: 300 },
  note: { width: 280, height: 220 },
  browser: { width: 760, height: 560 },
  group: { width: 640, height: 400 }
}
export const FRAME_PADDING = 24
export const FRAME_TOP = 64

export interface PlannedSetup {
  id: string
  key: string
  title: string
  argv: string[]
  cwd: string
}

/** What starting a recipe will make. Pure: the same recipe, parameters and ids always give the same plan. */
export interface RecipePlan {
  frame: GroupNode
  /** Inside the frame, parents before children, positions relative to their parent. */
  nodes: CanvasNode[]
  edges: Edge[]
  setup: PlannedSetup[]
  /** Agents waiting for setup: the setup node ids, and the agents they start after once it's done. */
  holds: Record<string, { steps: string[]; after: string[] }>
  /** Agents with no setup to wait for that start after other agents. */
  after: Record<string, string[]>
  /** Sessions to start at once: agents with nothing to wait for, and terminals. */
  starts: string[]
  /** Everything that runs when Start is pressed, as shown in the preview. */
  runs: Array<{ title: string; what: string; how: 'no shell' | 'your shell' | 'ssh'; cwd: string }>
  warnings: string[]
  /** Why it can't start as it is. Start is refused while there are any. */
  problems: string[]
  /** Recipe key to new node id. */
  ids: Record<string, string>
}

/**
 * Works out the nodes, connections and holds for one start. A recipe's node references all resolve to the ids made
 * here, so two starts of one recipe never share a node.
 */
export function planRecipe(recipe: Recipe, params: RecipeParams, newId: () => string): RecipePlan {
  const ids: Record<string, string> = {}
  for (const n of recipe.nodes) ids[n.key] = newId()
  const values = { task: params.task, branch: params.branch, repo: params.repo, cwd: params.cwd }
  const fill = (t: string): string => fillIn(t, values, ids)
  const skipped = new Set(params.skip ?? [])
  const used = recipe.nodes.filter((n) => !(n.kind === 'setup' && skipped.has(n.key)))
  const warnings: string[] = []
  const problems: string[] = []
  /**
   * A command a shell runs, filled in. Which shell (Git Bash, PowerShell or cmd) isn't known here, so a value can't be
   * quoted for it: one with characters any of them acts on is refused rather than run.
   */
  const fillShell = (template: string, title: string): string => {
    for (const m of template.matchAll(/\{\{\s*(task|branch|repo|cwd)\s*\}\}/g)) {
      const name = m[1] as keyof typeof values
      const bad = values[name].match(SHELL_ACTS_ON)?.[0]
      const why = `"${title}" puts the ${name} into a command your shell runs, and the ${name} has a character the shell would act on (${JSON.stringify(bad)}). Change the ${name}, or the recipe.`
      if (bad && !problems.includes(why)) problems.push(why)
    }
    return fill(template)
  }

  const frameTitle = fill(recipe.frame?.title ?? (params.task ? `${recipe.name}: {{task}}` : params.branch ? `${recipe.name}: {{branch}}` : recipe.name))
  const right = Math.max(...used.filter((n) => !n.parent).map((n) => n.layout.x + n.layout.width), 0) + FRAME_PADDING
  const bottom = Math.max(...used.filter((n) => !n.parent).map((n) => n.layout.y + n.layout.height), 0) + FRAME_PADDING
  const frame: GroupNode = {
    id: newId(),
    kind: 'group',
    title: frameTitle.slice(0, 200),
    x: 0,
    y: 0,
    width: Math.max(recipe.frame?.width ?? 0, right, RECIPE_SIZES.group.width),
    height: Math.max(recipe.frame?.height ?? 0, bottom, RECIPE_SIZES.group.height),
    parentId: null,
    worktree: null
  }
  if (recipe.frame?.color) frame.color = recipe.frame.color

  const folderOf = (n: { folder?: string; key: string }): string => {
    const folder = n.folder === undefined ? undefined : fill(n.folder)
    const resolved = folderIn(params.cwd, folder)
    // A folder named from {{repo}} is outside a new worktree on purpose.
    const named = !!n.folder && /\{\{\s*(cwd|repo)\s*\}\}/.test(n.folder)
    const why = `"${n.key}" uses the folder ${resolved}, which isn't part of the working directory.`
    if (folder && !named && !isInside(params.cwd, resolved) && !warnings.includes(why)) warnings.push(why)
    return resolved
  }

  const nodes: CanvasNode[] = []
  const setup: PlannedSetup[] = []
  const runs: RecipePlan['runs'] = []
  // Parents before children: groups by depth first.
  const depth = (n: RecipeNode): number => (n.parent ? 1 + depth(recipe.nodes.find((p) => p.key === n.parent)!) : 0)
  const ordered = [...used].sort((a, b) => depth(a) - depth(b))
  for (const n of ordered) {
    const base = {
      id: ids[n.key],
      title: fill(n.title).slice(0, 200),
      ...n.layout,
      parentId: n.parent ? ids[n.parent] : frame.id,
      ...(n.color ? { color: n.color } : {})
    }
    switch (n.kind) {
      case 'agent': {
        const node: ClaudeNode = { ...base, kind: 'claude', ...(n.agent === 'codex' ? { agent: 'codex' as const } : {}), cwd: folderOf(n), sessionId: null, transcriptPath: null, after: [] }
        if (n.prompt) node.prompt = fill(n.prompt)
        nodes.push(node)
        break
      }
      case 'terminal': {
        const command = n.command ? fillShell(n.command, base.title) : undefined
        const cwd = folderOf(n)
        nodes.push({ ...base, kind: 'terminal', cwd, ...(command ? { command } : {}), ...(n.sshHost ? { sshHost: n.sshHost } : {}) })
        // An SSH terminal connects as soon as it starts, so it's listed with what runs.
        if (n.sshHost) runs.push({ title: base.title, what: `ssh ${n.sshHost}${command ? `, then ${command}` : ''}`, how: 'ssh', cwd })
        else if (command) runs.push({ title: base.title, what: command, how: 'your shell', cwd })
        break
      }
      case 'run': {
        const cwd = folderOf(n)
        if (n.launch) nodes.push({ ...base, kind: 'run', cwd, command: `launch.json: ${n.launch}`, launch: { folder: cwd, name: n.launch } })
        else nodes.push({ ...base, kind: 'run', cwd, command: fillShell(n.command ?? '', base.title) })
        break
      }
      case 'setup': {
        const argv = (params.runs?.[n.key] ?? n.run).map(fill)
        const cwd = folderOf(n)
        // The command is set when the plan file is written. Until then it says what it will run.
        nodes.push({ ...base, kind: 'run', cwd, command: showArgv(argv) })
        setup.push({ id: base.id, key: n.key, title: base.title, argv, cwd })
        runs.push({ title: base.title, what: showArgv(argv), how: 'no shell', cwd })
        break
      }
      case 'note':
        nodes.push({ ...base, kind: 'sticky', text: fill(n.text) })
        break
      case 'browser':
        nodes.push({ ...base, kind: 'browser', url: fill(n.url) })
        break
      case 'group':
        nodes.push({ ...base, kind: 'group', worktree: null })
        break
    }
  }

  const edges: Edge[] = []
  const edge = (from: string, to: string, kind: Edge['kind']): void => void edges.push({ id: newId(), from, to, kind })
  for (const l of recipe.links ?? []) if (ids[l.from] && ids[l.to] && used.some((n) => n.key === l.from) && used.some((n) => n.key === l.to)) edge(ids[l.from], ids[l.to], 'link')

  const holds: RecipePlan['holds'] = {}
  const afterOnly: RecipePlan['after'] = {}
  const starts: string[] = []
  const stepIds = setup.map((s) => s.id)
  for (const n of used) {
    if (n.kind === 'terminal') starts.push(ids[n.key])
    if (n.kind !== 'agent') continue
    const after = (n.after ?? []).map((k) => ids[k])
    for (const up of after) edge(up, ids[n.key], 'after')
    if (stepIds.length && n.waitsForSetup !== false) holds[ids[n.key]] = { steps: [...stepIds], after }
    else if (after.length) afterOnly[ids[n.key]] = after
    else starts.push(ids[n.key])
  }
  if (!params.worktree) {
    const agents = used.filter((n) => n.kind === 'agent').length
    if (agents > 1) warnings.push('These agents share one checkout. Patchbay does not isolate or lock files between them, so they can overwrite each other\'s changes.')
  }
  return { frame, nodes, edges, setup, holds, after: afterOnly, starts, runs, warnings, problems, ids }
}

// Saving a selection

export interface SaveOptions {
  name: string
  description?: string
  /** The working directory the saved folders are made relative to: the selection's worktree, or the project folder. */
  cwd: string
  /** Replaced by {{branch}} wherever it appears. */
  branch?: string
  /** Run nodes to save as setup steps, by id. */
  setupIds?: string[]
}

export interface SavedRecipe {
  recipe: Recipe
  /** Nodes in the selection that aren't saved, and why. */
  skipped: Array<{ title: string; why: string }>
  /** Run nodes asked to be setup steps that stayed run commands, and why. */
  notSetup: Array<{ title: string; why: string }>
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Where a saved text names the branch, to become {{branch}}. A name that is a plain word, such as docs or fix, is also
 * an ordinary word, so it's only taken where it reads as a branch: after checkout, switch, -b or branch, in backticks,
 * or as a folder in a path. A name with -, /, _, . or a digit, such as dark-mode, is taken wherever it stands alone.
 */
export function branchPatterns(branch: string | undefined): RegExp[] {
  if (!branch || branch.length < 2) return []
  const b = escapeRegExp(branch)
  if (/[-/_.\d]/.test(branch)) return [new RegExp(`(?<![\\w/-])${b}(?![\\w/-])`, 'g')]
  return [
    new RegExp(`(?<=\\b(?:checkout|switch|branch|-b|-B|--branch)\\s+)${b}(?![\\w/-])`, 'g'),
    new RegExp(`(?<=\`)${b}(?=\`)`, 'g'),
    new RegExp(`(?<=[\\\\/])${b}(?=[\\\\/]|$|\\s)`, 'g')
  ]
}

function slug(title: string): string {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24)
  return s || 'node'
}

/** A folder as the recipe keeps it: relative when it's inside the working directory. */
export function relativeFolder(cwd: string, folder: string): string | undefined {
  const norm = (p: string): string => p.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const base = norm(cwd)
  const f = norm(folder)
  if (!base) return folder
  if (f === base) return undefined
  if (f.startsWith(`${base}\\`)) return folder.replace(/\//g, '\\').slice(base.length + 1).replace(/\\+$/, '')
  return folder
}

/**
 * Turns the selected nodes into a recipe: their kinds and settings, layout relative to each other, prompts and
 * connections. Ids, sessions and anything else live stay behind. A selected group brings what's inside it.
 */
export function recipeFromSelection(nodes: CanvasNode[], edges: Edge[], selected: string[], opts: SaveOptions): SavedRecipe {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const chosen = new Set<string>()
  const add = (id: string): void => {
    if (chosen.has(id) || !byId.has(id)) return
    chosen.add(id)
    for (const n of nodes) if (n.parentId === id) add(n.id)
  }
  selected.forEach(add)
  const skipped: SavedRecipe['skipped'] = []
  const notSetup: SavedRecipe['notSetup'] = []
  const kept = nodes.filter((n) => {
    if (!chosen.has(n.id)) return false
    if (n.kind === 'trigger') skipped.push({ title: n.title, why: 'Triggers are armed by hand, so they are not saved.' })
    else if (n.kind === 'whiteboard') skipped.push({ title: n.title, why: 'Whiteboards are not saved in recipes.' })
    else return true
    return false
  })
  if (!kept.length) fail('Nothing selected can be saved in a recipe.')

  // One selected group with everything inside it becomes the frame, not a group of its own.
  const tops = kept.filter((n) => !n.parentId || !chosen.has(n.parentId))
  const frameGroup = tops.length === 1 && tops[0].kind === 'group' ? tops[0] : null
  const inner = frameGroup ? kept.filter((n) => n !== frameGroup) : kept
  if (!inner.length) fail('That group is empty, so there is nothing to save.')

  const absolute = (n: CanvasNode): { x: number; y: number } => {
    let { x, y } = n
    const seen = new Set([n.id])
    for (let p = byId.get(n.parentId ?? ''); p && !seen.has(p.id); p = byId.get(p.parentId ?? '')) {
      seen.add(p.id)
      x += p.x
      y += p.y
    }
    return { x, y }
  }
  const innerIds = new Set(inner.map((n) => n.id))
  const isTop = (n: CanvasNode): boolean => !n.parentId || !innerIds.has(n.parentId)
  const topBoxes = inner.filter(isTop).map(absolute)
  const origin = frameGroup ? absolute(frameGroup) : { x: Math.min(...topBoxes.map((b) => b.x)) - FRAME_PADDING, y: Math.min(...topBoxes.map((b) => b.y)) - FRAME_TOP }

  const keys = new Map<string, string>()
  const usedKeys = new Set<string>()
  for (const n of inner) {
    let key = slug(n.title)
    for (let i = 2; usedKeys.has(key); i++) key = `${slug(n.title)}-${i}`
    usedKeys.add(key)
    keys.set(n.id, key)
  }

  const replacements: Array<[RegExp, string]> = [
    ...[...keys].map(([id, key]): [RegExp, string] => [new RegExp(`(?<![\\w-])${escapeRegExp(id)}(?![\\w-])`, 'g'), `{{node:${key}}}`]),
    ...(opts.cwd ? [[new RegExp(escapeRegExp(opts.cwd), 'gi'), '{{cwd}}'] as [RegExp, string]] : []),
    ...branchPatterns(opts.branch).map((re): [RegExp, string] => [re, '{{branch}}'])
  ]
  const generic = (t: string): string => replacements.reduce((s, [re, to]) => s.replace(re, to), t)
  const folder = (cwd: string): { folder?: string } => {
    const f = relativeFolder(opts.cwd, cwd)
    return f === undefined ? {} : { folder: f }
  }

  const asSetup = new Set(opts.setupIds ?? [])
  const out: RecipeNode[] = inner.map((n) => {
    const pos = isTop(n) ? absolute(n) : { x: n.x, y: n.y }
    const base: RecipeNodeBase = {
      key: keys.get(n.id)!,
      title: generic(n.title),
      layout: { x: isTop(n) ? pos.x - origin.x : pos.x, y: isTop(n) ? pos.y - origin.y : pos.y, width: n.width, height: n.height },
      ...(isTop(n) ? {} : { parent: keys.get(n.parentId!)! }),
      ...(n.color ? { color: n.color } : {})
    }
    switch (n.kind) {
      case 'claude': {
        const after = edges.filter((e) => e.kind === 'after' && e.to === n.id && keys.has(e.from) && byId.get(e.from)?.kind === 'claude').map((e) => keys.get(e.from)!)
        return { ...base, kind: 'agent', agent: n.agent ?? 'claude', ...folder(n.cwd), ...(n.prompt ? { prompt: generic(n.prompt) } : {}), ...(after.length ? { after: [...new Set(after)] } : {}) }
      }
      case 'terminal':
        return { ...base, kind: 'terminal', ...folder(n.cwd), ...(n.command ? { command: generic(n.command) } : {}), ...(n.sshHost ? { sshHost: n.sshHost } : {}) }
      case 'run': {
        if (n.launch) return { ...base, kind: 'run', ...folder(n.cwd), launch: n.launch.name }
        if (asSetup.has(n.id)) {
          const argv = toArgv(n.command)
          if (argv) return { ...base, kind: 'setup', ...folder(n.cwd), run: argv.map(generic) }
          notSetup.push({ title: n.title, why: 'It uses quotes or shell characters, so it is saved as a run command. To make it a setup step, edit the recipe and name the shell, as in ["cmd", "/d", "/c", "..."].' })
        }
        return { ...base, kind: 'run', ...folder(n.cwd), command: generic(n.command) }
      }
      case 'sticky':
        return { ...base, kind: 'note', text: generic(n.text) }
      case 'browser':
        return { ...base, kind: 'browser', url: n.url }
      case 'group':
        return { ...base, kind: 'group' }
      default:
        return fail(`Can't save a ${n.kind} node.`)
    }
  })

  const links: Array<{ from: string; to: string }> = []
  const seenLinks = new Set<string>()
  for (const e of edges) {
    if (e.kind !== 'link' || !keys.has(e.from) || !keys.has(e.to)) continue
    const id = [keys.get(e.from), keys.get(e.to)].sort().join('|')
    if (seenLinks.has(id)) continue
    seenLinks.add(id)
    links.push({ from: keys.get(e.from)!, to: keys.get(e.to)! })
  }

  const recipe: Recipe = { schema: RECIPE_SCHEMA, name: opts.name.trim(), nodes: out }
  if (opts.description?.trim()) recipe.description = opts.description.trim()
  recipe.worktree = !!(frameGroup?.kind === 'group' && frameGroup.worktree)
  if (frameGroup) recipe.frame = { title: generic(frameGroup.title), width: frameGroup.width, height: frameGroup.height, ...(frameGroup.color ? { color: frameGroup.color } : {}) }
  if (links.length) recipe.links = links
  // Read back through the same checks as a file, so what's saved can always be loaded.
  return { recipe: readRecipe(JSON.parse(JSON.stringify(recipe))), skipped, notSetup }
}

/** A file name for a recipe's name. */
export function recipeFileName(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'recipe'}.json`
}

/** Where a new worktree for this branch goes, as src/core/worktree/service.ts's defaultWorktreePath puts it. */
export function expectedWorktreePath(repo: string, branch: string): string {
  const root = repo.replace(/[\\/]+$/, '')
  const at = Math.max(root.lastIndexOf('\\'), root.lastIndexOf('/'))
  const sep = root.includes('\\') || !root.includes('/') ? '\\' : '/'
  return `${root.slice(0, at)}${sep}${root.slice(at + 1)}-worktrees${sep}${branch.replaceAll('/', '-')}`
}

/** A branch name suggested from a task. */
export function branchFor(task: string): string {
  const s = task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '')
  return s
}

// The page's calls to main

export interface RecipeStartResult {
  ok: true
  group: string
  ids: Record<string, string>
  worktree: { path: string; branch: string } | null
}

export interface RecipeBridge {
  /** Built-in, personal and the project's repository recipes. Reading them runs nothing. */
  list(projectId: string): Promise<{ entries: RecipeEntry[]; repo: string | null; folder: string }>
  /** Makes the nodes and starts what the preview showed. */
  start(a: { projectId: string; ref: string; hash?: string; params: RecipeParams; at?: { x: number; y: number } }): Promise<RecipeStartResult | { ok: false; reason: string }>
  save(a: { projectId: string; recipe: Recipe; where: 'personal' | 'repository'; overwrite?: boolean }): Promise<{ ok: true; file: string } | { ok: false; reason: string; exists?: boolean }>
  /** Clears an agent's setup hold and starts it. */
  startAnyway(nodeId: string): Promise<void>
  openRecipesFolder(projectId: string, where: 'personal' | 'repository'): Promise<void>
}
