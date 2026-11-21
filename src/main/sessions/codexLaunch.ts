import { execFile, execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { ClaudeNode } from '../../shared/model'
import { runProgram } from '../../core/git/run'
import { claudeAt, customLaunch, LOOKING_VERBS, programArgs, sessionEnv, type ClaudeLaunch, type ClaudeProgram, type SessionEnvContext } from './claudeLaunch'

export interface CodexLaunchContext extends SessionEnvContext {
  hookScript: string
  token: string
  /** Defaults to resolveCodex(). */
  codex?: ClaudeProgram
  codexCommand?: string
  /** The codexApproval setting: '' for Codex's own default, 'never' or 'bypass'. */
  codexApproval?: string
  /** Whether to pass --no-daemon, from codexKnowsNoDaemon. Defaults to true. */
  noDaemon?: boolean
}

/**
 * The events Codex reports. Each one's command never changes between launches, because Codex asks the person to trust
 * a hook once and remembers it by its exact command. The node travels in the environment instead.
 *
 * No PreToolUse, as for Claude: it started Node before every tool call, and PostToolUse sets everything it did.
 *
 * Codex 0.170 also reports Interrupt (Esc ended the turn: it's at its prompt, so `idle`, where Claude can only say
 * `unknown`) and SubagentStart / SubagentStop, which feed its subagent cards. Adding a hook means Codex asks the person
 * to trust the new commands once, on the next launch. Not SessionEnd: its only reason is "other", which doesn't say
 * whether the program is ending or only the conversation, so a process exit stays what marks a node exited.
 */
export const CODEX_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Stop', 'Interrupt', 'SubagentStart', 'SubagentStop']

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

/** resolveCodex without waiting on where.exe on the main thread, for checks in the background. */
export async function resolveCodexAsync(): Promise<ClaudeProgram> {
  if (!(located && existsSync(located))) {
    located = null
    await lookUpCodexAhead()
  }
  if (!located) throw new Error('The codex command was not found on PATH. Install it with npm install -g @openai/codex.')
  return claudeAt(located)
}

/** Finds codex ahead of time, off the main thread, so resolveCodex needn't wait for where.exe. See lookUpClaudeAhead. */
export async function lookUpCodexAhead(): Promise<void> {
  if (located) return
  const r = await runProgram('where.exe', ['codex'], { env: process.env as Record<string, string>, timeoutMs: 15_000, maxBytes: 64 * 1024 })
  if (located || r.code !== 0) return
  const lines = r.stdout.split(/\r?\n/).filter(Boolean)
  located = lines.find((l) => /\.exe$/i.test(l)) ?? lines.find((l) => /\.(cmd|bat)$/i.test(l)) ?? null
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

type Ask = (file: string, args: string[]) => Promise<string>

/** One answer per program and app run, shared by nodes that start together, as when a canvas reopens. */
const noDaemonKnown = new Map<string, Promise<boolean>>()

/**
 * Whether this Codex knows --no-daemon. One older than the shared server would refuse the flag and not start at all.
 * Asks its --help once per program, off the main thread's way: the answer can take seconds on a first run after login.
 * A custom command is asked the same way it will be launched. When the answer can't be had, the flag is used: safer to
 * fail visibly than to share.
 */
export function codexKnowsNoDaemon(launch: { codex?: ClaudeProgram; codexCommand?: string }, ask: Ask = helpText): Promise<boolean> {
  let program: { file: string; args: string[] }
  try {
    program = launch.codexCommand?.trim()
      ? customLaunch({ command: launch.codexCommand }, ['--help'])
      : (() => {
          const codex = launch.codex ?? resolveCodex()
          return { file: codex.file, args: programArgs(codex, ['--help']) }
        })()
  } catch {
    return Promise.resolve(true)
  }
  const key = [program.file, ...program.args].join('\0')
  let known = noDaemonKnown.get(key)
  if (!known) {
    known = ask(program.file, program.args).then(
      (text) => text.includes(CODEX_NO_DAEMON),
      () => true
    )
    noDaemonKnown.set(key, known)
  }
  return known
}

function helpText(file: string, args: string[]): Promise<string> {
  // programArgs builds cmd.exe's line as node-pty passes it: as written. Node would quote it again.
  const verbatim = /^cmd(.exe)?$/i.test(basename(file))
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', windowsHide: true, timeout: 15_000, windowsVerbatimArguments: verbatim }, (error, stdout, stderr) => {
      // A program that exits non-zero still printed its help, or why it couldn't.
      if (error && !stdout && !stderr) reject(error)
      else resolve(`${stdout}${stderr}`)
    })
  })
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
  const noDaemon = ctx.noDaemon ?? true
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
