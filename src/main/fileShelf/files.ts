import { isAbsolute } from 'node:path'
import { isDevicePath, isNetworkPath, isSafeToOpen, longForm, parentFolder, withoutLongPrefix, type FileState } from '../../shared/fileShelf'
import { isRunnable } from '../shellActions'

export interface FileDeps {
  /** 'file', 'folder', or null when there's nothing there. */
  kind(path: string): Promise<'file' | 'folder' | null>
  /** Resolves to an error message, or an empty string on success. */
  openPath(path: string): Promise<string>
  reveal(path: string): void
}

export type FileResult = { ok: true; revealed?: boolean } | { ok: false; reason: string }

/** How long a network path gets to answer before it's shown as not checked. A share that's down can take 20 s or more. */
export const NETWORK_CHECK_MS = 1500

function usable(path: string): string | null {
  const p = withoutLongPrefix(path)
  if (!p || !isAbsolute(p) || isDevicePath(p)) return null
  return p
}

/**
 * Opens a file with its default app, but only a document, picture or media file (isSafeToOpen): anything else, such as a
 * program, script, shortcut, installer or a Windows file that connects somewhere, is only shown in File Explorer. An
 * agent can pin any file it wrote, and a friendly icon invites a double-click. A folder opens in File Explorer.
 */
export async function openFile(path: string, deps: FileDeps): Promise<FileResult> {
  const p = usable(path)
  if (!p) return { ok: false, reason: `That isn't a full path to a file: ${path}` }
  const kind = await deps.kind(p)
  if (!kind) return { ok: false, reason: `File not found: ${p}` }
  if (kind === 'file' && (isRunnable(p) || !isSafeToOpen(p))) {
    deps.reveal(longForm(p))
    return { ok: true, revealed: true }
  }
  const error = await deps.openPath(longForm(p))
  if (!error) return { ok: true }
  // Past MAX_PATH, many apps can't take the file even with the long-path prefix.
  return { ok: false, reason: p.length >= 260 ? `This path is too long for its app to open. Use Reveal in File Explorer instead. (${error})` : error }
}

/** Shows it in File Explorer, or the nearest folder above it that's still there when it's gone. */
export async function revealFile(path: string, deps: FileDeps): Promise<FileResult> {
  const p = usable(path)
  if (!p) return { ok: false, reason: `That isn't a full path to a file: ${path}` }
  if (await deps.kind(p)) {
    deps.reveal(longForm(p))
    return { ok: true }
  }
  let folder = parentFolder(p)
  for (let i = 0; i < 64 && folder && folder !== p; i++) {
    if ((await deps.kind(folder)) === 'folder') {
      const error = await deps.openPath(folder)
      return error ? { ok: false, reason: error } : { ok: false, reason: `It's no longer there, so its folder was opened: ${folder}` }
    }
    const up = parentFolder(folder)
    if (up === folder) break
    folder = up
  }
  return { ok: false, reason: `File not found, and nor is its folder: ${p}` }
}

export interface CheckItem {
  path: string
  /** The person added it, so a network path may be looked at. */
  network?: boolean
}

/**
 * What each file is now. A network path is only looked at when the person added it, and only for a moment, so a share
 * that's down never holds anything up.
 */
export async function checkFiles(items: CheckItem[], deps: Pick<FileDeps, 'kind'>, networkMs = NETWORK_CHECK_MS): Promise<Record<string, FileState>> {
  const out: Record<string, FileState> = {}
  await Promise.all(
    items.slice(0, 5000).map(async (item) => {
      const p = usable(item.path)
      if (!p) {
        out[item.path] = 'missing'
        return
      }
      const network = isNetworkPath(p)
      if (network && !item.network) {
        out[item.path] = 'unchecked'
        return
      }
      const looked = deps.kind(p).then((k): FileState => k ?? 'missing', (): FileState => 'missing')
      out[item.path] = network
        ? await Promise.race([looked, new Promise<FileState>((r) => setTimeout(() => r('unchecked'), networkMs).unref?.())])
        : await looked
    })
  )
  return out
}
