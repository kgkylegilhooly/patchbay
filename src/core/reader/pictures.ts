/**
 * The parts of showing pictures and diagrams in the Reader that need no DOM, so they're tested on their own. The
 * window draws Mermaid diagrams as SVG and shows them, and local pictures, as <img> from data: URLs only: an SVG in an
 * <img> runs no script and loads nothing, and the page's CSP (img-src 'self' data:) is never loosened.
 */

/** Where a picture's address points: the web (never loaded), a local file (main reads it), or nowhere. */
export function imageHrefKind(href: string | null | undefined): 'remote' | 'local' | 'none' {
  const t = (href ?? '').trim()
  if (!t) return 'none'
  if (/^[a-z]:[\\/]/i.test(t) || /^file:/i.test(t)) return 'local'
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || /^\/\//.test(t)) return 'remote'
  return 'local'
}

/** The longest diagram source drawn. Past this it's shown as source, like a diagram that doesn't parse. */
export const MAX_DIAGRAM_CHARS = 20000

/**
 * CSS from a diagram's own <style> or style attributes, without anything that could reach outside the picture:
 * @import rules, url() other than to the picture's own #parts, and old expression() and behavior forms. The picture
 * is shown in an <img>, where none of these would load anyway; this is the second lock.
 */
export function scrubCss(css: string): string {
  return css
    // Escapes undone first, so u\72l( is seen as the url( it is.
    .replace(/\\([0-9a-f]{1,6})\s?/gi, (_m, hex: string) => {
      const code = parseInt(hex, 16)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''
    })
    .replace(/\\/g, '')
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)\s*(?!#)[^)]*\)/gi, 'none')
    .replace(/expression\s*\(/gi, '(')
    .replace(/(behavior|-moz-binding)\s*:/gi, 'x-blocked:')
    .replace(/javascript\s*:/gi, '')
}

/** A size for the picture from its viewBox, in CSS pixels, for an <img> that would otherwise guess. */
export function svgSize(viewBox: string | null, cap = 4000): { width: number; height: number } | null {
  const parts = (viewBox ?? '').trim().split(/[\s,]+/).map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null
  const [, , w, h] = parts
  if (w <= 0 || h <= 0) return null
  const scale = Math.min(1, cap / Math.max(w, h))
  return { width: Math.round(w * scale), height: Math.round(h * scale) }
}

/** An SVG document as a data: URL for an <img>. */
export function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
}

/** Only data: URLs of pictures, as main hands them over, ever become an <img>'s source. */
export function isPictureUrl(url: unknown): url is string {
  return typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp|bmp|avif|x-icon|svg\+xml)[;,]/.test(url)
}

/** A Mermaid error as one or two short lines: its own message without the parser's stack. */
export function diagramError(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : (e as { message?: unknown })?.message
  const text = typeof raw === 'string' && raw.trim() ? raw : 'The diagram could not be read.'
  const lines = text.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim())
  return lines.slice(0, 4).join('\n').slice(0, 400)
}
