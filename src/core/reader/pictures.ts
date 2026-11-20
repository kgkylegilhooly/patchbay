/**
 * The parts of showing pictures in the Reader that need no DOM, so they're tested on their own. The window shows local
 * pictures as <img> from data: URLs only, which main reads and checks: an SVG in an <img> runs no script and loads
 * nothing, and the page's CSP (img-src 'self' data:) is never loosened.
 */

/** Where a picture's address points: the web (never loaded), a local file (main reads it), or nowhere. */
export function imageHrefKind(href: string | null | undefined): 'remote' | 'local' | 'none' {
  const t = (href ?? '').trim()
  if (!t) return 'none'
  if (/^[a-z]:[\\/]/i.test(t) || /^file:/i.test(t)) return 'local'
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || /^\/\//.test(t)) return 'remote'
  return 'local'
}

/** Only data: URLs of pictures, as main hands them over, ever become an <img>'s source. */
export function isPictureUrl(url: unknown): url is string {
  return typeof url === 'string' && /^data:image\/(png|jpeg|gif|webp|bmp|avif|x-icon|svg\+xml)[;,]/.test(url)
}
