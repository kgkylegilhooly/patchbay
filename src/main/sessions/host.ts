import { statSync } from 'node:fs'
import { constants, setPriority } from 'node:os'
import { basename } from 'node:path'
import * as pty from 'node-pty'
import type { SessionHost, SessionSpec } from '../../shared/contract'
import type { HostedSession } from './hostProtocol'
import { createSessionBuffer, type SessionBuffer } from './sessionBuffer'
import { endPty } from './ptyKill'

const DEFAULT_BUFFER_BYTES = 1024 * 1024
const FLUSH_MS = 16
const FLUSH_BYTES = 64 * 1024
/**
 * For a session no window shows. Its output still reaches the app in full, for everything that reads it there, but in
 * far fewer pieces: ten busy agents in a project out of sight cost main 5% of a core in messages alone.
 */
const QUIET_FLUSH_MS = 250
const QUIET_FLUSH_BYTES = 256 * 1024
/** How long kill waits for the PTY to report its exit before treating the session as gone. */
const KILL_WAIT_MS = 3000

export class SessionStartError extends Error {
  constructor(
    readonly reason: 'cwd-missing' | 'spawn-failed',
    message: string
  ) {
    super(message)
    this.name = 'SessionStartError'
  }
}

/** The session is already running, so it can be joined rather than started. See docs/plans/session-sync.md. */
export class SessionAlreadyRunning extends SessionStartError {
  constructor(id: string) {
    super('spawn-failed', `Session ${id} is already running.`)
    this.name = 'SessionAlreadyRunning'
  }
}

/** Also true of the host's refusal as it crosses the pipe, which keeps only the message: the host may be an older build. */
export function isAlreadyRunning(e: unknown): boolean {
  return e instanceof SessionAlreadyRunning || (e instanceof Error && /^Session .+ is already running\.$/.test(e.message))
}

interface Session {
  proc: pty.IPty
  running: boolean
  buffer: SessionBuffer
  /** Received but not yet delivered. Already in `buffer`. */
  pending: string[]
  pendingBytes: number
  timer: NodeJS.Timeout | null
  exitWaiters: Array<() => void>
  exitCode: number | null
  exitedAt: number | null
}

/**
 * Below normal, which Windows hands on to whatever the program starts from then on: an agent's tools, tests and builds
 * all yield to the window and to terminals when CPU is short, and run at full speed when it isn't.
 */
function lowerPriority(pid: number): void {
  try {
    setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // It may already have ended, or Windows refused. It runs at normal priority, as it always used to.
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * node-pty quotes an args array by the argv rules most programs use. cmd.exe doesn't parse its
 * command line by those rules, so its args are already written for cmd.exe and must pass unchanged.
 */
function ptyArgs(spec: SessionSpec): string[] | string {
  return /^cmd(\.exe)?$/i.test(basename(spec.file)) ? spec.args.join(' ') : spec.args
}

/** The sessions themselves. This runs inside the background host, or in the app when the host can't start. */
export interface PtyHost extends SessionHost {
  start(spec: SessionSpec): void
  list(): HostedSession[]
  /** Drops an ended session's record and output. */
  forget(id: string): void
  /** Stops reading a session's output, so a program that's writing too fast has to wait. */
  pause(id: string): void
  resume(id: string): void
  /** The sessions no window shows, whose output goes in bigger, rarer pieces. Replaces the last list. */
  setQuiet?(ids: string[]): void
}

export function createSessionHost(opts: { bufferBytes?: number } = {}): PtyHost {
  const bufferBytes = opts.bufferBytes ?? DEFAULT_BUFFER_BYTES
  const sessions = new Map<string, Session>()
  /** Outlives each session, so a restarted node keeps counting upward for views already attached. */
  const seqs = new Map<string, number>()
  /** Also outlives each session: a window only reports its size when that changes, not when its session restarts. */
  const sizes = new Map<string, { cols: number; rows: number }>()
  const outputListeners: Array<(id: string, data: string, seq: number) => void> = []
  const exitListeners: Array<(id: string, code: number) => void> = []
  let quiet = new Set<string>()

  const flush = (id: string, session: Session): void => {
    if (session.timer) {
      clearTimeout(session.timer)
      session.timer = null
    }
    if (session.pending.length === 0) return
    const data = session.pending.join('')
    session.pending = []
    session.pendingBytes = 0
    const seq = (seqs.get(id) ?? 0) + 1
    seqs.set(id, seq)
    for (const cb of outputListeners) cb(id, data, seq)
  }

  const receive = (id: string, session: Session, data: string): void => {
    const size = Buffer.byteLength(data)
    const hidden = quiet.has(id)
    const most = hidden ? QUIET_FLUSH_BYTES : FLUSH_BYTES
    if (session.pendingBytes + size > most) flush(id, session)
    session.buffer.append(data)
    session.pending.push(data)
    session.pendingBytes += size
    if (session.pendingBytes >= most) flush(id, session)
    else if (!session.timer) session.timer = setTimeout(() => flush(id, session), hidden ? QUIET_FLUSH_MS : FLUSH_MS)
  }

  const finish = (id: string, session: Session, code: number): void => {
    if (!session.running) return
    session.running = false
    session.exitCode = code
    session.exitedAt = Date.now()
    flush(id, session)
    for (const cb of exitListeners) cb(id, code)
    for (const done of session.exitWaiters.splice(0)) done()
  }

  return {
    start(spec: SessionSpec): void {
      const id = spec.nodeId
      if (sessions.get(id)?.running) throw new SessionAlreadyRunning(id)
      if (!isDirectory(spec.cwd)) {
        throw new SessionStartError('cwd-missing', `Folder not found: ${spec.cwd}`)
      }
      let proc: pty.IPty
      try {
        proc = pty.spawn(spec.file, ptyArgs(spec), {
          name: 'xterm-256color',
          ...(sizes.get(id) ?? { cols: 80, rows: 24 }),
          cwd: spec.cwd,
          env: spec.env
        })
      } catch (e) {
        throw new SessionStartError('spawn-failed', `Could not start ${spec.file}: ${(e as Error).message}`)
      }
      const session: Session = {
        proc,
        running: true,
        buffer: createSessionBuffer(bufferBytes, spec.initialScrollback ?? ''),
        pending: [],
        pendingBytes: 0,
        timer: null,
        exitWaiters: [],
        exitCode: null,
        exitedAt: null
      }
      sessions.set(id, session)
      if (spec.background) lowerPriority(proc.pid)
      proc.onData((data) => receive(id, session, data))
      proc.onExit(({ exitCode }) => finish(id, session, exitCode))
    },

    write(id: string, data: string): void {
      const session = sessions.get(id)
      if (session?.running) session.proc.write(data)
    },

    resize(id: string, cols: number, rows: number): void {
      if (cols < 1 || rows < 1) return
      const size = { cols: Math.floor(cols), rows: Math.floor(rows) }
      sizes.set(id, size)
      const session = sessions.get(id)
      if (!session?.running) return
      try {
        session.proc.resize(size.cols, size.rows)
      } catch {
        // The process can exit between the check and the call. Its exit event still arrives.
      }
    },

    kill(id: string): Promise<void> {
      const session = sessions.get(id)
      // node-pty's helper throws uncaught if kill runs after the process exited.
      if (!session?.running) return Promise.resolve()
      return new Promise((resolve) => {
        session.exitWaiters.push(resolve)
        // Its console's processes are listed first, so nothing but them is killed: see ptyKill.ts.
        endPty(session.proc, () => session.running).then(
          (told) => {
            if (!told) return
            const giveUp = setTimeout(() => finish(id, session, -1), KILL_WAIT_MS)
            session.exitWaiters.push(() => clearTimeout(giveUp))
          },
          () => finish(id, session, -1)
        )
      })
    },

    pid(id: string): number | null {
      const session = sessions.get(id)
      return session?.running ? session.proc.pid : null
    },

    isRunning(id: string): boolean {
      return sessions.get(id)?.running ?? false
    },

    snapshot(id: string): { data: string; seq: number } {
      const session = sessions.get(id)
      if (!session) return { data: '', seq: seqs.get(id) ?? 0 }
      // Delivering what's pending first keeps "snapshot, then chunks after seq" exact.
      flush(id, session)
      return { data: session.buffer.read(), seq: seqs.get(id) ?? 0 }
    },

    onOutput(cb): void {
      outputListeners.push(cb)
    },

    onExit(cb): void {
      exitListeners.push(cb)
    },

    list(): HostedSession[] {
      return [...sessions].map(([id, s]) => ({ id, pid: s.running ? s.proc.pid : null, running: s.running, exitCode: s.exitCode, exitedAt: s.exitedAt, size: sizes.get(id) }))
    },

    forget(id: string): void {
      if (!sessions.get(id)?.running) sessions.delete(id)
    },

    pause(id: string): void {
      const session = sessions.get(id)
      if (session?.running) session.proc.pause()
    },

    resume(id: string): void {
      const session = sessions.get(id)
      if (session?.running) session.proc.resume()
    },

    setQuiet(ids: string[]): void {
      const was = quiet
      quiet = new Set(ids)
      // Shown again: what was held for the longer wait goes now, so the view isn't a quarter second behind.
      for (const id of was) {
        const session = sessions.get(id)
        if (!quiet.has(id) && session) flush(id, session)
      }
    }
  }
}
