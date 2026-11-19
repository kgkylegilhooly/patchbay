import { isArmed } from '../../core/trigger/arming'
import { archiveRefusal } from '../../core/canvas/projectOps'
import { AGENT_PARTITION, partitionFor } from '../../shared/browserPolicy'
import { isProjectArchived, isSessionNode, type BrowserNode, type CanvasDoc } from '../../shared/model'
import type { CanvasStore } from '../../shared/contract'
import type { ArchiveOptions, ArchivePreview, ArchiveResult, ArchiveSite } from '../../shared/projects'

export interface ArchiverDeps {
  store: Pick<CanvasStore, 'get' | 'dispatch'>
  isRunning(id: string): boolean
  /** Ends a session. An agent keeps its session id, so it resumes its conversation when started again. */
  stopNode(id: string): Promise<void>
  disarmTrigger(id: string): void
  /** Bytes of saved output on disk for this node, 0 if none. */
  scrollbackBytes(id: string): number
  /** Forgets a stopped session's saved output, on disk and held by the host. */
  forgetOutput(id: string): Promise<void>
  /** Clears one site's cookies and storage in one browser store. */
  clearSite(store: 'person' | 'agent', origin: string): Promise<void>
  now?: () => number
}

const storeOf = (n: BrowserNode): 'person' | 'agent' => (partitionFor(n) === AGENT_PARTITION ? 'agent' : 'person')

/** Only web sites have site data. about:blank, file: and the like have none to clear. */
function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null
  } catch {
    return null
  }
}

/** The sites a project's pages show, each with any project that isn't archived and shows it from the same store. */
export function sitesOf(doc: CanvasDoc, projectId: string): ArchiveSite[] {
  const live = new Map(doc.projects.filter((p) => p.id !== projectId && !isProjectArchived(p)).map((p) => [p.id, p.name]))
  const sites = new Map<string, ArchiveSite>()
  for (const n of doc.nodes) {
    if (n.kind !== 'browser' || n.projectId !== projectId) continue
    const origin = originOf(n.url)
    if (!origin) continue
    const store = storeOf(n)
    const key = `${store} ${origin}`
    if (sites.has(key)) continue
    const sharedWith = [
      ...new Set(
        doc.nodes
          .filter((o): o is BrowserNode => o.kind === 'browser' && !!o.projectId && live.has(o.projectId) && storeOf(o) === store && originOf(o.url) === origin)
          .map((o) => live.get(o.projectId!)!)
      )
    ]
    sites.set(key, { origin, store, sharedWith })
  }
  return [...sites.values()]
}

/**
 * Archiving a project: stop what runs in it, then mark it. Done here, not by the page's own dispatch, so the sessions
 * are always stopped first. Nothing is deleted unless asked: agents' conversations live with their CLIs and are never
 * touched, and every node, note, whiteboard, the board and the layout stay in the canvas.
 */
export function createProjectArchiver(deps: ArchiverDeps): {
  preview(id: string): ArchivePreview
  archive(id: string, options: ArchiveOptions): Promise<ArchiveResult>
} {
  const now = deps.now ?? Date.now

  const preview = (id: string): ArchivePreview => {
    const doc = deps.store.get()
    const refusal = archiveRefusal(doc, id)
    if (refusal) return { ok: false, reason: refusal }
    const project = doc.projects.find((p) => p.id === id)!
    const nodes = doc.nodes.filter((n) => n.projectId === id)
    const sessions = nodes.filter(isSessionNode)
    return {
      ok: true,
      projectId: id,
      name: project.name,
      sessions: sessions.map((n) => ({
        id: n.id,
        title: n.title,
        kind: n.kind,
        running: deps.isRunning(n.id),
        resumable: n.kind === 'claude' && !!n.sessionId
      })),
      browsers: nodes.filter((n): n is BrowserNode => n.kind === 'browser').map((n) => ({ id: n.id, title: n.title, url: n.url })),
      triggers: nodes.flatMap((n) => (n.kind === 'trigger' && isArmed(n) ? [{ id: n.id, title: n.title }] : [])),
      kept: {
        notes: nodes.filter((n) => n.kind === 'sticky').length,
        whiteboards: nodes.filter((n) => n.kind === 'whiteboard').length,
        groups: nodes.filter((n) => n.kind === 'group').length,
        board: project.board !== undefined
      },
      scrollbackBytes: sessions.reduce((sum, n) => sum + deps.scrollbackBytes(n.id), 0),
      sites: sitesOf(doc, id)
    }
  }

  const archive = async (id: string, options: ArchiveOptions): Promise<ArchiveResult> => {
    const before = preview(id)
    if (!before.ok) return before
    const sessions = deps.store.get().nodes.filter((n) => n.projectId === id && isSessionNode(n))
    // Disarmed first, so none fires into a session as it stops.
    for (const t of before.triggers) deps.disarmTrigger(t.id)
    const running = sessions.filter((n) => deps.isRunning(n.id))
    await Promise.all(running.map((n) => deps.stopNode(n.id).catch(() => {})))
    const stillRunning = running.filter((n) => deps.isRunning(n.id))
    deps.store.dispatch({ op: 'archiveProject', id, at: now() })
    // Checked again rather than assumed: the reducer refuses an archive that would leave nothing to show.
    if (!isProjectArchived(deps.store.get().projects.find((p) => p.id === id))) {
      return {
        ok: false,
        reason: 'The project could not be archived. Its sessions were stopped; start them again from its tab.'
      }
    }

    let freedBytes = 0
    const clearedSites: string[] = []
    const keptSites: string[] = []
    const problems: string[] = []
    if (options.clearScrollback) {
      for (const n of sessions) {
        // A session that didn't stop is still writing, so its output stays.
        if (deps.isRunning(n.id)) continue
        const bytes = deps.scrollbackBytes(n.id)
        try {
          await deps.forgetOutput(n.id)
          freedBytes += bytes
        } catch (e) {
          problems.push(`Could not clear the saved output of ${n.title}: ${(e as Error).message}`)
        }
      }
    }
    if (options.clearSites) {
      // Worked out again now: another project may have opened the same site since the preview.
      for (const site of sitesOf(deps.store.get(), id)) {
        if (site.sharedWith.length) {
          keptSites.push(site.origin)
          continue
        }
        try {
          await deps.clearSite(site.store, site.origin)
          clearedSites.push(site.origin)
        } catch (e) {
          problems.push(`Could not clear site data for ${site.origin}: ${(e as Error).message}`)
        }
      }
    }
    return {
      ok: true,
      stopped: running.length - stillRunning.length,
      stillRunning: stillRunning.map((n) => n.title),
      freedBytes,
      clearedSites,
      keptSites,
      ...(problems.length ? { problem: problems.join(' ') } : {})
    }
  }

  return { preview, archive }
}
