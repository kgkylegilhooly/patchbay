import { mkdirSync, readdirSync, rmSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

/**
 * Claude Code starts a program for every hook and every status line update, through Git Bash. A busy agent does that
 * several times a second, and starting Node each time kept whole CPU cores busy with ten agents working. The frequent
 * ones are written as bash built-ins that only touch or write a file here instead (see claudeLaunch.ts), so no Node
 * starts, and this watches the folder and hands each on as though it had come through the control server.
 */

/** Hook events that arrive as a touched file. They carry nothing but their name. */
export const SIGNAL_EVENTS = ['PostToolUse', 'PostToolUseFailure'] as const
/** The status line's input, written whole. */
export const STATUS_SIGNAL = 'status'

/** Never two files for one node and kind, and a node id can't reach outside the folder. */
export function signalFile(dir: string, nodeId: string, kind: string): string {
  return join(dir, `${encodeURIComponent(nodeId)}.${kind}`)
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

/** Catches anything the folder watch misses. Only stats a few small files. */
const POLL_MS = 2000
/** A status file is read once it has been quiet this long, so a write in progress isn't read half done. */
const STATUS_SETTLE_MS = 150

export function watchSignals(opts: {
  dir: string
  onHook(nodeId: string, name: string): void
  onStatus(nodeId: string, text: string): void
  pollMs?: number
  log?(message: string): void
}): SignalWatcher {
  const { dir } = opts
  mkdirSync(dir, { recursive: true })
  /** The modified time already handled, by file name. */
  const seen = new Map<string, number>()
  /** When each node's last hook arrived by the control server. */
  const heard = new Map<string, number>()
  const latest = new Map<string, number>()
  const checking = new Set<string>()
  const again = new Set<string>()
  const statusTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let closed = false
  let watcher: FSWatcher | null = null

  // What's here already happened before this launch, so it's noted, not acted on. catchUp handles that.
  try {
    for (const name of readdirSync(dir)) {
      const parsed = parseSignalName(name)
      if (!parsed) continue
      try {
        const at = statSync(join(dir, name)).mtimeMs
        seen.set(name, at)
        if (parsed.kind !== STATUS_SIGNAL) latest.set(parsed.nodeId, Math.max(latest.get(parsed.nodeId) ?? 0, at))
      } catch {
        // Removed in the meantime.
      }
    }
  } catch {
    // An unreadable folder only means nothing was here.
  }

  const readStatus = (name: string, nodeId: string): void => {
    clearTimeout(statusTimers.get(name))
    statusTimers.set(
      name,
      setTimeout(() => {
        statusTimers.delete(name)
        if (closed) return
        readFile(join(dir, name), 'utf8').then(
          (text) => {
            if (closed) return
            try {
              JSON.parse(text)
            } catch {
              // Read while being written. It's read again once the write that's still going lands.
              seen.delete(name)
              return
            }
            opts.onStatus(nodeId, text)
          },
          () => {}
        )
      }, STATUS_SETTLE_MS)
    )
  }

  const check = async (name: string): Promise<void> => {
    const parsed = parseSignalName(name)
    if (!parsed || closed) return
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
      if (parsed.kind === STATUS_SIGNAL) return readStatus(name, parsed.nodeId)
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
      mkdirSync(dir, { recursive: true })
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

  return {
    latestHook: (nodeId) => latest.get(nodeId),
    heardHook(nodeId, at = Date.now()) {
      heard.set(nodeId, Math.max(heard.get(nodeId) ?? 0, at))
    },
    forget(nodeId) {
      heard.delete(nodeId)
      latest.delete(nodeId)
      for (const kind of [...SIGNAL_EVENTS, STATUS_SIGNAL]) {
        const file = signalFile(dir, nodeId, kind)
        seen.delete(basename(file))
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
      for (const timer of statusTimers.values()) clearTimeout(timer)
      watcher?.close()
      watcher = null
    }
  }
}
