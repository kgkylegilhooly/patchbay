import { execFile } from 'node:child_process'
import type { WebContents } from 'electron'
import type { BrowserAttempt, EvidenceViewport } from '../../shared/browserEvidence'

export async function observeRevision(cwd?: string): Promise<BrowserAttempt['revision']> {
  if (!cwd) return null
  const git = (args: string[]): Promise<string> => new Promise((resolve, reject) => execFile('git', args, { cwd, windowsHide: true, timeout: 3000, maxBuffer: 256 * 1024 }, (err, stdout) => err ? reject(err) : resolve(stdout.trim())))
  try {
    const [commit, status] = await Promise.all([git(['rev-parse', 'HEAD']), git(['status', '--porcelain'])])
    return /^[a-f0-9]{40,64}$/.test(commit) ? { commit, dirty: !!status } : null
  } catch { return null }
}

export async function observedViewport(guest: WebContents): Promise<EvidenceViewport> {
  const value = await guest.executeJavaScriptInIsolatedWorld(999, [{ code: '({width: innerWidth, height: innerHeight})' }])
  return { width: Number(value.width), height: Number(value.height) }
}

/** Browser-inserted CSS also covers new fields while the capture is pending. Never read field values. */
export async function privateScreenshot<T>(guest: WebContents, capture: () => Promise<T>): Promise<T> {
  const css = await guest.insertCSS('input, textarea, select, [contenteditable], iframe, frame, embed, object { visibility: hidden !important; }', { cssOrigin: 'user' })
  try { return await capture() } finally { if (!guest.isDestroyed()) await guest.removeInsertedCSS(css).catch(() => {}) }
}
