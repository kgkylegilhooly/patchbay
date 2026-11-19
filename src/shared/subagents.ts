/**
 * Subagent cards: what a Claude window's subagents are doing, drawn beside it while they run. They live only in
 * memory, never in canvas.json, undo history or `patchbay list`. See docs/plans/subagent-cards.md.
 */

export type SubagentStatus = 'running' | 'done' | 'failed'

export interface SubagentCard {
  /** Claude's agent id, the name of its transcript file. */
  id: string
  /** The canvas node whose session started it. */
  parentId: string
  agentType: string
  description: string
  status: SubagentStatus
  /** Why it failed, when it did and that is known. */
  failure?: string
  startedAt: number
  endedAt?: number
  tools: number
  /** The context size of its latest reply. Absent until it has replied. */
  tokens?: number
  /** 1 for an agent the window started, 2 for one a subagent started. */
  depth: number
}

/** One window's cards for its current turn. `ran` counts every subagent in the turn, shown or not. */
export interface SubagentGroup {
  ran: number
  cards: SubagentCard[]
}

export type SubagentSnapshot = Record<string, SubagentGroup>

/** Calls to main, on channels `pb:subagents:<method>`, and the push `pb:subagents:onCards`. */
export interface SubagentBridge {
  get(): Promise<SubagentSnapshot>
  transcript(nodeId: string, agentId: string): Promise<{ ok: true; text: string } | { ok: false; reason: string }>
  onCards(cb: (snapshot: SubagentSnapshot) => void): () => void
}

/** How long a finished card stays, and the part of that it spends fading. */
export const LINGER_MS = 30_000
export const FADE_MS = 5_000
/** Slots beside one window. With more cards than this, the last slot says how many more there are. */
export const CARD_CAP = 8

export const AGENT_ID = /^[A-Za-z0-9_-]{1,80}$/

export interface ShownCard {
  card: SubagentCard
  fading: boolean
}

/** What to draw for one window now: cards still running or recently finished, newest last, within the cap. */
export function visibleCards(cards: SubagentCard[], now: number, cap = CARD_CAP): { shown: ShownCard[]; more: number } {
  const live = cards
    .filter((c) => c.status === 'running' || (c.endedAt ?? now) + LINGER_MS > now)
    // Running ones first, so a burst of finished ones can't push a running agent behind "+N more".
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || a.startedAt - b.startedAt)
  const room = live.length > cap ? cap - 1 : cap
  return {
    shown: live.slice(0, room).map((card) => ({ card, fading: card.status !== 'running' && (card.endedAt ?? now) + LINGER_MS - FADE_MS <= now })),
    more: live.length - Math.min(live.length, room)
  }
}

/** "12s", "3m 05s", "1h 02m". */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

/** "88.5k tokens", with "~" while the number can still change. */
export function tokenLabel(card: SubagentCard): string | null {
  if (card.tokens === undefined) return null
  const n = card.tokens >= 1000 ? `${(card.tokens / 1000).toFixed(card.tokens >= 100_000 ? 0 : 1)}k` : String(card.tokens)
  return `${card.status === 'running' ? '~' : ''}${n} tokens`
}
