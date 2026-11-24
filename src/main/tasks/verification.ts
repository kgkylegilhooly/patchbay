import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TaskRevision, TaskVerification } from '../../shared/task'
import { cleanEnv } from '../sessions/env'
import { killTree as killChildTree } from '../../core/proc/killTree'

const runFile = promisify(execFile)
export const unknownRevision = (reason?: string): TaskRevision => ({ revision: null, uncommitted: null, fingerprint: null, ...(reason ? { reason } : {}) })
const GIT_TIMEOUT_MS = 60_000

/** Runs git and feeds its output into the hash as it comes, so a diff of any size never sits in memory whole. */
function gitInto(hash: Hash, root: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    const timer = setTimeout(() => child.kill(), GIT_TIMEOUT_MS)
    child.stdout.on('data', (chunk: Buffer) => hash.update(chunk))
    child.stderr.on('data', (chunk: Buffer) => { if (err.length < 2000) err += chunk.toString('utf8') })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`git ${args[0]} failed${err.trim() ? `: ${err.trim().split('\n')[0]}` : ` (exit ${code})`}`))
    })
  })
}

function fileInto(hash: Hash, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = createReadStream(file)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve())
  })
}

/**
 * The folder's git identity: HEAD, whether anything is uncommitted, and a fingerprint of everything git can see,
 * untracked files included. Everything is streamed, so a large diff or file costs time, not memory. A folder outside
 * any repository says so, rather than reading as an unknown identity.
 */
export async function readRevision(cwd: string): Promise<TaskRevision> {
  let root: string
  try {
    root = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 15000 })).stdout.trim()
  } catch (e) {
    const text = `${(e as { stderr?: string }).stderr ?? ''}${(e as Error).message}`
    if (/not a git repository/i.test(text)) return { revision: null, uncommitted: null, fingerprint: null, noRepo: true }
    return unknownRevision(`git couldn't be run in ${cwd}`)
  }
  try {
    const git = async (...args: string[]): Promise<string> => (await runFile('git', args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024 })).stdout
    const revision = (await git('rev-parse', 'HEAD')).trim()
    const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    const hash = createHash('sha256').update(status)
    await gitInto(hash, root, ['diff', '--binary', 'HEAD', '--'])
    await gitInto(hash, root, ['diff', '--cached', '--binary', '--'])
    const untracked = await git('ls-files', '--others', '--exclude-standard', '--full-name', '-z')
    for (const file of untracked.split('\0').filter(Boolean).sort()) {
      hash.update(file).update('\0')
      await fileInto(hash, join(root, file))
      hash.update('\0')
    }
    return { revision, uncommitted: status.length > 0, fingerprint: hash.digest('hex') }
  } catch (e) {
    return unknownRevision((e as Error).message.split('\n')[0].slice(0, 300))
  }
}

/** Verification commands running now, so they can be ended when the app quits. */
const running = new Set<ChildProcess>()

/** The command and everything it started, only while it's known to be running (see core/proc/killTree.ts). */
const killTree = (child: ChildProcess): void => void killChildTree(child)

/** Ends every verification command still running, and everything it started. */
export function stopVerifications(): number {
  const n = running.size
  for (const child of running) killTree(child)
  running.clear()
  return n
}

/**
 * Actual execution is the only producer of command evidence. Callers cannot supply an exit status. The command runs
 * through cmd.exe on Windows (the native shell), not Git Bash: write declared checks for cmd.
 */
export async function executeVerification(attempt: TaskVerification, timeout = 10 * 60_000): Promise<TaskVerification> {
  const result = await new Promise<{ exitCode: number | null; output: string; error?: string }>((resolve) => {
    const child = spawn(attempt.command, { cwd: attempt.cwd, windowsHide: true, env: cleanEnv(process.env, {}), shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    running.add(child)
    const chunks: Buffer[] = []
    const limit = 8 * 1024 * 1024
    let bytes = 0
    let error: string | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      running.delete(child)
      clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      resolve({ exitCode, output: `Command: ${attempt.command}\nCwd: ${attempt.cwd}\nStarted: ${new Date(attempt.startedAt).toISOString()}\n\n${Buffer.concat(chunks).toString('utf8')}`, ...(error ? { error } : {}) })
    }
    const stop = (reason: string): void => {
      if (error || settled) return
      error = reason
      // Killing only cmd.exe leaves its descendants holding the output pipes open.
      killTree(child)
      fallback = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); finish(null) }, 5000)
    }
    const timer = setTimeout(() => stop('Command exceeded the verification time limit'), timeout)
    const output = (chunk: Buffer): void => {
      if (settled) return
      const remaining = limit - bytes
      if (remaining > 0) { const part = chunk.subarray(0, remaining); chunks.push(part); bytes += part.length }
      if (chunk.length > remaining) stop('Command exceeded the verification output limit')
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.on('error', (e) => { error = e.message; finish(null) })
    child.on('close', finish)
  })
  const endedAt = Date.now()
  await writeFile(attempt.outputRef, `${result.output}\nEnded: ${new Date(endedAt).toISOString()}\nExit: ${result.exitCode}\n${result.error ?? ''}`, 'utf8')
  return { ...attempt, endedAt, exitCode: result.exitCode, status: result.exitCode === 0 && !result.error ? 'passed' : 'failed', endRevision: await readRevision(attempt.cwd), ...(result.error ? { error: result.error } : {}) }
}

export async function prepareOutput(dir: string, id: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${id}.log`)
  await writeFile(file, 'Verification started; completion has not been recorded.\n', { flag: 'wx' })
  return file
}
