import type { AgentStatus } from '../shared/model'

export interface Notifier {
  notify(id: string, status: AgentStatus): void
  /** A run node's command failed by itself. Worth a look, though nobody's waiting, so it gets no chime. */
  runFailed(id: string): void
  setFocusedNode(id: string | null): void
  /** You've looked at this session. */
  markSeen(id: string): void
  /** The window came forward, so a terminal that already had the keyboard is now in front of you. */
  windowFocused(): void
  /** Sessions that notified you, and that you haven't looked at since. */
  unseen(): string[]
  onUnseenChange(cb: () => void): void
}

const BODY: Partial<Record<AgentStatus, string>> = {
  idle: 'Finished its turn.',
  'needs-you': 'Needs you.'
}

export function createNotifier({
  show,
  windowFocused,
  titleOf,
  reveal,
  alert
}: {
  show: (n: { title: string; body: string; click: () => void }) => void
  /** The chime and the taskbar flash, for a session waiting on you. Finishing a turn doesn't call for them. */
  alert?: () => void
  windowFocused: () => boolean
  titleOf: (id: string) => string
  /** Brings the window forward and centers this node. */
  reveal: (id: string) => void
}): Notifier {
  let focused: string | null = null
  const unseen = new Set<string>()
  const listeners: Array<() => void> = []
  const markSeen = (id: string): void => {
    if (unseen.delete(id)) for (const cb of listeners) cb()
  }
  const announce = (id: string, body: string): void => {
    if (focused === id && windowFocused()) return
    if (!unseen.has(id)) {
      unseen.add(id)
      for (const cb of listeners) cb()
    }
    show({ title: titleOf(id), body, click: () => reveal(id) })
  }
  return {
    runFailed: (id) => announce(id, 'Stopped with an error.'),
    setFocusedNode(id) {
      focused = id
      if (id && windowFocused()) markSeen(id)
    },
    markSeen,
    windowFocused() {
      if (focused) markSeen(focused)
    },
    unseen: () => [...unseen],
    onUnseenChange(cb) {
      listeners.push(cb)
    },
    notify(id, status) {
      const body = BODY[status]
      if (!body) return
      if (focused === id && windowFocused()) return
      if (!unseen.has(id)) {
        unseen.add(id)
        for (const cb of listeners) cb()
      }
      if (status === 'needs-you') alert?.()
      show({ title: titleOf(id), body, click: () => reveal(id) })
    }
  }
}
