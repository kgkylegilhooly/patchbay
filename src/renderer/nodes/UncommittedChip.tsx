import { create } from 'zustand'
import type { AgentStatus } from '../../shared/model'
import { chipLabel, dueForCheck, nextIdleSince } from '../idleUncommitted'
import { useStore } from '../store'
import '../filesView'
import { openCommitOwn } from '../commitOwn'

/** See idleUncommitted.ts: when each agent became idle, when it was last looked at, and what it left uncommitted. */
const useIdleUncommitted = create<{ idleSince: Record<string, number>; checkedAt: Record<string, number>; files: Record<string, string[]> }>(() => ({
  idleSince: {},
  checkedAt: {},
  files: {}
}))

const TICK_MS = 60_000
let started = false

/** Follows statuses, and looks at agents due for a check once a minute. Started by the first chip drawn. */
function watchIdleUncommitted(): void {
  if (started) return
  started = true
  const follow = (statuses: Partial<Record<string, AgentStatus>>): void =>
    useIdleUncommitted.setState((s) => {
      const idleSince = nextIdleSince(s.idleSince, statuses, Date.now())
      // An agent that's working again, or gone, has nothing to say until it's been idle a while once more.
      const keep = <T,>(r: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(r).filter(([id]) => id in idleSince))
      return { idleSince, checkedAt: keep(s.checkedAt), files: keep(s.files) }
    })
  follow(useStore.getState().statuses)
  useStore.subscribe((s, prev) => {
    if (s.statuses !== prev.statuses) follow(s.statuses)
  })
  setInterval(() => {
    const bridge = window.patchbayFiles
    if (!bridge) return
    const now = Date.now()
    const { idleSince, checkedAt } = useIdleUncommitted.getState()
    const agents = new Set((useStore.getState().doc?.nodes ?? []).filter((n) => n.kind === 'claude').map((n) => n.id))
    for (const [id, since] of Object.entries(idleSince)) {
      if (!agents.has(id) || !dueForCheck(now, since, checkedAt[id])) continue
      useIdleUncommitted.setState((s) => ({ checkedAt: { ...s.checkedAt, [id]: now } }))
      void bridge
        .uncommitted(id)
        .catch(() => [] as string[])
        .then((list) =>
          useIdleUncommitted.setState((s) => {
            if (!(id in s.idleSince)) return s
            const next = { ...s.files }
            if (list.length) next[id] = list
            else delete next[id]
            return { files: next }
          })
        )
    }
  }, TICK_MS)
}

/**
 * "2 files uncommitted, idle 1 h" on an idle agent's header. A click opens the Git panel on its folder with those files
 * staged and its last reply as the message, ready to commit (F56).
 */
export function UncommittedChip({ nodeId, cwd, title }: { nodeId: string; cwd: string; title: string }): React.JSX.Element | null {
  watchIdleUncommitted()
  const files = useIdleUncommitted((s) => s.files[nodeId])
  const since = useIdleUncommitted((s) => s.idleSince[nodeId])
  if (!files?.length || since === undefined) return null
  return (
    <button
      type="button"
      // The files chip's look beside it: quiet, a thing to look at, not a status or an alarm.
      className="files-chip nodrag"
      data-uncommitted-chip
      title={`Its own edits, not committed yet:\n${files.slice(0, 12).join('\n')}${files.length > 12 ? `\n…and ${files.length - 12} more` : ''}\n\nStages them in the Git panel, with its last reply as the message. Nothing is committed until you press Commit.`}
      style={{ border: 'none' }}
      onClick={() => void openCommitOwn({ id: nodeId, title, cwd }, files, (folder) => useStore.setState({ gitOpen: true, gitFolder: folder }))}
    >
      {chipLabel(files, Date.now() - since)}
    </button>
  )
}
