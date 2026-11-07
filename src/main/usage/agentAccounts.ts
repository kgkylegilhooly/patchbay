import { spawn } from 'node:child_process'
import type { AgentAccount, CodexUsage, CodexWindow } from '../../shared/usage'
import { programArgs, type ClaudeProgram } from '../sessions/claudeLaunch'
import { cleanEnv } from '../sessions/env'

type Fields = Record<string, unknown>
const fields = (v: unknown): Fields => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Fields) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

/** What `claude auth status --json` prints. Null when nobody is signed in. */
export function parseClaudeAccount(text: string): AgentAccount | null {
  let raw: Fields
  try {
    raw = fields(JSON.parse(text))
  } catch {
    return null
  }
  if (raw.loggedIn !== true) return null
  const account: AgentAccount = {}
  const email = str(raw.email)
  const organization = str(raw.orgName)
  const plan = str(raw.subscriptionType) ?? str(raw.planTier)
  if (email) account.email = email
  if (organization) account.organization = organization
  if (plan) account.plan = plan
  return account
}

function codexWindow(v: unknown): CodexWindow | null {
  const w = fields(v)
  const percent = num(w.usedPercent)
  const resetsAt = num(w.resetsAt)
  const minutes = num(w.windowDurationMins)
  return percent === undefined || resetsAt === undefined || minutes === undefined ? null : { percent, resetsAt, minutes }
}

/** The answer to Codex's account/rateLimits/read, shortest window first. */
export function parseCodexLimits(result: unknown): CodexWindow[] {
  const limits = fields(fields(result).rateLimits)
  return [codexWindow(limits.primary), codexWindow(limits.secondary)].filter((w): w is CodexWindow => w !== null).sort((a, b) => a.minutes - b.minutes)
}

/** The answer to Codex's account/read. */
export function parseCodexAccount(result: unknown): AgentAccount | null {
  const a = fields(fields(result).account)
  const email = str(a.email)
  if (!email && !str(a.type)) return null
  const account: AgentAccount = {}
  if (email) account.email = email
  const workspace = str(a.workspaceName)
  if (workspace) account.organization = workspace
  const plan = str(a.planType)
  if (plan) account.plan = plan
  return account
}

const ASK_TIMEOUT_MS = 20_000

/** Runs a program and collects what it prints, ending it if it takes too long. */
function runToEnd(program: ClaudeProgram, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(program.file, programArgs(program, args), { env: cleanEnv(process.env, {}), windowsHide: true, windowsVerbatimArguments: program.prefixArgs.length > 0 })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('it took too long to answer'))
    }, ASK_TIMEOUT_MS)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', () => {
      clearTimeout(timer)
      resolve(out)
    })
  })
}

export async function readClaudeAccount(claude: ClaudeProgram): Promise<AgentAccount | null> {
  return parseClaudeAccount(await runToEnd(claude, ['auth', 'status', '--json']))
}

/**
 * Asks Codex's app server, over JSON-RPC on stdio, for its limits and account. Both are read-only and spend nothing.
 * The server is ended as soon as both answers are in.
 */
export function readCodexUsage(codex: ClaudeProgram, now = Date.now): Promise<CodexUsage> {
  return new Promise((resolve, reject) => {
    const child = spawn(codex.file, programArgs(codex, ['app-server']), { env: cleanEnv(process.env, {}), windowsHide: true, windowsVerbatimArguments: codex.prefixArgs.length > 0 })
    let buffer = ''
    let limits: unknown
    let account: unknown
    let settled = false
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      if (error) reject(error)
      else resolve({ windows: parseCodexLimits(limits), account: parseCodexAccount(account), at: now(), problem: null })
    }
    const timer = setTimeout(() => finish(new Error('Codex took too long to answer')), ASK_TIMEOUT_MS)
    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`)
    }
    child.on('error', (e) => finish(e))
    child.on('close', () => finish(new Error('Codex closed before answering')))
    child.stdin.on('error', () => {})
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        let m: Fields
        try {
          m = fields(JSON.parse(line))
        } catch {
          continue
        }
        if (m.id === 1) {
          send({ method: 'initialized' })
          send({ id: 2, method: 'account/rateLimits/read' })
          send({ id: 3, method: 'account/read', params: {} })
        }
        if (m.id === 2) limits = m.result ?? null
        if (m.id === 3) account = m.result ?? null
        if (m.id === 2 && m.error) return finish(new Error(str(fields(m.error).message) ?? 'Codex refused to give its limits'))
        if (limits !== undefined && account !== undefined) return finish()
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'patchbay', version: '1.0.0' } } })
  })
}
