import { lstat, readlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

/**
 * Whether following a path's links stays on this PC. realpath would open every link in the path, and a link (or
 * junction) whose target is \\host\share makes Windows connect to that host and offer the person's credentials before
 * anything could refuse it. This walks the path one part at a time with lstat and readlink only, which never follow a
 * link, and refuses as soon as one points at a network or device path. Run it before realpath.
 */

export interface LinkFs {
  lstat(path: string): Promise<{ isSymbolicLink(): boolean }>
  readlink(path: string): Promise<string>
}

const nodeLinkFs: LinkFs = { lstat: (p) => lstat(p), readlink: (p) => readlink(p) }

/** Links followed before giving up, as Windows itself does with loops. */
const MAX_LINKS = 32

/** A link target as a local path, or null when it's a network share or a device path. */
export function localTarget(target: string, linkPath: string): string | null {
  let t = target.trim()
  // \\?\C:\x is C:\x; \\?\UNC\host\share and \\.\device are not local.
  const long = /^[\\/]{2}[?.][\\/]([a-z]:(?:[\\/].*)?)$/i.exec(t)
  if (long) t = long[1]
  if (/^[\\/]{2}/.test(t)) return null
  if (/^[a-z]:/i.test(t)) return resolve(t)
  if (isAbsolute(t)) return resolve(parse(linkPath).root, t)
  return resolve(dirname(linkPath), t)
}

export type LinkCheck = { ok: true } | { ok: false; reason: string }

export async function linksStayLocal(path: string, fs: LinkFs = nodeLinkFs): Promise<LinkCheck> {
  const refused = (where: string): LinkCheck => ({ ok: false, reason: `${where} links to a network or device path, which the Reader doesn't open.` })
  let pending = resolve(path)
  if (/^[\\/]{2}/.test(pending)) return refused(path)
  let followed = 0
  // Walk from the drive root down. When a part is a link, carry on from its target with the rest of the path.
  for (;;) {
    const { root } = parse(pending)
    const parts = pending.slice(root.length).split(/[\\/]+/).filter(Boolean)
    let at = root
    let jumped = false
    for (let i = 0; i < parts.length; i++) {
      at = join(at, parts[i])
      let isLink: boolean
      try {
        isLink = (await fs.lstat(at)).isSymbolicLink()
      } catch {
        // Missing, or unreadable: nothing further is followed, and realpath will say why.
        return { ok: true }
      }
      if (!isLink) continue
      if (++followed > MAX_LINKS) return { ok: false, reason: `${path} has too many links in it.` }
      let target: string
      try {
        target = await fs.readlink(at)
      } catch {
        return { ok: true }
      }
      const local = localTarget(target, at)
      if (!local) return refused(at)
      pending = join(local, ...parts.slice(i + 1))
      jumped = true
      break
    }
    if (!jumped) return { ok: true }
  }
}
