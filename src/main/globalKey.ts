/**
 * F62: a key that works from any program (Settings > Notifications, off by default). It brings Patchbay forward on the
 * next agent needing you. Electron's globalShortcut is passed in, so this can be tested.
 */

export interface GlobalKeyState {
  /** The key as set, or null when it's off. */
  key: string | null
  ok: boolean
  /** Why it isn't working, when it isn't. */
  reason?: string
}

const MODIFIER = /^(ctrl|control|alt|super|win|meta|cmdorctrl|commandorcontrol)$/i
const ANY_MODIFIER = /^(ctrl|control|alt|shift|super|win|meta|cmdorctrl|commandorcontrol|altgr|option)$/i

/** Why a key can't be used from anywhere, or null. It must hold Ctrl, Alt or Win, so typing is never taken from other programs. */
export function globalKeyProblem(key: string): string | null {
  const parts = key.split('+').map((p) => p.trim())
  const last = parts.at(-1) ?? ''
  if (!last || ANY_MODIFIER.test(last)) return `"${key}" has no key to press after its modifiers.`
  if (parts.slice(0, -1).some((p) => !ANY_MODIFIER.test(p))) return `"${key}" isn't one key: only Ctrl, Alt, Shift and Win go before the key.`
  if (!parts.slice(0, -1).some((p) => MODIFIER.test(p))) return `"${key}" needs Ctrl, Alt or Win with it, or it would take that key from every program.`
  return null
}

export function createGlobalKey(d: {
  register(accelerator: string, cb: () => void): boolean
  unregister(accelerator: string): void
  onPress(): void
}): { apply(key: string | undefined): GlobalKeyState; state(): GlobalKeyState; dispose(): void } {
  /** The key held now, if any. */
  let held: string | null = null
  let last: GlobalKeyState = { key: null, ok: true }
  const release = (): void => {
    if (held) d.unregister(held)
    held = null
  }
  return {
    apply(raw) {
      const key = raw?.trim() || null
      if (key === held) return last
      release()
      if (!key) return (last = { key: null, ok: true })
      const problem = globalKeyProblem(key)
      if (problem) return (last = { key, ok: false, reason: problem })
      let ok = false
      try {
        ok = d.register(key, d.onPress)
      } catch (e) {
        return (last = { key, ok: false, reason: `"${key}" isn't a key Windows knows: ${(e as Error).message}` })
      }
      if (!ok) return (last = { key, ok: false, reason: `Another program already uses ${key}. Pick another key.` })
      held = key
      return (last = { key, ok: true })
    },
    state: () => last,
    dispose: release
  }
}
