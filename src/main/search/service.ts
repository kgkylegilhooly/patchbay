import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { Worker } from 'node:worker_threads'
import { MAX_HANDOFF_CHARS } from '../../core/search/handoffText'
import { searchSources } from '../../core/search/sources'
import type { HandoffSection, HandoffSource, SourceSpec } from '../../core/search/types'
import type { CanvasStore, NodeMessage } from '../../shared/contract'
import type { AgentStatus, CanvasNode, ClaudeNode } from '../../shared/model'
import type { SearchBridge, StartHandoff } from '../../shared/searchBridge'
import { spotNear } from '../control/verbs'
import type { EngineRequest } from './engine'

/** Plain documents for search from elsewhere in Patchbay, such as task results. Called on every sync, so keep it cheap. */
export type SearchSourceProvider = () => SourceSpec[]
/** Extra handoff sections for a source, such as a task's recorded outcome and checks. */
export type HandoffEvidenceProvider = (source: HandoffSource, at: { cwd: string; projectId?: string }) => HandoffSection[] | Promise<HandoffSection[]>

const providers: SearchSourceProvider[] = []
const evidence: HandoffEvidenceProvider[] = []

/** Adds documents to search. The extension point for task results; it needs nothing from the task model itself. */
export function registerSearchSource(provider: SearchSourceProvider): () => void {
  providers.push(provider)
  return () => void providers.splice(providers.indexOf(provider), 1)
}

/** Adds sections to every handoff, shown and edited like the built-in ones. */
export function registerHandoffEvidence(provider: HandoffEvidenceProvider): () => void {
  evidence.push(provider)
  return () => void evidence.splice(evidence.indexOf(provider), 1)
}

/** Runs one request in the engine, wherever it lives. */
export type Backend = (request: EngineRequest) => Promise<unknown>

/**
 * The engine in a worker thread, started on first use and again after it fails. It never runs on the main thread: if
 * the worker can't start, search says it's unavailable and why, and the next request tries a new worker.
 */
export function workerBackend(script: string, indexFile: string, log: (line: string) => void): Backend {
  let worker: Worker | null = null
  /** A worker has answered once, so its script loads, and a failure after that is a crash rather than a missing file. */
  let worked = false
  let next = 1
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  const fail = (e: Error): void => {
    worker = null
    const why = worked ? e : new Error(`the search worker couldn't start (${e.message})`)
    for (const p of pending.values()) p.reject(why)
    pending.clear()
  }
  const start = (): Worker => {
    if (worker) return worker
    const w = new Worker(script, { workerData: { indexFile } })
    w.unref()
    w.on('message', (m: { id: number; ok: boolean; value?: unknown; error?: string }) => {
      worked = true
      const p = pending.get(m.id)
      pending.delete(m.id)
      if (m.ok) p?.resolve(m.value)
      else p?.reject(new Error(m.error ?? 'Search failed.'))
    })
    w.on('error', (e) => {
      log(`The search worker failed: ${e.message}`)
      if (worker === w) fail(e)
    })
    w.on('exit', (code) => {
      if (worker === w) fail(new Error(`the search worker stopped (code ${code})`))
    })
    worker = w
    return w
  }
  return (request) =>
    new Promise((resolve, reject) => {
      let w: Worker
      try {
        w = start()
      } catch (e) {
        log(`The search worker couldn't start: ${(e as Error).message}`)
        reject(new Error(`the search worker couldn't start (${(e as Error).message})`))
        return
      }
      const id = next++
      pending.set(id, { resolve, reject })
      w.postMessage({ id, request })
    })
}

export interface SearchServiceDeps {
  store: CanvasStore
  messages: () => NodeMessage[]
  status: (id: string) => AgentStatus | undefined
  /** The repository holding a folder, and its uncommitted files relative to it. */
  gitChanges: (folder: string) => Promise<{ root: string; changed: string[] } | { unavailable: string }>
  startNode: (id: string) => Promise<void>
  backend: Backend
  now?: () => number
}

/** How long after the canvas changes the index catches up, and how often it looks at growing transcripts anyway. */
const SYNC_AFTER_CHANGE_MS = 3000
const SYNC_EVERY_MS = 60_000

const failure = (e: unknown): { ok: false; reason: string } => ({ ok: false, reason: `Search is unavailable: ${e instanceof Error ? e.message : String(e)}` })

export function createSearchService(d: SearchServiceDeps): SearchBridge & { start(): void; stop(): Promise<void> } {
  const now = d.now ?? Date.now
  const input = (): ReturnType<typeof searchSources> => {
    const extra: SourceSpec[] = []
    for (const p of providers) {
      try {
        extra.push(...p())
      } catch (e) {
        console.error('Patchbay: a search source failed:', e)
      }
    }
    return searchSources(d.store.get(), d.messages(), now(), extra)
  }
  let changeTimer: ReturnType<typeof setTimeout> | null = null
  let everyTimer: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  const syncSoon = (): void => {
    if (changeTimer) return
    changeTimer = setTimeout(() => {
      changeTimer = null
      void d.backend({ type: 'sync', input: input() }).catch(() => {})
    }, SYNC_AFTER_CHANGE_MS)
    changeTimer.unref?.()
  }

  const find = (id: string): CanvasNode | undefined => d.store.get().nodes.find((n) => n.id === id)

  return {
    start() {
      // Panning changes the doc too. Only what search reads is worth a sync.
      let seen = d.store.get()
      unsubscribe = d.store.subscribe((doc) => {
        if (doc.nodes === seen.nodes && doc.closed === seen.closed && doc.projects === seen.projects) return
        seen = doc
        syncSoon()
      })
      everyTimer = setInterval(() => void d.backend({ type: 'sync', input: input() }).catch(() => {}), SYNC_EVERY_MS)
      everyTimer.unref?.()
      syncSoon()
    },
    async stop() {
      unsubscribe?.()
      if (changeTimer) clearTimeout(changeTimer)
      if (everyTimer) clearInterval(everyTimer)
      await d.backend({ type: 'flush' }).catch(() => {})
    },

    async search(query) {
      try {
        return { ok: true, result: (await d.backend({ type: 'search', input: input(), query })) as never }
      } catch (e) {
        return failure(e)
      }
    },
    async stats() {
      try {
        return { ok: true, stats: (await d.backend({ type: 'stats' })) as never }
      } catch (e) {
        return failure(e)
      }
    },
    async readSource(key, from, count, focus) {
      try {
        const window = await d.backend({ type: 'source', key: String(key), from: Number(from), count: Number(count), focus: Number(focus) })
        return window ? { ok: true, window: window as never } : { ok: false, reason: "This isn't in the search index any more. Search again to find it." }
      } catch (e) {
        return failure(e)
      }
    },
    async rebuild() {
      try {
        return { ok: true, stats: (await d.backend({ type: 'rebuild', input: input() })) as never }
      } catch (e) {
        return failure(e)
      }
    },

    async prepareHandoff(source) {
      const doc = d.store.get()
      let from: { title: string; agent: ClaudeNode['agent']; cwd: string; projectId?: string; transcriptPath: string | null; busy: boolean } | null = null
      if (source?.type === 'node') {
        const node = find(source.nodeId)
        if (node?.kind === 'claude') from = { title: node.title, agent: node.agent, cwd: node.cwd, projectId: node.projectId, transcriptPath: node.transcriptPath, busy: d.status(node.id) === 'working' || d.status(node.id) === 'needs-you' }
      } else if (source?.type === 'closed') {
        const c = doc.closed.find((e) => e.id === source.closedId)
        if (c) from = { title: c.title, agent: c.agent, cwd: c.cwd, projectId: c.projectId, transcriptPath: c.transcriptPath, busy: false }
      }
      if (!from) return { ok: false, reason: 'That conversation is no longer on the canvas or in the closed history.' }
      try {
        const git = await d.gitChanges(from.cwd).catch((e: unknown) => ({ unavailable: (e as Error).message }))
        const extra: HandoffSection[] = []
        for (const p of evidence) {
          try {
            extra.push(...(await p(source, { cwd: from.cwd, ...(from.projectId ? { projectId: from.projectId } : {}) })))
          } catch (e) {
            console.error('Patchbay: handoff evidence failed:', e)
          }
        }
        const projectName = doc.projects.find((p) => p.id === from.projectId)?.name
        const draft = await d.backend({
          type: 'handoff',
          input: {
            title: from.title,
            agent: from.agent ?? 'claude',
            cwd: from.cwd,
            transcriptPath: from.transcriptPath,
            sourceBusy: from.busy,
            git,
            ...(from.projectId ? { projectId: from.projectId } : {}),
            ...(projectName ? { projectName } : {}),
            ...(extra.length ? { extra } : {})
          }
        })
        return { ok: true, draft: draft as never }
      } catch (e) {
        return failure(e)
      }
    },

    async startHandoff(a: StartHandoff) {
      if (!a || typeof a.text !== 'string' || !a.text.trim()) return { ok: false, reason: 'The handoff is empty.' }
      if (a.text.length > MAX_HANDOFF_CHARS) return { ok: false, reason: `The handoff is ${a.text.length} characters, over the ${MAX_HANDOFF_CHARS} an agent can be started with. Shorten it first.` }
      if (a.agent !== 'claude' && a.agent !== 'codex') return { ok: false, reason: 'Choose Claude Code or Codex.' }
      const cwd = typeof a.cwd === 'string' && a.cwd.trim() ? a.cwd.trim() : homedir()
      let isFolder = false
      try {
        isFolder = existsSync(cwd) && statSync(cwd).isDirectory()
      } catch {
        isFolder = false
      }
      if (!isFolder) return { ok: false, reason: `The folder ${cwd} doesn't exist.` }
      const doc = d.store.get()
      const projectId = doc.projects.some((p) => p.id === a.projectId) ? a.projectId! : doc.activeProjectId
      const size = { width: 620, height: 420 }
      const beside = a.besideNodeId ? find(a.besideNodeId) : undefined
      let at: { x: number; y: number }
      if (beside && beside.projectId === projectId) at = spotNear(doc, beside, size)
      else {
        const top = doc.nodes.filter((n) => n.projectId === projectId && !n.parentId)
        at = { x: top.length ? Math.max(...top.map((n) => n.x + n.width)) + 40 : 0, y: top.length ? Math.min(...top.map((n) => n.y)) : 0 }
      }
      const id = randomUUID()
      const node: ClaudeNode = {
        id, kind: 'claude', title: String(a.title || 'Handoff').slice(0, 80), cwd, prompt: a.text, sessionId: null, transcriptPath: null, after: [],
        ...at, ...size, parentId: null, projectId, ...(a.agent === 'codex' ? { agent: 'codex' as const } : {})
      }
      d.store.dispatch({ op: 'addNode', node })
      try {
        await d.startNode(id)
      } catch (e) {
        return { ok: false, reason: `The agent was added but couldn't start: ${(e as Error).message}` }
      }
      return { ok: true, nodeId: id }
    }
  }
}
