import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import type { CanvasStore, NodeError, RunResult, SessionHost } from '../../shared/contract'
import { AGENT_NAMES, agentOf, type ClaudeNode, type RunNode, type TerminalNode } from '../../shared/model'
import type { Settings } from '../../shared/settings'
import { agentChoice, agentOffReason } from '../../shared/agents'
import { agentLimitReason, parseAgentLimit } from '../../core/resources/agentLimit'
import { tokenFor } from '../control/server'
import type { Approvals } from './approvals'
import {
  buildClaudeLaunch,
  resolveClaude,
  sessionEnv,
  type ClaudeLaunch,
  type ClaudeLaunchContext,
  type ClaudeProgram
} from './claudeLaunch'
import { buildCodexLaunch, codexKnowsNoDaemon, isLookingCall, resolveCodex } from './codexLaunch'
import { isAlreadyRunning, SessionStartError } from './host'
import { hookNodeFor, httpHooksPossible, type HookLaunch } from './hookRunner'
import { foldMissedHooks, type MissedHook } from './missedHooks'
import { readConsoleMembers } from '../ports/ports'
import { pickDefaultShell } from './shell'
import { createStartupTyper, missingProfileNotice, STARTUP_WAITING, startupSkipped, terminalStartFor } from './terminalStart'
import type { TerminalProfile } from '../../shared/terminalProfiles'
import { findSsh, sshArgs } from './ssh'
import { sshHostProblem } from '../../core/ssh/config'
import { startupQuestion, STARTUP_SCREEN_CHARS } from '../../core/status/startupQuestion'
import { stripAnsi } from '../../core/transcript/read'
import type { StatusTracker } from './statusTracker'
import { asPaste } from './paste'
import { ARCHIVED_START, inArchivedProject } from '../../core/canvas/projectOps'

/** A resume that dies this fast, with no SessionStart, never reached its conversation. */
const RESUME_FAILURE_WINDOW_MS = 5000
/** How long a killed tree gets to report its exit before the host is told to end the session itself. */
const TREE_EXIT_WAIT_MS = 1000
/** SessionStart fires a moment before Claude's prompt can take input. */
const TYPE_PROMPT_DELAY_MS = 800
/** Claude reads one chunk as a paste, so Enter has to come separately. */
const SUBMIT_DELAY_MS = 200
const RUN_DIVIDER = '\x1b[?1049l\x1b[?25h\x1b[0m\r\n\x1b[2m--- run again ---\x1b[0m\r\n'

export interface NodeRunnerContext extends Omit<ClaudeLaunchContext, 'token'> {
  /** Tokens are derived from this per node. */
  secret: string
  /** The shell setting from the settings file. */
  shell?: string
  /** The terminal profiles installed shells offer. Defaults to detecting them. See shell.ts. */
  builtInProfiles?: () => TerminalProfile[]
  /** Put ahead of a startup command typed into a terminal: see sendGuard.ts. */
  typePrefix?: (id: string) => string
  /** Finds the Claude program when `claude` isn't set. Defaults to resolveClaude. */
  locateClaude?: () => ClaudeProgram
  codex?: ClaudeProgram
  /** Finds the Codex program when `codex` isn't set. Defaults to resolveCodex. */
  locateCodex?: () => ClaudeProgram
  /** Read at every launch, so a saved change applies to the next session without restarting the app. */
  settings?: () => Settings
  /** Ends a process and everything it started. Defaults to taskkill. */
  killTree?: (pid: number) => Promise<void>
  /** Every process on a session's console. Defaults to node-pty's helper. */
  consoleMembers?: (pid: number) => Promise<number[]>
  /** Finds the ssh program for SSH terminals. Defaults to findSsh. */
  ssh?: () => string | null
  /** Hands over the hook events a session couldn't deliver, and clears them. Defaults to none. */
  takeMissedHooks?: (id: string) => MissedHook[]
  /** A StopFailure found among them, when it's how they end: why the agent stopped, such as a usage limit. */
  onMissedStopFailure?: (id: string, event: Record<string, unknown>) => void
  /** When a session last signalled a tool call ending through a file. See signals.ts. */
  latestSignal?: (id: string) => number | undefined
  /**
   * Waits until a Codex session can safely start. Two Codex processes setting up its database at once can crash the
   * one that's starting, and Patchbay runs Codex itself in the background to read its limits.
   */
  beforeCodexStart?: () => Promise<void>
  /** Asks the host what it runs and brings its mirrors up to date. Null when there's no host to ask. */
  refreshHost?: () => Promise<unknown>
  /** A session the host still ran was taken on again, so its views should be rebuilt. See docs/plans/session-sync.md. */
  onReattached?: (id: string) => void
  /** The Node a Claude launch's hooks start directly, when `hookNode` isn't set. Defaults to hookNodeFor. */
  findHookNode?: (launch: HookLaunch) => Promise<string | null>
  /** The connected session host's hook port, or null when sessions keep command hooks. See docs/plans/host-hooks.md. */
  hostHookPort?: () => number | null | Promise<number | null>
  /** Whether a Claude launch's hooks can be http hooks. Defaults to httpHooksPossible. */
  findHttpHooks?: (launch: HookLaunch) => Promise<boolean>
}

function taskkill(pid: number): Promise<void> {
  return new Promise((resolve) => {
    // It fails if the process has already gone, which is what was wanted anyway.
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve())
  })
}

export interface NodeRunner {
  /**
   * Never rejects. A failure appears in errors() and onError. Does nothing if already running. One the host turned out
   * to be running already, out of this app's sight, is taken on again instead.
   */
  startNode(id: string, opts?: { initialScrollback?: string; restored?: boolean }): Promise<void>
  /** Takes on a session already running in the background host. Its status stays `unknown` until a hook confirms one. */
  adoptNode(id: string): void
  /** Reports a run node that ended while the app was away. */
  noteFinishedRun(id: string, exitCode: number | null, at: number | null): void
  /** Applies hook events that arrived while the app was closed, unless newer live ones have overtaken them. */
  catchUpHooks(id: string): void
  /** A session the host still runs that this app had lost track of: taken on again, caught up, and its views rebuilt. */
  reattachNode(id: string): void
  restartNode(id: string): Promise<void>
  /**
   * As restartNode. `joined` means the session it would have ended was still running unseen, so it's shown again
   * instead. With `shownExited`, the person was looking at it as ended: one running by now, as after a revive that
   * landed just before the click, is shown, never ended.
   */
  restartOrJoin(id: string, opts?: { shownExited?: boolean }): Promise<'joined' | void>
  /** Ends the session's whole process tree, then starts it again. An agent resumes its conversation. */
  endAndRestart(id: string): Promise<void>
  /** Ends a session on purpose, as when its node closes. */
  stopNode(id: string): Promise<void>
  /** Ends a run node's command and everything it started, so a server really lets go of its port. */
  stopTree(id: string): Promise<void>
  runs(): Record<string, RunResult>
  onRun(cb: (id: string, run: RunResult) => void): void
  stopAll(): Promise<void>
  /** Call with every input going to a session, because an interrupt fires no Claude hook. */
  noteInput(id: string, data: string): void
  /** Serves the control server's onHook. A PermissionRequest replies only once it's settled. */
  handleHook(id: string, payload: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>
  errors(): Record<string, NodeError>
  onError(cb: (id: string, error: NodeError | null) => void): void
}

/** What this launch of a Claude node has shown so far. */
interface ClaudeRun {
  resumed: boolean
  startedAt: number
  sessionStarted: boolean
  /** False while the current session has no conversation on disk to resume. */
  hasConversation: boolean
  /** This launch has heard from it directly, so anything still in its journal is older than what's known. */
  heardLive?: boolean
  stopping: boolean
  typedPrompt?: string
  /** What it has shown before its session started, as text, to spot a question only the person can answer. */
  startupScreen?: string
  /** It's showing such a question now, so its status says it needs the person. */
  askedAtStartup?: boolean
}

/** Runs the command and ends with it, unlike a terminal, which stays open for more. */
export function runArgs(shell: string, command: string): string[] {
  const name = basename(shell).toLowerCase().replace(/\.exe$/, '')
  if (name === 'bash') return ['--login', '-c', command]
  if (name === 'powershell' || name === 'pwsh') return ['-NoLogo', '-Command', command]
  if (name === 'cmd') return ['/c', command]
  return ['-c', command]
}

const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * Git Bash's runtime allows 32 consoles in use at once across the whole PC: every Git Bash terminal, every agent while
 * its shell tool runs a command, and Git Bash windows outside Patchbay. The next one fails with this, in its output.
 */
export const CONSOLES_FULL =
  "Git Bash couldn't start: it allows only 32 consoles open at once across this PC, and other terminals, agents' commands or Git Bash windows are using them all. Close some, then press Restart."

export function consolesFull(output: string): boolean {
  return /too many consoles in use, max consoles is \d+/.test(output.slice(-4000))
}

export function createNodeRunner({
  host,
  tracker,
  store,
  approvals,
  ctx
}: {
  host: SessionHost
  tracker: StatusTracker
  store: CanvasStore
  approvals?: Approvals
  ctx: NodeRunnerContext
}): NodeRunner {
  const runs = new Map<string, ClaudeRun>()
  const started = new Set<string>()
  const errors = new Map<string, NodeError>()
  const errorListeners: Array<(id: string, error: NodeError | null) => void> = []
  const runResults = new Map<string, RunResult>()
  const runListeners: Array<(id: string, run: RunResult) => void> = []
  /** Run nodes being ended on purpose, so their exit doesn't read as a failure. */
  const stoppingRuns = new Set<string>()
  const killTree = ctx.killTree ?? taskkill
  const consoleMembers = ctx.consoleMembers ?? readConsoleMembers

  const setRun = (id: string, run: RunResult): void => {
    runResults.set(id, run)
    for (const cb of runListeners) cb(id, run)
  }

  const nodeById = (id: string) => store.get().nodes.find((n) => n.id === id)

  const setError = (id: string, error: NodeError | null): void => {
    if (error) errors.set(id, error)
    else if (!errors.delete(id)) return
    for (const cb of errorListeners) cb(id, error)
  }

  const forgetSession = (id: string): void => {
    store.dispatch({ op: 'patchNode', id, patch: { sessionId: null, transcriptPath: null } })
  }

  // An agent stopped at a question before its session starts, such as whether to trust the folder, fires no hook. Only
  // its screen shows it, so the start of each launch is read until the session starts or such a question appears.
  host.onOutput((id, data) => {
    const run = runs.get(id)
    if (!run || run.sessionStarted || run.askedAtStartup || run.startupScreen === undefined) return
    if (tracker.get(id) !== 'starting') return
    run.startupScreen = (run.startupScreen + stripAnsi(data)).slice(-STARTUP_SCREEN_CHARS)
    if (!startupQuestion(run.startupScreen)) return
    run.askedAtStartup = true
    run.startupScreen = ''
    tracker.apply(id, { type: 'startup-question' })
  })

  // A terminal profile's startup command, typed once at the shell's first prompt. See terminalStart.ts.
  const startupTyper = createStartupTyper({
    host,
    prefix: ctx.typePrefix,
    events: {
      waiting: (id) => setError(id, { code: 'spawn-failed', message: STARTUP_WAITING }),
      typed: (id) => {
        if (errors.get(id)?.message === STARTUP_WAITING) setError(id, null)
      },
      skipped: (id, lines) => setError(id, { code: 'spawn-failed', message: startupSkipped(lines) })
    }
  })
  host.onOutput((id, data) => startupTyper.output(id, data))

  host.onExit((id, code) => {
    startupTyper.cancel(id)
    started.delete(id)
    approvals?.clearNode(id)
    // Git Bash can only have so many consoles open across the whole PC, and one more ends at once with a stack dump.
    if (code !== 0 && consolesFull(host.snapshot(id).data)) setError(id, { code: 'spawn-failed', message: CONSOLES_FULL })
    if (runResults.get(id)?.running) {
      setRun(id, { running: false, exitCode: code, stoppedByYou: stoppingRuns.delete(id), at: Date.now() })
    }
    const run = runs.get(id)
    if (!run) return
    runs.delete(id)
    tracker.apply(id, { type: 'process-exit' })
    if (run.stopping) {
      if (!run.hasConversation) forgetSession(id)
      return
    }
    const quick = Date.now() - run.startedAt <= RESUME_FAILURE_WINDOW_MS
    if (run.resumed && !run.sessionStarted && code !== 0 && quick) {
      const node = nodeById(id)
      const name = node?.kind === 'claude' && agentOf(node) === 'codex' ? AGENT_NAMES.codex : 'Claude'
      setError(id, {
        code: 'resume-failed',
        message: `${name} could not reopen this conversation. Restart tries again, or starts a new one if its transcript is gone.`
      })
    } else if (!run.hasConversation) {
      // Nothing was ever said, so there's nothing to resume and --resume would only fail.
      forgetSession(id)
    }
  })

  const startClaude = async (node: ClaudeNode, initialScrollback?: string): Promise<void> => {
    const now = { ...ctx, ...ctx.settings?.() }
    const token = tokenFor(ctx.secret, node.id)
    let launch: ClaudeLaunch
    if (agentOf(node) === 'codex') {
      await ctx.beforeCodexStart?.()
      const codex = now.codexCommand?.trim() ? undefined : (ctx.codex ?? (ctx.locateCodex ?? resolveCodex)())
      // Asked once per program, without holding up the main thread.
      const noDaemon = await codexKnowsNoDaemon({ codex, codexCommand: now.codexCommand })
      launch = buildCodexLaunch(node, { ...now, codex, token, noDaemon })
    } else {
      const custom = now.claudeTerminal || now.claudeCommand
      const claude = custom ? undefined : (ctx.claude ?? (ctx.locateClaude ?? resolveClaude)())
      // Asked once per program, without holding up the main thread.
      const hookLaunch = { claude, claudeCommand: now.claudeCommand, claudeTerminal: now.claudeTerminal }
      const hookNode = now.hookNode !== undefined ? now.hookNode : await (ctx.findHookNode ?? hookNodeFor)(hookLaunch)
      // Served by the session host, so its events start nothing. Chosen now, for this session's life.
      // Waited for: a host still coming up after a quick start has its port in a moment, and this is for the session's life.
      const hostPort = (await ctx.hostHookPort?.()) ?? null
      const hookPort = hostPort && (await (ctx.findHttpHooks ?? httpHooksPossible)(hookLaunch)) ? hostPort : undefined
      launch = buildClaudeLaunch(node, { ...now, claude, token, hookNode, hookPort })
    }
    tracker.apply(node.id, { type: 'launched' })
    const { sessionId, resumed, typedPrompt, ...spec } = launch
    // Anything still in its journal belongs to an earlier process.
    ctx.takeMissedHooks?.(node.id)
    // Recorded first, because the host may take a moment to answer and the session's first hooks may beat it here.
    runs.set(node.id, {
      resumed,
      startedAt: Date.now(),
      sessionStarted: false,
      hasConversation: resumed,
      stopping: false,
      typedPrompt,
      startupScreen: ''
    })
    try {
      // Agents yield to the window and to terminals when the PC is short of CPU. See SessionSpec.background.
      await host.start({ ...spec, initialScrollback, background: true })
    } catch (e) {
      runs.delete(node.id)
      throw e
    }
    // Codex sends no SessionStart when it resumes, so one still running after the window for a failed resume is ready.
    if (resumed && agentOf(node) === 'codex') {
      setTimeout(() => {
        const run = runs.get(node.id)
        if (!run || run.sessionStarted || run.askedAtStartup || !host.isRunning(node.id)) return
        run.sessionStarted = true
        tracker.apply(node.id, { type: 'hook', name: 'SessionStart' })
      }, RESUME_FAILURE_WINDOW_MS)
    }
    // Only now: a session that never started has no conversation for a later launch to resume.
    if (sessionId && nodeById(node.id)?.kind === 'claude' && node.sessionId !== sessionId) store.dispatch({ op: 'patchNode', id: node.id, patch: { sessionId } })
  }

  const typePrompt = (id: string, prompt: string): void => {
    // Only text goes in, so a prompt can't press keys, and a line break can't submit it early.
    const text = prompt.replace(/\r?\n/g, ' ').replace(/[\x00-\x1f\x7f-\x9f]/g, '')
    setTimeout(() => {
      // As one paste, or a prompt over 1 KB loses its start: see paste.ts.
      host.write(id, asPaste(text))
      setTimeout(() => host.write(id, '\r'), SUBMIT_DELAY_MS)
    }, TYPE_PROMPT_DELAY_MS)
  }

  const startTerminal = async (node: TerminalNode, initialScrollback?: string, restored = false): Promise<void> => {
    if (node.sshHost !== undefined) return startSsh(node, node.sshHost, initialScrollback)
    // Coming back from a restart is a fresh shell. A command like a deploy mustn't run again with nobody there.
    const launch = terminalStartFor(ctx, node, restored)
    // Recorded at its first start, so a restart after the default changes still uses the profile it began with.
    if (node.profile === undefined) store.dispatch({ op: 'patchNode', id: node.id, patch: { profile: launch.profile.id } })
    startupTyper.cancel(node.id)
    await host.start({
      nodeId: node.id,
      file: launch.file,
      args: launch.args,
      cwd: node.cwd,
      env: sessionEnv(node.id, tokenFor(ctx.secret, node.id), ctx),
      initialScrollback,
      saveScrollback: true
    })
    // Shown on the node rather than written into its output, which is saved and would gather a copy at every restart.
    if (launch.missing) setError(node.id, { code: 'spawn-failed', message: missingProfileNotice(launch.profile.name) })
    startupTyper.arm(node.id, launch.typed, launch.waitFor)
  }

  /** ssh straight to the host, with no shell to read the name. Coming back from a restart connects again. */
  const startSsh = async (node: TerminalNode, sshHost: string, initialScrollback?: string): Promise<void> => {
    const problem = sshHostProblem(sshHost)
    if (problem) throw new SessionStartError('spawn-failed', problem)
    const file = (ctx.ssh ?? findSsh)()
    if (!file) throw new SessionStartError('spawn-failed', "ssh isn't installed. Turn on Windows' OpenSSH Client under Settings > System > Optional features.")
    await host.start({
      nodeId: node.id,
      file,
      args: sshArgs(sshHost),
      cwd: node.cwd,
      env: sessionEnv(node.id, tokenFor(ctx.secret, node.id), ctx),
      initialScrollback,
      saveScrollback: true
    })
  }

  const startRun = async (node: RunNode, seed?: string): Promise<void> => {
    const shell = pickDefaultShell(ctx.settings?.().shell ?? ctx.shell)
    const earlier = seed ?? host.snapshot(node.id).data
    await host.start({
      nodeId: node.id,
      file: shell.file,
      args: runArgs(shell.file, node.command),
      cwd: node.cwd,
      env: sessionEnv(node.id, tokenFor(ctx.secret, node.id), ctx),
      initialScrollback: earlier ? `${earlier}${RUN_DIVIDER}` : undefined,
      saveScrollback: true
    })
    stoppingRuns.delete(node.id)
    setRun(node.id, { running: true, exitCode: null, stoppedByYou: false, at: Date.now() })
  }

  const stopTree = async (id: string): Promise<void> => {
    const pid = host.pid(id)
    if (pid === null) return
    stoppingRuns.add(id)
    // Git Bash breaks the parent chain, so taskkill /T alone can miss a real server, as with npm run dev. Everything
    // on the console has to be found first, because killing the shell can leave the rest running.
    const members = await consoleMembers(pid).catch((): number[] => [])
    await Promise.all([...new Set([pid, ...members])].map((member) => killTree(member)))
    const deadline = Date.now() + TREE_EXIT_WAIT_MS
    while (host.isRunning(id) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25))
    await host.kill(id)
  }

  const isRun = (id: string): boolean => nodeById(id)?.kind === 'run'

  /** Settings > Agents: why this agent may not start, restart or resume now, or null. One already running is left alone. */
  const agentOff = (node: ClaudeNode): string | null => agentOffReason(agentOf(node), agentChoice(ctx.settings?.() ?? {}))

  /** Settings > Background sessions: why another agent may not start now, counting those already running. */
  const overAgentLimit = (id: string): string | null =>
    agentLimitReason(parseAgentLimit(ctx.settings?.().agentLimit), store.get().nodes.filter((n) => n.kind === 'claude' && n.id !== id && (started.has(n.id) || host.isRunning(n.id))).length)

  const launch = async (id: string, opts: { initialScrollback?: string; restored?: boolean } = {}): Promise<'joined' | void> => {
    const node = nodeById(id)
    if (!node || (node.kind !== 'claude' && node.kind !== 'terminal' && node.kind !== 'run')) return
    if (host.isRunning(id)) return
    // Covers every way in: the after-gate, triggers, launch, the page and agents.
    if (inArchivedProject(store.get(), node)) return setError(id, { code: 'spawn-failed', message: ARCHIVED_START })
    setError(id, null)
    const off = node.kind === 'claude' ? agentOff(node) : null
    if (off) {
      tracker.apply(id, { type: 'process-exit' })
      return setError(id, { code: 'spawn-failed', message: off })
    }
    // The soft limit on agents at once. One coming back after a restart of the app or host was already running, so it may.
    const limited = node.kind === 'claude' && !opts.restored ? overAgentLimit(id) : null
    if (limited) {
      // The host may run it already, out of this app's sight. That's joining it, not starting another, so the limit
      // doesn't apply: asked before refusing, as a refusal would leave it unreachable.
      if (ctx.refreshHost && (await ctx.refreshHost().catch(() => null)) && host.isRunning(id)) {
        if (!started.has(id)) api.reattachNode(id)
        return 'joined'
      }
      tracker.apply(id, { type: 'process-exit' })
      return setError(id, { code: 'spawn-failed', message: limited })
    }
    try {
      // Claimed before the wait, so stopAll can't miss a session that's on its way up.
      started.add(id)
      if (node.kind === 'claude') await startClaude(node, opts.initialScrollback)
      else if (node.kind === 'run') await startRun(node, opts.initialScrollback)
      else await startTerminal(node, opts.initialScrollback, opts.restored)
    } catch (e) {
      // The host already runs it: joined, not started. Without this it showed as ended and Restart could never work.
      if (isAlreadyRunning(e) && host.isRunning(id)) {
        api.reattachNode(id)
        return 'joined'
      }
      started.delete(id)
      if (node.kind === 'claude') tracker.apply(id, { type: 'process-exit' })
      setError(id, {
        code: e instanceof SessionStartError ? e.reason : 'spawn-failed',
        message: (e as Error).message
      })
    }
  }

  const catchUpHooks = (id: string): void => {
    const run = runs.get(id)
    const events = ctx.takeMissedHooks?.(id) ?? []
    if (!run || run.heardLive || events.length === 0) return
    // A tool call that ended after the last journalled event, such as one a person allowed in the terminal, means the
    // agent got going again. The journal doesn't have it, since those only touch a file.
    const lastJournalled = Math.max(0, ...events.map((e) => (typeof e.at === 'number' ? e.at : 0)))
    const signalled = ctx.latestSignal?.(id)
    if (lastJournalled && signalled !== undefined && signalled > lastJournalled) events.push({ hook_event_name: 'PostToolUse' })
    const missed = foldMissedHooks(events)
    tracker.seed(id, missed.status, missed.turns)
    if (missed.stopFailure) ctx.onMissedStopFailure?.(id, missed.stopFailure)
    if (missed.hasConversation !== undefined) run.hasConversation = missed.hasConversation
    if (missed.promptSubmitted) {
      const node = nodeById(id)
      if (node?.kind === 'claude' && node.prompt !== undefined) store.dispatch({ op: 'patchNode', id, patch: { prompt: undefined } })
    }
    if (missed.sessionId) {
      run.sessionStarted = true
      store.dispatch({ op: 'patchNode', id, patch: { sessionId: missed.sessionId, transcriptPath: missed.transcriptPath ?? null } })
    }
  }

  const startNode = async (id: string, opts: { initialScrollback?: string; restored?: boolean } = {}): Promise<void> => {
    await launch(id, opts)
  }

  const api: NodeRunner = {
    startNode,

    reattachNode(id) {
      if (!host.isRunning(id) || !nodeById(id)) return
      api.adoptNode(id)
      catchUpHooks(id)
      ctx.onReattached?.(id)
    },

    async endAndRestart(id) {
      const node = nodeById(id)
      if (!node || (node.kind !== 'claude' && node.kind !== 'terminal' && node.kind !== 'run')) return
      const run = runs.get(id)
      if (run) run.stopping = true
      // The whole tree, as Stop does for a run, so nothing it started is left holding files or ports.
      await stopTree(id)
      if (node.kind !== 'run') stoppingRuns.delete(id)
      if (host.isRunning(id)) return setError(id, { code: 'spawn-failed', message: "The session didn't end, so it wasn't started again." })
      await api.restartOrJoin(id)
    },

    adoptNode(id) {
      const node = nodeById(id)
      if (!node) return
      started.add(id)
      setError(id, null)
      if (node.kind === 'run') {
        setRun(id, { running: true, exitCode: null, stoppedByYou: false, at: Date.now() })
        return
      }
      if (node.kind !== 'claude') return
      // Nothing that happened while the app was away is known yet, and a guess here could read as a false idle.
      tracker.seed(id, 'unknown')
      runs.set(id, {
        resumed: !!node.sessionId,
        startedAt: Date.now(),
        // It got far enough to be left running, so a later exit isn't a failed resume.
        sessionStarted: true,
        // With no record of a transcript, keep the session: at worst a resume fails and says so.
        hasConversation: !node.transcriptPath || existsSync(node.transcriptPath),
        stopping: false
      })
    },

    noteFinishedRun(id, exitCode, at) {
      setRun(id, { running: false, exitCode, stoppedByYou: false, at: at ?? Date.now() })
    },

    catchUpHooks,

    async restartNode(id) {
      await api.restartOrJoin(id)
    },

    async restartOrJoin(id, opts = {}) {
      const node = nodeById(id)
      if (opts.shownExited && (node?.kind === 'claude' || node?.kind === 'terminal') && host.isRunning(id)) {
        // Already taken on again by the revive, or not yet: either way it's live, and Restart only shows it.
        if (!started.has(id)) api.reattachNode(id)
        return 'joined'
      }
      if (node?.kind === 'run') {
        await stopTree(id)
        return launch(id)
      }
      if (!node || (node.kind !== 'claude' && node.kind !== 'terminal')) return
      // Refused before anything is stopped, so a session that's running keeps running, with no start error over it.
      const off = node.kind === 'claude' ? agentOff(node) : null
      if (off) return host.isRunning(id) ? undefined : setError(id, { code: 'spawn-failed', message: off })
      const run = runs.get(id)
      if (run) run.stopping = true
      if (host.isRunning(id)) await host.kill(id)
      if (node.kind === 'claude') {
        const current = nodeById(id) as ClaudeNode | undefined
        // A transcript still on disk may be worth another try, and nothing is lost by keeping it.
        const gone = !current?.transcriptPath || !existsSync(current.transcriptPath)
        if (errors.get(id)?.code === 'resume-failed' && gone) forgetSession(id)
        return launch(id)
      }
      return launch(id, { initialScrollback: host.snapshot(id).data })
    },

    stopTree,

    runs: () => Object.fromEntries(runResults),

    onRun(cb) {
      runListeners.push(cb)
    },

    async stopNode(id) {
      const run = runs.get(id)
      if (run) run.stopping = true
      if (isRun(id)) await stopTree(id)
      else if (host.isRunning(id)) await host.kill(id)
      setError(id, null)
    },

    async stopAll() {
      for (const run of runs.values()) run.stopping = true
      await Promise.all([...started].map((id) => (isRun(id) ? stopTree(id) : host.kill(id))))
    },

    noteInput(id, data) {
      startupTyper.input(id, data)
      if (runResults.get(id)?.running && data.includes('\x03')) stoppingRuns.add(id)
      if (!runs.has(id)) return
      if (data !== '\x1b' && !data.includes('\x03')) return
      tracker.apply(id, { type: 'interrupt-key' })
      approvals?.clearNode(id)
    },

    async handleHook(id, payload, signal) {
      const run = runs.get(id)
      const name = text(payload.hook_event_name)
      if (!run || !name) return {}
      run.heardLive = true
      // Any hook means the program got past a question it showed at startup.
      if (run.askedAtStartup) {
        run.askedAtStartup = false
        tracker.apply(id, { type: 'startup-answered' })
      }
      if (name === 'SessionStart') run.startupScreen = undefined
      const asking = nodeById(id)
      if (name === 'PermissionRequest' && asking?.kind === 'claude' && agentOf(asking) === 'codex' && isLookingCall(payload.tool_name, payload.tool_input)) {
        return { decision: 'allow' }
      }

      if (name === 'SessionStart') {
        run.sessionStarted = true
        if (run.typedPrompt) {
          typePrompt(id, run.typedPrompt)
          run.typedPrompt = undefined
        }
        const source = text(payload.source)
        if (source === 'clear') run.hasConversation = false
        if (source === 'resume') run.hasConversation = true
        const sessionId = text(payload.session_id)
        if (sessionId) {
          store.dispatch({
            op: 'patchNode',
            id,
            patch: { sessionId, transcriptPath: text(payload.transcript_path) ?? null }
          })
        }
      }
      if (name === 'UserPromptSubmit') {
        run.hasConversation = true
        // It has done its job. Kept, it would start the same work again after /clear and a relaunch.
        const node = nodeById(id)
        if (node?.kind === 'claude' && node.prompt !== undefined) store.dispatch({ op: 'patchNode', id, patch: { prompt: undefined } })
      }
      // Any later hook means the prompt was answered in the terminal. The exceptions aren't answers:
      // the permission notification arrives about 6 s into the same prompt, and a further request
      // can come from a tool running in parallel.
      // Nor are a subagent starting or ending (Codex), which can happen while the window waits on a prompt.
      if (name !== 'Notification' && name !== 'PermissionRequest' && name !== 'SubagentStart' && name !== 'SubagentStop') approvals?.clearNode(id)

      tracker.apply(id, {
        type: 'hook',
        name,
        notificationType: text(payload.notification_type),
        reason: text(payload.reason)
      })

      if (name !== 'PermissionRequest' || !approvals) return {}
      const decision = await approvals.request(id, payload, signal)
      if (decision && !approvals.pending().some((p) => p.nodeId === id)) {
        tracker.apply(id, { type: 'approval-answered' })
      }
      return { decision }
    },

    errors: () => Object.fromEntries(errors),

    onError(cb) {
      errorListeners.push(cb)
    }
  }
  return api
}
