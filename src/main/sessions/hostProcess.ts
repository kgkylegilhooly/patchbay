import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createScrollbackStore } from '../../core/persist/scrollbackStore'
import { createSessionHost } from './host'
import { limitsFrom, startPolicy, stepPolicy } from './hostPolicy'
import { startHostHooks, type HostHooks } from './hostHooks'
import { HOST_PROTOCOL, pipeNameFor } from './hostProtocol'
import { startHostServer, type HostServer } from './hostServer'
import { HELPER_PROBLEM_LOG, onHelperProblem } from '../../core/proc/safeKill'

/** While no app is connected, the host keeps saved scrollback current itself, so a reboot loses little. */
const SAVE_EVERY_MS = 5000
const MAX_LOG_BYTES = 1024 * 1024
const STOP_LIMIT_MS = 5000

const dataDir = process.argv[2]
if (!dataDir) process.exit(2)
process.title = 'Patchbay session host'

const controlDir = join(dataDir, 'control')
const logFile = join(controlDir, 'host.log')
const secretFile = join(controlDir, 'host-secret')
const infoFile = join(controlDir, 'host.json')

function log(message: string): void {
  try {
    if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) rmSync(logFile, { force: true })
    appendFileSync(logFile, `${new Date().toISOString()} ${process.pid} ${message}\n`)
  } catch {
    // With nowhere to log there's nothing more to do, and a host must not end over it.
  }
}

// One session's trouble must never take the others down with it.
process.on('uncaughtException', (e) => log(`Uncaught: ${e.stack ?? e}`))
process.on('unhandledRejection', (e) => log(`Unhandled: ${String(e)}`))

function readSecret(): string | null {
  try {
    return readFileSync(secretFile, 'utf8').trim() || null
  } catch {
    return null
  }
}

async function main(): Promise<void> {
  const secret = readSecret()
  if (!secret) {
    log('No secret to authenticate the app with, so the host is not starting.')
    process.exit(3)
  }
  const limits = limitsFrom(process.env.PATCHBAY_HOST_LIMITS)
  // The app says which version started this. Only acceptance runs set the protocol, to stand in for an older host.
  const protocol = Number(process.env.PATCHBAY_HOST_PROTOCOL) || HOST_PROTOCOL
  const version = process.env.PATCHBAY_HOST_VERSION || 'unknown'
  // Sessions get the environment the app builds for them, never this one.
  const sessions = createSessionHost()
  const scrollback = createScrollbackStore(dataDir)
  const startedAt = Date.now()
  /** The profile is still the one this host started for. */
  const dataPresent = (): boolean => readSecret() === secret

  /** Sessions that keep saved scrollback. A Claude node redraws itself on resume and doesn't. */
  const saved = new Set<string>()
  const dirty = new Set<string>()
  let server: HostServer | null = null
  // Sessions' hooks come here over http, so an event starts no process. Without it, sessions keep command hooks.
  const hooks: HostHooks | null = await startHostHooks({ journalDir: join(controlDir, 'missed'), log }).catch((e: unknown) => {
    log(`Could not serve hooks: ${String(e)}`)
    return null
  })

  // Once, the first time it happens: diagnostics reads it from here. See docs/plans/r5-jobkill.md.
  onHelperProblem((why) => log(`${HELPER_PROBLEM_LOG} ${why}`))

  const saveDirty = async (): Promise<void> => {
    // Writing into a deleted profile would bring its folders back.
    if (!dataPresent()) return
    const known = new Set(sessions.list().map((s) => s.id))
    const ids = [...dirty].filter((id) => known.has(id))
    dirty.clear()
    await Promise.all(ids.map((id) => scrollback.write(id, sessions.snapshot(id).data).catch((e: unknown) => log(`Could not save scrollback: ${String(e)}`))))
  }

  sessions.onOutput((id) => {
    if (saved.has(id)) dirty.add(id)
  })

  let stopping = false
  const stop = async (why: string): Promise<void> => {
    if (stopping) return
    stopping = true
    log(`Stopping: ${why}`)
    const finish = (): void => {
      try {
        rmSync(infoFile, { force: true })
      } catch {
        // Readers check that the pid in it is alive.
      }
      process.exit(0)
    }
    setTimeout(finish, STOP_LIMIT_MS).unref()
    await Promise.all(sessions.list().filter((s) => s.running).map((s) => sessions.kill(s.id)))
    // With an app connected, the app does this saving itself.
    if (!server?.connected()) {
      for (const id of saved) dirty.add(id)
      await saveDirty()
    }
    // Events still waiting for an app go in the journal, for the next one to read.
    await hooks?.flush()
    await server?.close()
    await hooks?.close()
    finish()
  }

  server = await startHostServer({
    pipe: pipeNameFor(dataDir),
    secret,
    protocol,
    version,
    startedAt,
    sessions,
    log,
    ...(hooks ? { hooks } : {}),
    onStopRequested: () => void stop('the app asked'),
    onSessionStarted(spec) {
      if (spec.saveScrollback) saved.add(spec.nodeId)
      else saved.delete(spec.nodeId)
    },
    onSessionForgotten: (id) => void saved.delete(id),
    onConnectionChange(connected) {
      log(connected ? 'App connected.' : 'App disconnected.')
      // Output in the app's last moments may not have reached its own save.
      if (!connected) for (const id of saved) dirty.add(id)
    }
  })

  mkdirSync(controlDir, { recursive: true })
  const tmp = `${infoFile}.tmp`
  writeFileSync(tmp, JSON.stringify({ pid: process.pid, protocol, version, startedAt, ...(hooks ? { hookPort: hooks.port } : {}) }))
  renameSync(tmp, infoFile)
  log(`Started: protocol ${protocol}, version ${version}${hooks ? `, hooks on port ${hooks.port}` : ''}.`)

  setInterval(() => {
    if (!server?.connected()) void saveDirty()
  }, SAVE_EVERY_MS)

  let policy = startPolicy(Date.now())
  setInterval(() => {
    const running = sessions.list().filter((s) => s.running).length
    const step = stepPolicy(policy, { now: Date.now(), connected: server?.connected() ?? false, running, dataPresent: dataPresent() }, limits)
    policy = step.state
    if (step.exit) void stop(`policy: ${step.exit}`)
  }, limits.tickMs)
}

main().catch((e: unknown) => {
  // The usual cause is another host already owning this profile's pipe, which is fine.
  log(`Could not start: ${String(e)}`)
  process.exit(1)
})
