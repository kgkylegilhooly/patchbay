/**
 * Between the rendered page and comment quotes: what a selection or block reads as, and where a quote is on the page.
 * Matching ignores whitespace, as anchoring does (see core/reader/anchor.ts), because the page and the Markdown space
 * blocks differently.
 */

/** Parts of the page that aren't the document's words: code block headers, and the reader's own controls. */
const NOT_TEXT = '.code-head, [data-reader-ui]'

function skipped(node: Node): boolean {
  const el = node.parentElement
  return !!el?.closest(NOT_TEXT)
}

function textNodes(root: Node): Text[] {
  const out: Text[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!skipped(n)) out.push(n as Text)
  return out
}

/** An element's words as the page shows them, without code block headers or the reader's buttons. */
export function visibleText(el: Element): string {
  return textNodes(el)
    .map((t) => t.data)
    .join('')
}

/** What a selection covers, read the same way. */
export function rangeText(range: Range): string {
  const box = document.createElement('div')
  box.append(range.cloneContents())
  box.querySelectorAll(NOT_TEXT).forEach((e) => e.remove())
  // Blocks joined with no space read as one word to a person, but matching ignores spaces anyway.
  return box.textContent ?? ''
}

/** Where a quote is inside an element, as a DOM range, or null when it isn't there. */
export function findQuote(root: Element, quote: string): Range | null {
  const want = quote.replace(/\s+/g, '')
  if (!want) return null
  const places: { node: Text; offset: number }[] = []
  let key = ''
  for (const node of textNodes(root)) {
    const data = node.data
    for (let i = 0; i < data.length; i++) {
      if (/\s/.test(data[i])) continue
      key += data[i]
      places.push({ node, offset: i })
    }
  }
  const at = key.indexOf(want)
  if (at < 0) return null
  const start = places[at]
  const end = places[at + want.length - 1]
  const range = document.createRange()
  range.setStart(start.node, start.offset)
  range.setEnd(end.node, end.offset + 1)
  return range
}

/** The section element a node is in. */
export function sectionOf(node: Node | null): HTMLElement | null {
  const el = node instanceof Element ? node : node?.parentElement
  return (el?.closest('[data-section]') as HTMLElement | null) ?? null
}

type Highlights = { set(name: string, h: unknown): void; delete(name: string): void }
type HighlightCtor = new (...ranges: Range[]) => unknown

/**
 * Marks comment quotes with the CSS Custom Highlight API, which colors text without changing the page, so rendering,
 * selection and copying are untouched. Each reader adds its own ranges; the highlight is all of them.
 */
const marked = new Map<string, { quotes: Range[]; focus: Range[] }>()

function redraw(): void {
  const css = (globalThis as { CSS?: { highlights?: Highlights } }).CSS
  const Highlight = (globalThis as { Highlight?: HighlightCtor }).Highlight
  if (!css?.highlights || !Highlight) return
  const all = [...marked.values()]
  css.highlights.set('reader-comment', new Highlight(...all.flatMap((m) => m.quotes)))
  css.highlights.set('reader-comment-focus', new Highlight(...all.flatMap((m) => m.focus)))
}

export function setHighlights(readerId: string, quotes: Range[], focus: Range[] = []): void {
  if (!quotes.length && !focus.length) marked.delete(readerId)
  else marked.set(readerId, { quotes, focus })
  redraw()
}
