import { spawn } from 'node:child_process'

export interface RunOptions {
  cwd?: string
  env: Record<string, string>
  /** The program is ended, with everything it started, once this passes. */
  timeoutMs: number
  /** Output past this many bytes is dropped, and the result says so. */
  maxBytes: number
}

export interface RunResult {
  /** Null when it didn't end by itself: it timed out, or never started. */
  code: number | null
  stdout: string
  stderr: string
  truncated: boolean
  timedOut: boolean
  /** It couldn't be started at all, such as when it isn't installed. */
  missing: boolean
}

/**
 * Windows ends a process without its children, so a stuck helper such as a credential prompt would live on. taskkill
 * runs alongside, never waited on: this runs in the app's main process, which waiting for it would freeze, and a git
 * fetch stuck behind a firewall is exactly when it's needed. The program's own close still settles the run.
 */
function endTree(pid: number | undefined, child: { kill(signal?: NodeJS.Signals): boolean }): void {
  if (process.platform === 'win32' && pid) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.on('error', () => child.kill('SIGKILL'))
    } catch {
      child.kill('SIGKILL')
    }
  } else {
    child.kill('SIGKILL')
  }
}

/**
 * Runs a program with its arguments as an array, so no shell ever reads them. Input is closed from the start, so a
 * program that wants to ask something gets nothing and fails instead of waiting.
 */
export function runProgram(file: string, args: string[], o: RunOptions): Promise<RunResult> {
  return new Promise((done) => {
    let child
    try {
      child = spawn(file, args, { cwd: o.cwd, env: o.env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      done({ code: null, stdout: '', stderr: (e as Error).message, truncated: false, timedOut: false, missing: true })
      return
    }
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outBytes = 0
    let errBytes = 0
    let truncated = false
    let timedOut = false
    let settled = false
    const take = (chunks: Buffer[], size: number, chunk: Buffer): number => {
      const room = o.maxBytes - size
      if (room <= 0) {
        truncated = true
        return size
      }
      if (chunk.length > room) truncated = true
      chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk)
      return size + Math.min(room, chunk.length)
    }
    child.stdout.on('data', (c: Buffer) => (outBytes = take(out, outBytes, c)))
    child.stderr.on('data', (c: Buffer) => (errBytes = take(err, errBytes, c)))
    const timer = setTimeout(() => {
      timedOut = true
      endTree(child.pid, child)
    }, o.timeoutMs)
    const finish = (code: number | null, missing: boolean, extra = ''): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const stderr = Buffer.concat(err).toString('utf8') + extra
      done({ code: timedOut ? null : code, stdout: Buffer.concat(out).toString('utf8'), stderr, truncated, timedOut, missing })
    }
    child.on('error', (e: NodeJS.ErrnoException) => finish(null, e.code === 'ENOENT', e.message))
    child.on('close', (code) => finish(code, false))
  })
}
