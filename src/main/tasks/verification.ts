import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { TaskRevision, TaskVerification } from '../../shared/task'
import { cleanEnv } from '../sessions/env'

const runFile = promisify(execFile)
export const unknownRevision = (): TaskRevision => ({ revision: null, uncommitted: null, fingerprint: null })

export async function readRevision(cwd: string): Promise<TaskRevision> {
  try {
    const root = (await runFile('git', ['rev-parse', '--show-toplevel'], { cwd, windowsHide: true, timeout: 15000 })).stdout.trim()
    const git = async (...args: string[]): Promise<string> => (await runFile('git', args, { cwd: root, windowsHide: true, timeout: 15000, maxBuffer: 32 * 1024 * 1024 })).stdout
    const revision = (await git('rev-parse', 'HEAD')).trim()
    const status = await git('status', '--porcelain=v1', '-z', '--untracked-files=all')
    const hash = createHash('sha256').update(status)
    hash.update(await git('diff', '--binary', 'HEAD', '--'))
    hash.update(await git('diff', '--cached', '--binary', '--'))
    const untracked = await git('ls-files', '--others', '--exclude-standard', '--full-name', '-z')
    for (const file of untracked.split('\0').filter(Boolean).sort()) {
      hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0')
    }
    return { revision, uncommitted: status.length > 0, fingerprint: hash.digest('hex') }
  } catch {
    return unknownRevision()
  }
}

/** Actual execution is the only producer of command evidence. Callers cannot supply an exit status. */
export async function executeVerification(attempt: TaskVerification, timeout = 10 * 60_000): Promise<TaskVerification> {
  const result = await new Promise<{ exitCode: number | null; output: string; error?: string }>((resolve) => {
    const child = spawn(attempt.command, { cwd: attempt.cwd, windowsHide: true, env: cleanEnv(process.env, {}), shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    const limit = 8 * 1024 * 1024
    let bytes = 0
    let error: string | undefined
    let fallback: ReturnType<typeof setTimeout> | undefined
    let settled = false
    const finish = (exitCode: number | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (fallback) clearTimeout(fallback)
      resolve({ exitCode, output: `Command: ${attempt.command}\nCwd: ${attempt.cwd}\nStarted: ${new Date(attempt.startedAt).toISOString()}\n\n${Buffer.concat(chunks).toString('utf8')}`, ...(error ? { error } : {}) })
    }
    const stop = (reason: string): void => {
      if (error || settled) return
      error = reason
      // Killing only cmd.exe leaves its descendants holding the output pipes open.
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      else child.kill('SIGKILL')
      fallback = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null) }, 5000)
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
