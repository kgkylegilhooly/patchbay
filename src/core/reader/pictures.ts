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

/** The most pictures one document shows, and the most data it shows them with (as data: URLs). The rest are named. */
export const MAX_PICTURES_PER_DOC = 100
export const MAX_PICTURE_CHARS_PER_DOC = 64 * 1024 * 1024

/** The same picture however it's asked for: main drops a ?query, so shot.png?1 and shot.png?2 are one picture. */
export function pictureKey(href: string): string {
  const t = href.trim()
  return /^file:/i.test(t) ? t : t.replace(/\?.*$/, '')
}

/**
 * What one version of a document may still show. A picture is admitted while fewer than the limit are, and kept while
 * the data so far fits; asking again for one already admitted costs nothing.
 */
export function pictureBudget(maxPictures = MAX_PICTURES_PER_DOC, maxChars = MAX_PICTURE_CHARS_PER_DOC) {
  const admitted = new Set<string>()
  const charged = new Map<string, number>()
  let chars = 0
  return {
    admit(key: string): boolean {
      if (admitted.has(key)) return true
      if (admitted.size >= maxPictures) return false
      admitted.add(key)
      return true
    },
    charge(key: string, size: number): boolean {
      if (charged.has(key)) return true
      if (chars + size > maxChars) return false
      charged.set(key, size)
      chars += size
      return true
    }
  }
}
