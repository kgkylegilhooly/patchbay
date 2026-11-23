import { BLANK } from '../../shared/browserPolicy'
import type { BrowserState } from '../../shared/contract'

/**
 * Whether a browser node shows nothing: on the blank page, and not loading another. The page it's on comes from main
 * once it's attached; before that, from the node. A page that's loading counts as a page, so the hint never covers one
 * on its way in.
 */
export function isBlankPage(state: Pick<BrowserState, 'url' | 'loading'> | undefined, nodeUrl: string): boolean {
  if (state?.loading) return false
  const url = (state?.url || nodeUrl || BLANK).trim().toLowerCase()
  return url === BLANK
}
