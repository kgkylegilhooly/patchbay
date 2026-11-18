import type { HandoffDraft, HandoffSource, IndexStats, SearchQuery, SearchResult } from '../core/search/types'
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
  /** Forgets the index and reads every source again. Sources are only read. */
  rebuild(): Promise<{ ok: true; stats: IndexStats } | SearchRefusal>
  prepareHandoff(source: HandoffSource): Promise<{ ok: true; draft: HandoffDraft } | SearchRefusal>
  startHandoff(a: StartHandoff): Promise<{ ok: true; nodeId: string } | SearchRefusal>
}
