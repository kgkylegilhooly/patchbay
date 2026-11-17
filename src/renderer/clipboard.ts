import { bridge } from './bridge'

/**
 * Copies text, through Electron's clipboard first. The page's own clipboard can be refused, as when the window isn't
 * focused or a PC's policy blocks it, and copying a link is the fallback for when opening one is blocked, so it has
 * to work.
 */
export async function copyText(text: string): Promise<void> {
  try {
    await bridge.writeClipboard(text)
  } catch {
    await navigator.clipboard.writeText(text)
  }
}
