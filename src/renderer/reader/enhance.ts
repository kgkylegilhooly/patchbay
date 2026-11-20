import { isPictureUrl } from '../../core/reader/pictures'
import type { ImageResult } from '../../shared/reader'
import { drawDiagram, type DiagramTheme } from './diagrams'
import { docsBridge } from './readerBridge'

/**
 * What the sanitized HTML of a section can't hold: Mermaid diagrams drawn from their code blocks, and local pictures
 * read through main. Both go in as <img> from data: URLs after the document's HTML was cleaned, and both leave the
 * text the page anchors comments to (a diagram's source, a picture's alt text) in place.
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

function headOf(block: HTMLElement): HTMLElement | null {
  return block.querySelector<HTMLElement>(':scope > .code-head')
}

function resetDiagram(block: HTMLElement): void {
  block.querySelectorAll(':scope > .reader-mermaid, :scope > .reader-mermaid-error').forEach((e) => e.remove())
  headOf(block)?.querySelector('.reader-mermaid-toggle')?.remove()
  block.classList.remove('reader-mermaid-drawn', 'reader-mermaid-failed', 'reader-mermaid-source')
}

function enhanceDiagrams(root: HTMLElement, theme: DiagramTheme, live: () => boolean): void {
  for (const block of root.querySelectorAll<HTMLElement>('.code-block.code-mermaid')) {
    if (block.dataset.drawn === theme) continue
    block.dataset.theme = theme
    const source = block.querySelector('pre')?.textContent ?? ''
    void drawDiagram(source, theme).then((r) => {
      if (!live() || !block.isConnected || block.dataset.theme !== theme) return
      resetDiagram(block)
      block.dataset.drawn = theme
      const head = headOf(block)
      if (!r.ok) {
        // The source stays, with why it isn't drawn.
        const why = document.createElement('p')
        why.className = 'reader-mermaid-error'
        why.dataset.readerUi = ''
        why.textContent = `Couldn't draw this diagram: ${r.reason}`
        head?.after(why)
        block.classList.add('reader-mermaid-failed')
        return
      }
      const figure = document.createElement('div')
      figure.className = 'reader-mermaid'
      const img = document.createElement('img')
      img.alt = 'Mermaid diagram'
      img.src = r.url
      img.width = r.width
      img.height = r.height
      img.draggable = false
      figure.append(img)
      head?.after(figure)
      block.classList.add('reader-mermaid-drawn')
      // Show the source instead, and back.
      const toggle = document.createElement('span')
      toggle.className = 'reader-mermaid-toggle'
      toggle.setAttribute('role', 'button')
      toggle.tabIndex = 0
      toggle.textContent = 'Source'
      const flip = (e: Event): void => {
        e.stopPropagation()
        const showing = block.classList.toggle('reader-mermaid-source')
        toggle.textContent = showing ? 'Diagram' : 'Source'
      }
      toggle.addEventListener('click', flip)
      toggle.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') flip(e)
      })
      head?.querySelector('.code-copy')?.before(toggle)
    })
  }
}

/** Fills in a section's diagrams and pictures. The returned function stops any still on their way. */
export function enhanceBlocks(root: HTMLElement, o: { nodeId: string; version: number; theme: DiagramTheme }): () => void {
  let on = true
  const live = (): boolean => on
  enhanceDiagrams(root, o.theme, live)
  enhancePictures(root, o.nodeId, o.version, live)
  return () => {
    on = false
  }
}
