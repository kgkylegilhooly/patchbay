import type { HandoffDraft, HandoffSource, IndexStats, SearchQuery, SearchResult, SourceWindow } from '../core/search/types'
import type { AgentKind } from './model'

export type SearchRefusal = { ok: false; reason: string }

export interface StartHandoff {
  /** The edited handoff, as the next agent's first prompt. */
  text: string
  agent: AgentKind
  cwd: string
  title: string
  projectId?: string
  /** The window it continues from, to place the new one beside it. */
  besideNodeId?: string
}

/**
 * The search drawer's and handoff editor's calls to main, as window.patchbaySearch. Each is one request on the channel
 * `pb:search:<method>`, served in src/main/search/ipc.ts. Only the person's window can call these: no agent verb reaches
 * search.
 */
export interface SearchBridge {
  search(query: SearchQuery): Promise<{ ok: true; result: SearchResult } | SearchRefusal>
  stats(): Promise<{ ok: true; stats: IndexStats } | SearchRefusal>
  /**
   * A result's source, from the index: the message at `around` (a hit's `entry`) and up to `before` and `after`
   * messages either side. Answered by the search worker, so a large transcript is never read on the main thread.
   */
  readSource(key: string, around: number, before?: number, after?: number): Promise<{ ok: true; window: SourceWindow } | SearchRefusal>
  /** Forgets the index and reads every source again. Sources are only read. */
  rebuild(): Promise<{ ok: true; stats: IndexStats } | SearchRefusal>
  prepareHandoff(source: HandoffSource): Promise<{ ok: true; draft: HandoffDraft } | SearchRefusal>
  startHandoff(a: StartHandoff): Promise<{ ok: true; nodeId: string } | SearchRefusal>
}
