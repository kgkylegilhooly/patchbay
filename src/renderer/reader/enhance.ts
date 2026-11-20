import { isPictureUrl } from '../../core/reader/pictures'
import type { ImageResult } from '../../shared/reader'
import { docsBridge } from './readerBridge'

/**
 * What the sanitized HTML of a section can't hold: local pictures, read through main. They go in as <img> from data:
 * URLs after the document's HTML was cleaned, and leave the alt text, which comments anchor to, in place.
 */

const pictures = new Map<string, Promise<ImageResult>>()

/** A picture read once per reader, document version and address. */
function picture(nodeId: string, version: number, href: string): Promise<ImageResult> {
  const key = `${nodeId}\n${version}\n${href}`
  let p = pictures.get(key)
  if (!p) {
    p = docsBridge()
      .image(nodeId, href)
      .catch((e: unknown) => ({ ok: false as const, reason: (e as Error).message }))
    pictures.set(key, p)
    if (pictures.size > 80) pictures.delete(pictures.keys().next().value as string)
  }
  return p
}

function showPicture(span: HTMLElement, r: ImageResult): void {
  span.classList.remove('reader-img-loading')
  if (!r.ok || !isPictureUrl(r.url)) {
    span.classList.add('reader-img-failed')
    span.title = r.ok ? 'This picture could not be shown.' : r.reason
    return
  }
  const alt = span.dataset.alt ?? ''
  const img = document.createElement('img')
  img.className = 'reader-pic'
  img.alt = alt
  img.src = r.url
  img.decoding = 'async'
  img.draggable = false
  // The alt text stays in the page, out of sight, so comments quoting it still find it.
  const words = document.createElement('span')
  words.className = 'reader-img-alt'
  words.textContent = alt
  span.replaceChildren(img, words)
  span.classList.add('reader-img-shown')
  span.title = r.path
}

function enhancePictures(root: HTMLElement, nodeId: string, version: number, live: () => boolean): void {
  for (const span of root.querySelectorAll<HTMLElement>('span.reader-img-local')) {
    // Done already. One still on its way from an earlier pass is asked for again, and the cache answers.
    if (span.classList.contains('reader-img-shown') || span.classList.contains('reader-img-failed')) continue
    span.dataset.href ??= span.getAttribute('title') ?? ''
    span.dataset.alt ??= (span.textContent ?? '').replace(/^Image:?\s*/, '')
    const href = span.dataset.href
    span.classList.add('reader-img-loading')
    void picture(nodeId, version, href).then((r) => {
      if (live() && span.isConnected) showPicture(span, r)
    })
  }
}

/** Fills in a section's pictures. The returned function stops any still on their way. */
export function enhanceBlocks(root: HTMLElement, o: { nodeId: string; version: number }): () => void {
  let on = true
  const live = (): boolean => on
  enhancePictures(root, o.nodeId, o.version, live)
  return () => {
    on = false
  }
}
