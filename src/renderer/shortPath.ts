/**
 * A folder path short enough for a card or a row, keeping the end, which is the part that tells folders apart.
 * Inside `root` it is the path from there (the root itself is its own folder name). Elsewhere it is the last two
 * folders after "…". Short paths come back as they are. Show the full path in a tooltip beside it.
 */
export function shortPath(full: string, root?: string | null): string {
  if (!full) return full
  const sep = full.includes('\\') ? '\\' : '/'
  const parts = (p: string): string[] => p.split(/[\\/]+/).filter(Boolean)
  const segs = parts(full)
  if (root) {
    const base = parts(root)
    // Windows paths and drive letters don't care about case, and a repo folder on Windows is the common case here.
    const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
    if (base.length && base.length <= segs.length && base.every((b, i) => same(b, segs[i]))) {
      const rest = segs.slice(base.length)
      return rest.length ? rest.join(sep) : base[base.length - 1]
    }
  }
  if (segs.length <= 3) return full
  return `…${sep}${segs.slice(-2).join(sep)}`
}
