import type { DocsBridge } from '../../shared/reader'

export interface DocsWindowBridge extends DocsBridge {
  /** Main says a watched file changed. */
  onChanged(cb: (path: string) => void): () => void
  /** The full path of a file dropped on the window, which the page can't see by itself. */
  pathOfFile(file: File): string
}

declare global {
  interface Window {
    patchbayDocs: DocsWindowBridge
  }
}

/** The reader's calls to main. Looked up on use, so this module loads where there's no window, as in tests. */
export const docsBridge = (): DocsWindowBridge => window.patchbayDocs

/** The same file however its path is written, as main keys it on Windows. */
export const samePath = (a: string, b: string): boolean => a.replace(/\//g, '\\').toLowerCase() === b.replace(/\//g, '\\').toLowerCase()
