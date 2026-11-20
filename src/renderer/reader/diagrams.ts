import DOMPurify from 'dompurify'
import { diagramError, MAX_DIAGRAM_CHARS, scrubCss, svgDataUrl, svgSize } from '../../core/reader/pictures'

/**
 * Mermaid diagrams in the Reader. Mermaid is bundled (loaded on first use, no network) and runs with its strict
 * security level: no scripts, no click handlers, labels sanitized. Its SVG is then sanitized again here and shown as
 * an <img> from a data: URL, where an SVG can run nothing and load nothing.
 */

export type DiagramTheme = 'dark' | 'light'
export type Drawn = { ok: true; url: string; width: number; height: number } | { ok: false; reason: string }

type Mermaid = typeof import('mermaid').default
let loading: Promise<Mermaid> | null = null
const load = (): Promise<Mermaid> => (loading ??= import('mermaid').then((m) => m.default))

const FONT = '"Segoe UI", system-ui, -apple-system, Arial, sans-serif'

function config(theme: DiagramTheme): Parameters<Mermaid['initialize']>[0] {
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    fontFamily: FONT,
    maxTextSize: MAX_DIAGRAM_CHARS,
    maxEdges: 800,
    suppressErrorRendering: true,
    // Labels as SVG text, not HTML inside foreignObject: they draw the same inside an <img>, and no HTML is kept.
    htmlLabels: false,
    // Diagrams could otherwise load icon packs or fonts from the web.
    legacyMathML: false,
    themeVariables: { fontFamily: FONT }
  }
}

/** Its own instance, so no setting or hook of the document sanitizer (or Mermaid's) touches this one. */
let purifier: ReturnType<typeof DOMPurify> | null = null

/** The tags a diagram may never keep. */
const FORBID = ['foreignObject', 'script', 'iframe', 'object', 'embed', 'image', 'img', 'a', 'use', 'link', 'meta', 'base', 'form', 'input', 'button', 'textarea', 'video', 'audio', 'animate', 'set', 'animateMotion', 'animateTransform']

/**
 * Mermaid's SVG made safe and self-contained: no scripts, events, links, external references or animations; CSS
 * scrubbed of anything that reaches out; sized from its viewBox. Null when what's left isn't an SVG.
 */
export function cleanSvg(svg: string): { svg: string; width: number; height: number } | null {
  purifier ??= DOMPurify(window)
  const fragment = purifier.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: FORBID,
    FORBID_ATTR: ['href', 'xlink:href', 'src', 'srcset', 'action', 'formaction', 'onload', 'onerror'],
    ALLOW_DATA_ATTR: false,
    RETURN_DOM_FRAGMENT: true
  })
  const root = fragment.querySelector('svg')
  if (!root) return null
  for (const style of root.querySelectorAll('style')) style.textContent = scrubCss(style.textContent ?? '')
  for (const el of [root, ...root.querySelectorAll('[style]')]) {
    const css = el.getAttribute('style')
    if (css !== null) el.setAttribute('style', scrubCss(css))
  }
  // Any attribute still pointing outside the picture, as fill="url(http://…)".
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const a of [...el.attributes]) {
      if (/url\(\s*['"]?\s*(?!#)/i.test(a.value) || /^\s*(javascript|data|https?):/i.test(a.value)) el.removeAttribute(a.name)
    }
  }
  const size = svgSize(root.getAttribute('viewBox'))
  if (!size) return null
  root.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  root.setAttribute('width', String(size.width))
  root.setAttribute('height', String(size.height))
  root.removeAttribute('style')
  return { svg: new XMLSerializer().serializeToString(root), ...size }
}

// Mermaid keeps one global configuration, so one diagram is drawn at a time, each with its theme.
let queue: Promise<unknown> = Promise.resolve()
const cache = new Map<string, Promise<Drawn>>()
let count = 0

async function draw(source: string, theme: DiagramTheme): Promise<Drawn> {
  if (source.length > MAX_DIAGRAM_CHARS) return { ok: false, reason: `The diagram is over ${MAX_DIAGRAM_CHARS.toLocaleString()} characters, so it isn't drawn.` }
  let mermaid: Mermaid
  try {
    mermaid = await load()
  } catch (e) {
    return { ok: false, reason: `Diagrams can't be drawn: ${diagramError(e)}` }
  }
  const id = `reader-mermaid-${++count}`
  try {
    mermaid.initialize(config(theme))
    await mermaid.parse(source)
    const { svg } = await mermaid.render(id, source)
    const clean = cleanSvg(svg)
    if (!clean) return { ok: false, reason: 'The diagram came out empty.' }
    return { ok: true, url: svgDataUrl(clean.svg), width: clean.width, height: clean.height }
  } catch (e) {
    return { ok: false, reason: diagramError(e) }
  } finally {
    // What Mermaid measures with, left behind when a diagram fails.
    for (const left of document.querySelectorAll(`#${id}, #d${id}, #i${id}`)) left.remove()
  }
}

/** A diagram's picture, drawn once per source and theme. */
export function drawDiagram(source: string, theme: DiagramTheme): Promise<Drawn> {
  const key = `${theme}\n${source}`
  const known = cache.get(key)
  if (known) return known
  const next = queue.then(() => draw(source, theme))
  queue = next.catch(() => undefined)
  cache.set(key, next)
  // A long document may have many; keep the newest.
  if (cache.size > 60) cache.delete(cache.keys().next().value as string)
  return next
}
