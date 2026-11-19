import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { ClaudeNode } from '../../shared/model'
import { claudeAt, customLaunch, LOOKING_VERBS, programArgs, sessionEnv, type ClaudeLaunch, type ClaudeProgram, type SessionEnvContext } from './claudeLaunch'

export interface CodexLaunchContext extends SessionEnvContext {
  hookScript: string
  token: string
  /** Defaults to resolveCodex(). */
  codex?: ClaudeProgram
  codexCommand?: string
  /** The codexApproval setting: '' for Codex's own default, 'never' or 'bypass'. */
  codexApproval?: string
  /** Whether to pass --no-daemon. Defaults to asking the Codex program, and to true for a custom command. */
  noDaemon?: boolean
}

/**
 * The events Codex reports. Each one's command never changes between launches, because Codex asks the person to trust
 * a hook once and remembers it by its exact command. The node travels in the environment instead.
 *
 * No PreToolUse, as for Claude: it started Node before every tool call, and PostToolUse sets everything it did.
 */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop']

let located: string | null = null

export function resolveCodex(): ClaudeProgram {
  if (located && existsSync(located)) return claudeAt(located)
  let lines: string[] = []
  try {
    lines = execFileSync('where.exe', ['codex'], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).split(/\r?\n/).filter(Boolean)
  } catch {
    // Not found, said below.
  }
  located = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? null
  if (!located) throw new Error('The codex command was not found on PATH. Install it with npm install -g @openai/codex.')
  return claudeAt(located)
}

/** A TOML basic string. JSON's escapes are a subset TOML accepts. */
const toml = (s: string): string => JSON.stringify(s)

export function codexHookArgs(hookScript: string): string[] {
  const script = hookScript.replace(/\\/g, '/')
  return CODEX_HOOK_EVENTS.flatMap((event) => ['-c', `hooks.${event}=[{hooks=[{type="command",command=${toml(`node "${script}" ${event}`)}}]}]`])
}

/**
 * Patchbay as an MCP server. Codex starts it outside its sandbox, which keeps shell commands from reaching Patchbay's
 * local server, so this is how a Codex session drives the canvas. Only the node's three Patchbay variables are passed.
 */
export function codexMcpArgs(cliDir: string): string[] {
  const server = `${cliDir.replace(/\\/g, '/')}/patchbay-mcp.cjs`
  return [
    '-c',
    'mcp_servers.patchbay.command="node"',
    '-c',
    `mcp_servers.patchbay.args=[${toml(server)}]`,
    '-c',
    'mcp_servers.patchbay.env_vars=["PATCHBAY_NODE_ID","PATCHBAY_TOKEN","PATCHBAY_ENDPOINT_FILE"]'
  ]
}

/**
 * What Codex may do without asking. 'never' keeps its sandbox but never stops to ask: what the sandbox refuses goes
 * back to the model as a failure. 'bypass' asks nothing and runs without the sandbox. Anything else is Codex's own
 * default, which asks.
 */
export function codexApprovalArgs(mode: string | undefined): string[] {
  if (mode === 'never') return ['-c', 'approval_policy="never"']
  if (mode === 'bypass') return ['--dangerously-bypass-approvals-and-sandbox']
  return []
}

/**
 * Codex's shared background server (its "managed daemon", on by default since 0.157) runs hooks, MCP servers and shell
 * commands with the environment of whichever terminal started it. Patchbay tells nodes apart by PATCHBAY_NODE_ID and
 * PATCHBAY_TOKEN in that environment, so two nodes on one server could act as one another. Each node runs its own.
 */
export const CODEX_NO_DAEMON = '--no-daemon'

const noDaemonKnown = new Map<string, boolean>()

/**
 * Whether this Codex knows --no-daemon. One older than the shared server would refuse the flag and not start at all.
 * Asked once per program. When the answer can't be had, the flag is used: safer to fail visibly than to share.
 */
export function codexKnowsNoDaemon(codex: ClaudeProgram, ask: (file: string, args: string[]) => string = helpText): boolean {
  const key = [codex.file, ...codex.prefixArgs].join('\0')
  const known = noDaemonKnown.get(key)
  if (known !== undefined) return known
  let answer = true
  try {
    answer = ask(codex.file, programArgs(codex, ['--help'])).includes(CODEX_NO_DAEMON)
  } catch {
    // Unknown, so the flag stays.
  }
  noDaemonKnown.set(key, answer)
  return answer
}

function helpText(file: string, args: string[]): string {
  // programArgs builds cmd.exe's line as node-pty passes it: as written. Node would quote it again.
  const verbatim = /^cmd(\.exe)?$/i.test(basename(file))
  const run = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, stdio: 'pipe', timeout: 15_000, windowsVerbatimArguments: verbatim })
  if (run.error) throw run.error
  return `${run.stdout}${run.stderr}`
}

/** The tool Codex calls Patchbay's MCP server by, as its permission requests name it. */
export const CODEX_PATCHBAY_TOOL = 'mcp__patchbay__patchbay'

/**
 * A Codex call to Patchbay that only looks, which goes ahead without asking, as the same verbs do for Claude through
 * its settings. Codex has no such rules, so without this every `whoami` and `guide` stopped at a prompt.
 */
export function isLookingCall(toolName: unknown, toolInput: unknown): boolean {
  if (toolName !== CODEX_PATCHBAY_TOOL) return false
  const args = (toolInput as { args?: unknown } | null)?.args
  return Array.isArray(args) && typeof args[0] === 'string' && LOOKING_VERBS.includes(args[0])
}

/** Codex can't load Patchbay's skill as Claude does, so the guide comes through the patchbay tool. */
export function codexInstructions(): string {
  return [
    'This session is a node on a Patchbay canvas, next to other agents (Claude Code and Codex) and terminals the person can watch.',
    'The `patchbay` MCP tool opens other agents and terminals, spawns teams, and reads from and sends to other nodes.',
    'Its sandbox-free route is the tool, not the shell: a `patchbay` shell command is usually blocked by the sandbox.',
    'Before using it the first time, call the tool with args ["guide"], which explains every verb and its rules.',
    'Call it with ["whoami"] to see which node you are, who opened you and who you work with.',
    'A message that starts with "[Patchbay message from ...]" came from another node, not from the person.',
    'Use it when asked to work in parallel, hand work to another agent, or check on one.'
  ].join(' ')
}

/** Describes how to launch a Codex node. Codex picks its own session id, which arrives with SessionStart. */
export function buildCodexLaunch(node: ClaudeNode, ctx: CodexLaunchContext): ClaudeLaunch {
  const resumed = !!node.sessionId
  const custom = !!ctx.codexCommand?.trim()
  const codex = custom ? undefined : (ctx.codex ?? resolveCodex())
  const noDaemon = ctx.noDaemon ?? (codex ? codexKnowsNoDaemon(codex) : true)
  const options = [
    ...(noDaemon ? [CODEX_NO_DAEMON] : []),
    ...codexHookArgs(ctx.hookScript),
    ...codexMcpArgs(ctx.cliDir),
    ...codexApprovalArgs(ctx.codexApproval),
    '-c',
    `developer_instructions=${toml(codexInstructions())}`,
    // An update question would hold the session at a screen nobody is watching, as after a restart.
    '-c',
    'check_for_update_on_startup=false'
  ]
  const args = resumed ? ['resume', ...options, node.sessionId as string] : [...options, ...(node.prompt?.trim() ? ['--', node.prompt] : [])]
  let program: { file: string; args: string[] }
  if (custom || !codex) {
    program = customLaunch({ command: ctx.codexCommand }, args)
  } else {
    program = { file: codex.file, args: programArgs(codex, args) }
  }
  return { nodeId: node.id, ...program, cwd: node.cwd, env: sessionEnv(node.id, ctx.token, ctx), sessionId: node.sessionId ?? '', resumed }
}
