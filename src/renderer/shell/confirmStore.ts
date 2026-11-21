/** What a confirmation asks. One shape for every destructive action. */
export interface ConfirmSpec {
  /** A question: "Delete project?" */
  title: string
  /** What happens, in a sentence. */
  message?: string
  /** Consequences, most important first. */
  lines?: string[]
  /** The committing button: "Delete project". */
  verb: string
  /** Danger: a red verb, and focus starts on Cancel so Enter is safe. Neutral: a white verb, focused. */
  tone?: 'danger' | 'neutral'
  cancelLabel?: string
  /** Hooks for tests and scripts, on the dialog and its two buttons. */
  attrs?: Record<string, string>
  verbAttrs?: Record<string, string>
  cancelAttrs?: Record<string, string>
}

interface Pending {
  id: number
  spec: ConfirmSpec
  settle: (ok: boolean) => void
}

let queue: Pending[] = []
let nextId = 1
const listeners = new Set<() => void>()
/** The same object until the queue's head changes, as useSyncExternalStore needs. */
let snapshot: { id: number; spec: ConfirmSpec } | null = null
const emit = (): void => {
  const top = queue[0]
  if ((top?.id ?? null) !== (snapshot?.id ?? null)) snapshot = top ? { id: top.id, spec: top.spec } : null
  listeners.forEach((l) => l())
}

/**
 * Asks, and resolves true only if the person pressed the verb. Several asks wait their turn, oldest first.
 */
export function askConfirm(spec: ConfirmSpec): Promise<boolean> {
  return new Promise((resolve) => {
    queue = [...queue, { id: nextId++, spec, settle: resolve }]
    emit()
  })
}

/** The confirmation showing now, if any. */
export function currentConfirm(): { id: number; spec: ConfirmSpec } | null {
  return snapshot
}

/** Answers the confirmation showing now. An id that isn't showing any more is ignored. */
export function settleConfirm(id: number, ok: boolean): void {
  const top = queue[0]
  if (!top || top.id !== id) return
  queue = queue.slice(1)
  top.settle(ok)
  emit()
}

/** Cancels every waiting confirmation. App calls it when the project on screen changes. */
export function cancelAllConfirms(): void {
  const was = queue
  queue = []
  was.forEach((p) => p.settle(false))
  if (was.length) emit()
}

export function subscribeConfirm(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Ask, then run only on yes. */
export async function confirmThen(spec: ConfirmSpec, run: () => void | Promise<unknown>): Promise<void> {
  if (await askConfirm(spec)) await run()
}
