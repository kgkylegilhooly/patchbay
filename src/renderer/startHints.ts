/**
 * Words and small decisions for first run and starting agents (docs/plans/r3-start.md). Pure, so they're tested
 * without a page.
 */
import type { CanvasDoc } from '../shared/model'

/** Under an empty project in the sidebar: the help once, under the project on screen, and a quiet "None" elsewhere. */
export function emptyProjectHint(active: boolean): string {
  return active ? 'No sessions here. Right-click the canvas to open one.' : 'None'
}

export type FormKind = 'claude' | 'codex' | 'terminal' | 'run' | 'team'

/** Why a New form's Start can't be used yet, in the words shown under it. Null when it can. */
export function blockedReason(kind: FormKind, fields: { cwd: string; text: string }): string | null {
  const agent = kind === 'claude' || kind === 'codex' || kind === 'team'
  if (agent && !fields.cwd) return 'Choose a folder first'
  if (kind === 'team' && !fields.text.trim()) return 'Describe the task first'
  if (kind === 'run' && !fields.text.trim()) return 'Type a command first'
  return null
}

/**
 * A folder chosen in a New form for an agent becomes the project's own, when the project has none yet: the next
 * agent then starts there with no picker. Never over a folder the project already has, and never a group's worktree.
 */
export function folderToKeep(doc: CanvasDoc, kind: string, fields: { cwd: string; chose?: boolean }): { projectId: string; folder: string; name: string } | null {
  if (kind !== 'claude' && kind !== 'codex' && kind !== 'team') return null
  if (!fields.chose || !fields.cwd) return null
  const project = doc.projects.find((p) => p.id === doc.activeProjectId)
  if (!project || project.folder) return null
  if (doc.nodes.some((n) => n.kind === 'group' && n.worktree?.path === fields.cwd)) return null
  return { projectId: project.id, folder: fields.cwd, name: project.name }
}

/**
 * Asks while nothing is being asked: a second ask while the first is open gets `undefined` and opens nothing. For the
 * folder picker, whose answer may start an agent: two pickers would start two.
 */
export function oneOpen<T>(ask: () => Promise<T>): () => Promise<T | undefined> {
  let open = false
  return async () => {
    if (open) return undefined
    open = true
    try {
      return await ask()
    } finally {
      open = false
    }
  }
}

/** Runs `fn` the first time only: a form starts one thing, however many times Ctrl+Enter or a picker answers. */
export function once<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void {
  let done = false
  return (...args) => {
    if (done) return
    done = true
    fn(...args)
  }
}
