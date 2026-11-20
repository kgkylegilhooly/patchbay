import { isPictureUrl, pictureBudget, pictureKey } from '../../core/reader/pictures'
import type { ImageResult } from '../../shared/reader'
import { docsBridge } from './readerBridge'

/**
 * What the sanitized HTML of a section can't hold: local pictures, read through main. They go in as <img> from data:
 * URLs after the document's HTML was cleaned, and leave the alt text, which comments anchor to, in place. Each version
 * of a document shows at most MAX_PICTURES_PER_DOC of them, in MAX_PICTURE_CHARS_PER_DOC of data.
 */

/** Pictures read, kept while they fit: the newest are kept. */
const CACHE_CHARS = 128 * 1024 * 1024
const cache = new Map<string, { result: Promise<ImageResult>; chars: number }>()
let cached = 0

function remember(key: string, result: Promise<ImageResult>): void {
  const entry = { result, chars: 0 }
  cache.set(key, entry)
  void result.then((r) => {
    if (cache.get(key) !== entry) return
    entry.chars = r.ok ? r.url.length : 0
    cached += entry.chars
    for (const [k, e] of cache) {
      if (cached <= CACHE_CHARS || cache.size <= 1) break
      cache.delete(k)
      cached -= e.chars
    }
  })
}

/** A picture read once per reader, document version and file. */
function picture(nodeId: string, version: number, href: string): Promise<ImageResult> {
  const key = `${nodeId}\n${version}\n${pictureKey(href)}`
  const known = cache.get(key)
  if (known) return known.result
  const result = docsBridge()
    .image(nodeId, href)
    .catch((e: unknown) => ({ ok: false as const, reason: (e as Error).message }))
  remember(key, result)
  return result
}

const budgets = new Map<string, { version: number; budget: ReturnType<typeof pictureBudget> }>()

/** What this version of the reader's document may still show. A new version starts again. */
function budgetOf(nodeId: string, version: number): ReturnType<typeof pictureBudget> {
  const b = budgets.get(nodeId)
  if (b?.version === version) return b.budget
  const fresh = { version, budget: pictureBudget() }
  budgets.set(nodeId, fresh)
  return fresh.budget
}

function refuse(span: HTMLElement, reason: string): void {
  span.classList.remove('reader-img-loading')
  span.classList.add('reader-img-failed')
  span.title = reason
}

function showPicture(span: HTMLElement, r: ImageResult): void {
  span.classList.remove('reader-img-loading')
  if (!r.ok || !isPictureUrl(r.url)) return refuse(span, r.ok ? 'This picture could not be shown.' : r.reason)
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
  const budget = budgetOf(nodeId, version)
  for (const span of root.querySelectorAll<HTMLElement>('span.reader-img-local')) {
    // Done already. One still on its way from an earlier pass is asked for again, and the cache answers.
    if (span.classList.contains('reader-img-shown') || span.classList.contains('reader-img-failed')) continue
    span.dataset.href ??= span.getAttribute('title') ?? ''
    span.dataset.alt ??= (span.textContent ?? '').replace(/^Image:?\s*/, '')
    const href = span.dataset.href
    const key = pictureKey(href)
    if (!budget.admit(key)) {
      refuse(span, 'This document already shows as many pictures as a reader shows.')
      continue
    }
    span.classList.add('reader-img-loading')
    void picture(nodeId, version, href).then((r) => {
      if (!live() || !span.isConnected) return
      if (r.ok && !budget.charge(key, r.url.length)) return refuse(span, 'The pictures in this document are too large to show together.')
      showPicture(span, r)
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
