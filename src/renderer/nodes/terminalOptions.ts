import type { CanvasNode } from '../../shared/model'

/**
 * Whether a clear-screen (ED2) pushes what was on the screen into scrollback, as PuTTY does, rather than wiping it.
 *
 * A fresh ConPTY shell begins with ED2 then paints its screen, so a terminal's or run's restored output (Restart,
 * start-up restore, Reopen) was wiped wherever it was still on screen: all of a short one, divider included. Pushed
 * up instead, it stays above the new shell. ConPTY sends ED2 only then: a resize repaints line by line, and `cls` or
 * Clear-Host erases lines and then scrollback (ED3), so those behave as before. xterm pushes rows only up to the last
 * one with text, so an empty screen adds nothing. An agent's window is left alone: its program draws its own screen,
 * and it has no restored output.
 */
export const keepsScreenOnClear = (kind: CanvasNode['kind'] | undefined): boolean => kind === 'terminal' || kind === 'run'
