import type { WebContents } from 'electron'
import type { EvidenceViewport } from '../../shared/browserEvidence'

export async function observedViewport(guest: WebContents): Promise<EvidenceViewport> {
  const value = await guest.executeJavaScriptInIsolatedWorld(999, [{ code: '({width: innerWidth, height: innerHeight})' }])
  return { width: Number(value.width), height: Number(value.height) }
}

/**
 * What an evidence picture hides: what's typed in fields, and frames, which can show another site signed in. Fields keep
 * their place and get a dashed outline, so the layout still reads. Fields inside a web component's shadow root aren't
 * reached by page-wide CSS, so they show.
 */
export const PRIVACY_CSS = [
  'input, textarea, select, [contenteditable] { color: transparent !important; -webkit-text-fill-color: transparent !important;',
  '  text-shadow: none !important; caret-color: transparent !important; outline: 2px dashed #8a94a6 !important; outline-offset: -2px !important; }',
  'input::placeholder, textarea::placeholder { color: transparent !important; -webkit-text-fill-color: transparent !important; }',
  'iframe, frame, embed, object { visibility: hidden !important; }'
].join('\n')

/** Browser-inserted CSS also covers new fields while the capture is pending. Never reads field values. */
export async function privateScreenshot<T>(guest: WebContents, capture: () => Promise<T>): Promise<T> {
  const css = await guest.insertCSS(PRIVACY_CSS, { cssOrigin: 'user' })
  try {
    return await capture()
  } finally {
    if (!guest.isDestroyed()) await guest.removeInsertedCSS(css).catch(() => {})
  }
}
