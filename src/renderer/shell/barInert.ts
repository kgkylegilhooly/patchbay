import { useEffect } from 'react'

/**
 * The dim layers a dialog puts over the stage: a modal's or confirmation's, the command palette's, the archive one's.
 * While any is open, the title bar above the stage (menus, project tabs) is dimmed and inert too, so nothing behind a
 * dialog acts, as clicking another project's tab while 'Delete "Website"?' waits would.
 */
export const DIALOG_LAYERS = ':scope > .shell-layer, :scope > .palette-back, :scope > .projects-scrim'

/** Sets the bar to match the stage: inert and dimmed while a dialog layer is there. Returns whether one is. */
export function syncBar(stage: Pick<Element, 'querySelector'>, bar: Pick<Element, 'toggleAttribute' | 'classList'>): boolean {
  const open = !!stage.querySelector(DIALOG_LAYERS)
  bar.toggleAttribute('inert', open)
  bar.classList.toggle('bar-under-dialog', open)
  return open
}

/** Watches the stage's children (dialog layers come and go as children) once the canvas is drawn. */
export function useBarInertUnderDialogs(ready: boolean): void {
  useEffect(() => {
    if (!ready) return
    const stage = document.querySelector('.app > .stage')
    const bar = document.querySelector('.app > .bar')
    if (!stage || !bar) return
    const sync = (): void => void syncBar(stage, bar)
    const watch = new MutationObserver(sync)
    watch.observe(stage, { childList: true })
    sync()
    return () => {
      watch.disconnect()
      bar.removeAttribute('inert')
      bar.classList.remove('bar-under-dialog')
    }
  }, [ready])
}
