import { mkdirSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Claude Code starts a program for every hook and every status line update, through Git Bash. A busy agent does that
 * several times a second, and starting Node each time kept whole CPU cores busy with ten agents working. The frequent
 * ones are written as bash built-ins that only touch or write a file here instead (see claudeLaunch.ts), so no Node
 * starts, and this hands each on as though it had come through the control server.
 *
 * Tool calls touch a file in the watched folder, so their news arrives at once. Status lines write far more often, and
 * watching a folder written forty times a second cost the app a twelfth of a core in change events alone, so they go
 * in a folder of their own that's looked at once a second: usage numbers don't need to be fresher than that.
 */

/** Hook events that arrive as a touched file. They carry nothing but their name. */
export const SIGNAL_EVENTS = ['PostToolUse', 'PostToolUseFailure'] as const
/** The status line's input, written whole. */
export const STATUS_SIGNAL = 'status'
const STATUS_DIR = 'status'

/** Never two files for one node and kind, and a node id can't reach outside the folder. */
export function signalFile(dir: string, nodeId: string, kind: string): string {
  return join(dir, `${encodeURIComponent(nodeId)}.${kind}`)
}

/** Where a node's status line writes its input. */
export function statusFile(dir: string, nodeId: string): string {
  return signalFile(join(dir, STATUS_DIR), nodeId, STATUS_SIGNAL)
}

export function parseSignalName(name: string): { nodeId: string; kind: string } | null {
  const at = name.lastIndexOf('.')
  if (at <= 0) return null
  const kind = name.slice(at + 1)
  if (kind !== STATUS_SIGNAL && !(SIGNAL_EVENTS as readonly string[]).includes(kind)) return null
  try {
    return { nodeId: decodeURIComponent(name.slice(0, at)), kind }
  } catch {
    return null
  }
}

export interface SignalWatcher {
  /** When a node last signalled a hook, if it has: for catching up on what happened while the app was closed. */
  latestHook(nodeId: string): number | undefined
  /**
   * A hook came in by the usual route. A signal touched before then is older news: without this, a tool's end noticed
   * late could land after the turn's Stop and leave the node showing it's working.
   */
  heardHook(nodeId: string, at?: number): void
  /** Removes a closed node's files. */
  forget(nodeId: string): void
  close(): void
}

/** Catches any tool call the folder watch misses. Only stats a few small files. */
const POLL_MS = 2000
/** How often status lines are looked at. */
const STATUS_EVERY_MS = 1000

/** Each file's modified time, from a folder as it is now. Files that vanish meanwhile are left out. */
function timesIn(dir: string): Map<string, number> {
  const times = new Map<string, number>()
  try {
    for (const name of readdirSync(dir)) {
      try {
        times.set(name, statSync(join(dir, name)).mtimeMs)
      } catch {
        // Removed in the meantime.
      }
    }
  } catch {
    // An unreadable folder only means nothing was here.
  }
  return times
}

export function watchSignals(opts: {
  dir: string
  onHook(nodeId: string, name: string): void
  onStatus(nodeId: string, text: string): void
  pollMs?: number
  statusEveryMs?: number
  log?(message: string): void
}): SignalWatcher {
  const { dir } = opts
  const statusDir = join(dir, STATUS_DIR)
  mkdirSync(statusDir, { recursive: true })
  /** When each node's last hook arrived by the control server. */
  const heard = new Map<string, number>()
  const latest = new Map<string, number>()
  const checking = new Set<string>()
  const again = new Set<string>()
  let closed = false
  let watcher: FSWatcher | null = null

  // What's here already happened before this launch, so it's noted, not acted on. catchUp handles that.
  const seen = timesIn(dir)
  for (const [name, at] of seen) {
    const parsed = parseSignalName(name)
    if (parsed && parsed.kind !== STATUS_SIGNAL) latest.set(parsed.nodeId, Math.max(latest.get(parsed.nodeId) ?? 0, at))
  }
  /** By full path, as status lines are read from two folders. See lookAtStatus. */
  const statusSeen = new Map<string, number>()
  for (const [name, at] of timesIn(statusDir)) statusSeen.set(join(statusDir, name), at)
  for (const [name, at] of seen) if (parseSignalName(name)?.kind === STATUS_SIGNAL) statusSeen.set(join(dir, name), at)
  const statusText = new Map<string, string>()

  const check = async (name: string): Promise<void> => {
    const parsed = parseSignalName(name)
    if (!parsed || parsed.kind === STATUS_SIGNAL || closed) return
    // One look at a time per file; a change during it is looked at again afterward.
    if (checking.has(name)) {
      again.add(name)
      return
    }
    checking.add(name)
    try {
      let at: number
      try {
        at = (await stat(join(dir, name))).mtimeMs
      } catch {
        return
      }
      if (closed || at <= (seen.get(name) ?? -1)) return
      seen.set(name, at)
      latest.set(parsed.nodeId, Math.max(latest.get(parsed.nodeId) ?? 0, at))
      if (at <= (heard.get(parsed.nodeId) ?? -1)) return
      opts.onHook(parsed.nodeId, parsed.kind)
    } finally {
      checking.delete(name)
      if (again.delete(name)) void check(name)
    }
  }

  const startWatching = (): void => {
    if (closed || watcher) return
    try {
      watcher = watch(dir, (_event, filename) => {
        if (filename) void check(filename.toString())
      })
      watcher.on('error', (e) => {
        opts.log?.(`Signal folder watch stopped: ${e.message}`)
        watcher?.close()
        watcher = null
      })
    } catch (e) {
      opts.log?.(`Signal folder couldn't be watched: ${(e as Error).message}`)
      watcher = null
    }
  }
  startWatching()

  const poll = setInterval(() => {
    if (!watcher) {
      mkdirSync(statusDir, { recursive: true })
      startWatching()
    }
    readdir(dir).then(
      (names) => {
        for (const name of names) void check(name)
      },
      () => {}
    )
  }, opts.pollMs ?? POLL_MS)
  poll.unref?.()

  /** Reads each status file that changed since it was last read. A half-written one is read again next time. */
  let lookingAtStatus = false
  const lookAtStatus = async (): Promise<void> => {
    if (lookingAtStatus || closed) return
    lookingAtStatus = true
    try {
      // Sessions started by the build before this one write their status line beside the tool signals. They're read
      // there too, until they restart.
      const names = [
        ...(await readdir(statusDir).catch(() => [] as string[])).map((name) => ({ name, file: join(statusDir, name) })),
        ...(await readdir(dir).catch(() => [] as string[])).map((name) => ({ name, file: join(dir, name) }))
      ]
      await Promise.all(
        names.map(async ({ name, file }) => {
          const parsed = parseSignalName(name)
          if (parsed?.kind !== STATUS_SIGNAL) return
          try {
            const at = (await stat(file)).mtimeMs
            if (at <= (statusSeen.get(file) ?? -1)) return
            const text = await readFile(file, 'utf8')
            JSON.parse(text)
            statusSeen.set(file, at)
            // Claude reruns the status line on every message, mostly with nothing new to say.
            if (text === statusText.get(file)) return
            statusText.set(file, text)
            if (!closed) opts.onStatus(parsed.nodeId, text)
          } catch {
            // Gone, or read while being written: looked at again next time.
          }
        })
      )
    } finally {
      lookingAtStatus = false
    }
  }
  const statusPoll = setInterval(() => void lookAtStatus(), opts.statusEveryMs ?? STATUS_EVERY_MS)
  statusPoll.unref?.()

  return {
    latestHook: (nodeId) => latest.get(nodeId),
    heardHook(nodeId, at = Date.now()) {
      heard.set(nodeId, Math.max(heard.get(nodeId) ?? 0, at))
    },
    forget(nodeId) {
      heard.delete(nodeId)
      latest.delete(nodeId)
      const files = [...SIGNAL_EVENTS.map((kind) => signalFile(dir, nodeId, kind)), statusFile(dir, nodeId), signalFile(dir, nodeId, STATUS_SIGNAL)]
      for (const file of files) {
        seen.delete(basename(file))
        statusSeen.delete(file)
        statusText.delete(file)
        try {
          rmSync(file, { force: true })
        } catch {
          // Held open by a status line still writing. It's only a small file.
        }
      }
    },
    close() {
      closed = true
      clearInterval(poll)
      clearInterval(statusPoll)
      watcher?.close()
      watcher = null
    }
  }
}
