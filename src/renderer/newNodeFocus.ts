/**
 * A node made from a form or New terminal is added through the main process, so it's drawn a moment after it's asked
 * for. This waits for it to be drawn and then acts once, as selecting it does. It gives up after `timeoutMs`, so a
 * node that never arrives (refused, or removed at once) leaves nothing waiting. See docs/plans/r3-start.md.
 */
export const DRAWN_WAIT_MS = 3000
const STEP_MS = 16

export function whenNodeDrawn(
  id: string,
  drawn: (id: string) => unknown,
  act: (id: string) => void,
  opts: { timeoutMs?: number; later?: (fn: () => void, ms: number) => unknown; now?: () => number } = {}
): void {
  const later = opts.later ?? ((fn, ms) => setTimeout(fn, ms))
  const now = opts.now ?? Date.now
  const until = now() + (opts.timeoutMs ?? DRAWN_WAIT_MS)
  const check = (): void => {
    if (drawn(id)) return act(id)
    if (now() < until) later(check, STEP_MS)
  }
  later(check, 0)
}
