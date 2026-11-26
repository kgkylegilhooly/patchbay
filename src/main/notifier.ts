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

/** What leads a detail, in place of the plain words. */
const LEAD: Partial<Record<AgentStatus, string>> = {
  idle: 'Finished',
  'needs-you': 'Needs you'
}

/** How long a notification waits for its detail before going with the plain words. */
const DETAIL_WAIT_MS = 1500
/** A notification shows a few lines at most, so a reply's first line is cut at about this. */
const HEADLINE_MAX = 140

/**
 * A reply's first line that says something, as plain text: code blocks skipped, Markdown marks left out, spaces
 * squeezed, cut at a word. Null when there's nothing but code or space.
 */
export function headline(text: string): string | null {
  let inCode = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const line = raw
      .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, '')
      .replace(/(\*\*|__|`|~~)/g, '')
      .replace(/(^|[\s(])[*_]([^*_]+)[*_](?=$|[\s.,;:!?)])/g, '$1$2')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line) continue
    if (line.length <= HEADLINE_MAX) return line
    const cut = line.slice(0, HEADLINE_MAX)
    const space = cut.lastIndexOf(' ')
    return `${(space > HEADLINE_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, '')}…`
  }
  return null
}

export function createNotifier({
  show,
  windowFocused,
  titleOf,
  reveal,
  alert,
  muted,
  detail
}: {
  /**
   * More than the status says, when it can be had quickly: an agent's reply, or what it asks. Null, an error or no
   * answer within DETAIL_WAIT_MS leaves the plain words. The chime and the unseen mark never wait for it.
   */
  detail?: (id: string, status: AgentStatus) => Promise<string | null>
  show: (n: { title: string; body: string; click: () => void }) => void
  /** The chime and the taskbar flash, for a session waiting on you. Finishing a turn doesn't call for them. */
  alert?: () => void
  windowFocused: () => boolean
  titleOf: (id: string) => string
  /** Brings the window forward and centers this node. */
  reveal: (id: string) => void
  /** A window muted from its menu: it still counts as unseen, but gets no notification, chime or flash. */
  muted?: (id: string) => boolean
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
    if (muted?.(id)) return
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
      if (muted?.(id)) return
      if (status === 'needs-you') alert?.()
      const send = (text: string): void => show({ title: titleOf(id), body: text, click: () => reveal(id) })
      if (!detail) return send(body)
      let timer: ReturnType<typeof setTimeout> | undefined
      const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), DETAIL_WAIT_MS)))
      void Promise.race([detail(id, status).catch(() => null), late]).then((said) => {
        clearTimeout(timer)
        send(said ? `${LEAD[status]}: ${said}` : body)
      })
    }
  }
}
